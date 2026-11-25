import os from 'node:os';
import path from 'node:path';
import { loadConfig, ROOT } from './config.js';
import { createStore } from './db.js';
import { createEngine } from './kokoro.js';
import { createRunner } from './runner.js';
import { createVideoBuilder } from './video.js';
import { createLessons } from './lessons.js';
import { createVersions } from './versions.js';
import { createApp } from './app.js';
import { createAuthorJobs } from '../author/jobs.js';
import { createAuthor } from '../author/pipeline.js';
import { createSecrets } from './secrets.js';
import { createSettings } from './settings.js';
import { createProfiles } from './profiles.js';
import { mcpHandler } from '../mcp/http.js';
import { createCodeInfo } from './version.js';

const cfg = loadConfig();
const code = createCodeInfo({ startedBy: process.env.TTS_STARTED_BY === 'mcp' ? 'mcp' : null });
const store = createStore(cfg.dataDir);
const engine = createEngine({ getConfig: loadConfig });
const versions = createVersions({ store, getConfig: loadConfig });
// Provider keys: the macOS Keychain, else a private file in the data folder.
const secrets = createSecrets({ dataDir: cfg.dataDir, useKeychain: cfg.useKeychain });
const profiles = createProfiles({ db: store.db, dataDir: cfg.dataDir, getMax: () => loadConfig().maxProfiles });
const settings = createSettings({ db: store.db, getConfig: loadConfig, secrets, profiles });
await settings.migrateKeys(); // keys from before profiles go to the Owner
const runner = createRunner({ store, engine, video: createVideoBuilder({ getConfig: loadConfig }), versions });
// The lesson writer runs in this process, its jobs alongside the server's.
const jobs = createAuthorJobs({ getConfig: loadConfig, author: createAuthor({ getConfig: loadConfig, secrets }) });
const lessons = createLessons({ store, runner, getConfig: loadConfig, jobs, versions, settings });
const app = createApp({ getConfig: loadConfig, store, runner, engine, lessons, versions, settings, secrets, profiles, mcp: mcpHandler(), code, distDir: path.join(ROOT, 'dist') });

/** This machine's IPv4 addresses on the networks it is joined to. */
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

const server = app.listen(cfg.port, cfg.host, () => {
  // Only once the port is ours: a second copy that fails to start (the port is in use) must not mark the running
  // copy's jobs as interrupted, or take its waiting ones.
  const interrupted = store.markInterrupted();
  const waiting = store.resumeQueued();
  lessons.settleInterrupted(); // what the interrupted lessons had spent stays counted
  console.log(`\n  Narrated Proofs  http://localhost:${cfg.port}`);
  if (cfg.lan) {
    for (const a of lanAddresses()) console.log(`  On your network  http://${a}:${cfg.port}   (profiles keep libraries apart; trusted networks only)`);
  }
  console.log(`  Dev UI (vite)    http://localhost:5173   (when running npm run dev)`);
  console.log(`  Library data     ${cfg.dataDir}`);
  console.log(`  Lesson writer    who writes: Settings → Lesson writer`);
  console.log(`  MCP connector    http://localhost:${cfg.port}/mcp   (Settings → Connect Claude)`);
  console.log(`  Kokoro           loading the model…`);
  if (waiting.length) console.log(`  ${waiting.length} waiting job(s) from the last run were queued again.`);
  if (interrupted) console.log(`  ${interrupted} unfinished job(s) from the last run were marked for retry.`);
  console.log('');
  // Jobs that were only waiting their turn cost nothing, so they start again in the order they were made.
  for (const id of waiting) runner.enqueue(id);
  // Load the model now so the first script does not wait for it.
  engine.start().then(
    (info) => console.log(`  Kokoro           ready on ${info.device}, ${info.voices.length} voices\n`),
    (e) => console.log(`  Kokoro           NOT READY. ${e.message}\n`),
  );
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${cfg.port} is already in use. Set PORT=... in your .env or stop the other process.`);
  } else {
    console.error(e);
  }
  process.exit(1);
});

const shutdown = () => {
  engine.stop(); // otherwise the Python process outlives every restart
  runner.stop(); // and so would a video build
  lessons.stop();
  jobs.stop(); // and Claude, and the check it runs
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  engine.stop();
  runner.stop();
  jobs.stop();
});
