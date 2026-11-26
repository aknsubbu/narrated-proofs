import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../db.js';

let dir, store;

const row = (id, extra = {}, settings = {}) => ({
  id, profile_id: 'p1', kind: 'video', title: id, source_name: `video/projects/${id}`, text: 'x', text_hash: id, config_hash: id, char_count: 1, word_count: 1,
  voice_id: 'af_heart', voice_name: null, model_id: 'm', status: 'done', tags: '', created_at: Date.now(),
  settings_json: JSON.stringify({ project: id, quality: 'low', scenes: [], ...settings }), ...extra,
});
// The rows a lesson's requests left: removing it must never take them away.
const rowsOf = (id) => store.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS usd FROM spend WHERE generation_id = ?').get(id);

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-store-'));
  store = createStore(dir);
});
after(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('removing a lesson is all or nothing, and never gives back what it cost', () => {
  // It has a version that cost money, and an outline's cost not yet held by any version.
  store.insert(row('gone'));
  store.spend.add({ profileId: 'p1', generationId: 'gone', costUsd: 0.5, settled: true, step: 'write' });
  store.versions.insert({ generation_id: 'gone', n: 1, source: 'written', created_at: Date.now() }, { takesSpend: true });
  store.spend.add({ profileId: 'p1', generationId: 'gone', costUsd: 0.3, settled: true, step: 'outline' });
  const before = { spend: rowsOf('gone'), cost: store.stats('p1').costThisMonthUsd };
  assert.deepEqual([before.spend.n, before.spend.usd], [2, 0.8]);
  let heard = 0;
  store.events.on('change', () => { heard += 1; });

  // A failure at the very last step.
  store.db.exec("CREATE TEMP TRIGGER fail_delete BEFORE DELETE ON generations BEGIN SELECT RAISE(ABORT, 'boom'); END");
  assert.throws(() => store.remove('gone'), /boom/);
  assert.equal(store.versions.list('gone').length, 1, 'the versions are still there');
  assert.ok(store.getRaw('gone'), 'and so is the lesson');
  assert.deepEqual(rowsOf('gone'), before.spend, 'and what it cost');
  assert.equal(store.stats('p1').costThisMonthUsd, before.cost, 'so nothing is counted twice or lost');
  assert.equal(heard, 0, 'nobody was told it was removed');

  // Without the failure the same call goes through, and the cost stays counted.
  store.db.exec('DROP TRIGGER fail_delete');
  assert.equal(store.remove('gone'), 1);
  assert.equal(store.versions.list('gone').length, 0);
  assert.equal(store.getRaw('gone'), undefined);
  assert.deepEqual(rowsOf('gone'), before.spend, 'its spend rows stay, with its profile and dates');
  assert.equal(store.stats('p1').costThisMonthUsd, before.cost, 'deleting does not give the money back');
  assert.equal(heard, 1);
  store.events.removeAllListeners('change');
});

test('a restart queues the waiting jobs again, oldest first, and marks only the running ones for retry', () => {
  const now = Date.now();
  // Made out of order on purpose: the order they were made in is what is kept.
  store.insert(row('late', { status: 'queued', created_at: now + 20 }));
  store.insert(row('early', { status: 'queued', created_at: now + 10 }));
  store.insert(row('same-a', { status: 'queued', created_at: now + 30 }));
  store.insert(row('same-b', { status: 'queued', created_at: now + 30 }));
  store.insert(row('writing', { status: 'processing' }));
  store.insert(row('storyboard', { status: 'awaiting' }));
  store.insert(row('built', { status: 'done' }));
  store.update('early', { progress_done: 3, progress_total: 9 });

  assert.equal(store.inFlight(), 1, 'a waiting job is not interrupted by a restart');
  assert.equal(store.markInterrupted(), 1);
  const writing = store.get('writing');
  assert.equal(writing.status, 'error');
  assert.match(writing.error, /Interrupted by a server restart/);
  for (const id of ['late', 'early', 'same-a', 'same-b']) assert.equal(store.get(id).status, 'queued', `${id} was not marked as an error`);

  assert.deepEqual(store.resumeQueued(), ['early', 'late', 'same-a', 'same-b']);
  const early = store.get('early');
  assert.equal(early.status, 'queued');
  assert.equal(early.progressDone, 0);
  assert.equal(early.progressTotal, 0);
  assert.equal(store.get('storyboard').status, 'awaiting', 'a lesson waiting on the person is left as it is');
  assert.equal(store.get('built').status, 'done');
  assert.equal(store.markInterrupted(), 0, 'nothing is left to interrupt');
});

test('a status change the allowed moves do not name fails under the tests, and in use is logged and made', (t) => {
  store.insert(row('moving'));
  store.update('moving', { status: 'processing' });
  store.update('moving', { status: 'processing', stage: 'Building' }); // staying put is fine
  store.update('moving', { title: 'renamed' }); // no status, no check
  store.update('moving', { status: 'done' });
  assert.throws(() => store.update('moving', { status: 'error' }), /Item moving cannot move from done to error/);
  assert.equal(store.get('moving').status, 'done', 'a refused move changes nothing');

  // In use the store is lenient, so a case the table missed never leaves a lesson stuck.
  const lenientDir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-store-lenient-'));
  const lenient = createStore(lenientDir, { strictMoves: false });
  const warn = t.mock.method(console, 'warn', () => {});
  try {
    lenient.insert(row('loose'));
    lenient.update('loose', { status: 'error', error: 'x' });
    assert.equal(lenient.get('loose').status, 'error');
    assert.equal(warn.mock.callCount(), 1);
    assert.match(warn.mock.calls[0].arguments[0], /Item loose cannot move from done to error; made the change anyway/);
    lenient.update('loose', { status: 'queued' });
    assert.equal(warn.mock.callCount(), 1, 'an allowed move is not logged');
  } finally {
    lenient.close();
    fs.rmSync(lenientDir, { recursive: true, force: true });
  }
});
