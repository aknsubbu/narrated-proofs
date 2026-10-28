import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../db.js';
import { createRunner } from '../runner.js';
import { createApp } from '../app.js';
import { createCodeInfo } from '../version.js';

const engine = { start: async () => {}, stop() {}, info: () => ({ status: 'ready', error: null, device: 'test' }), catalog: () => ({ voices: [], languages: [], samples: {} }) };

test('the server is behind once the folder has another commit, checked at most every 10 seconds', () => {
  let commit = 'aaa';
  let t = 0;
  const code = createCodeInfo({ commitNow: () => commit, now: () => t });
  assert.equal(code.commit, 'aaa');
  assert.match(code.version, /^\d+\.\d+\.\d+$/);
  assert.equal(code.behind(), false);
  commit = 'bbb';
  t = 5_000;
  assert.equal(code.behind(), false); // checked a moment ago
  t = 20_000;
  assert.equal(code.behind(), true);

  const noGit = createCodeInfo({ commitNow: () => null });
  assert.equal(noGit.behind(), false); // a Docker image cannot tell
});

test('health says what code runs, and only a connector-started server says how to restart it', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-version-'));
  const store = createStore(dataDir);
  const getConfig = () => ({ defaultVoiceId: 'af_zed', lan: false });
  const health = async (code) => {
    const app = createApp({ getConfig, store, runner: createRunner({ store, engine }), engine, code });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      return await (await fetch(`http://127.0.0.1:${server.address().port}/api/health`)).json();
    } finally {
      server.close();
    }
  };
  try {
    const mine = await health(createCodeInfo({ commitNow: () => 'abc' }));
    assert.equal(mine.commit, 'abc');
    assert.equal(mine.behind, false);
    assert.ok(mine.startedAt);
    assert.equal(mine.restart, undefined); // started by hand: never restarted for you

    const started = await health(createCodeInfo({ commitNow: () => 'abc', startedBy: 'mcp' }));
    assert.deepEqual(started.restart, { pid: process.pid, busy: 0 });

    const bare = await health(null);
    assert.equal(bare.version, null);
    assert.equal(bare.behind, false);
  } finally {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
