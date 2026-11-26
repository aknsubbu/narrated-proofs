import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../db.js';
import { createProfiles } from '../profiles.js';
import { createSettings } from '../settings.js';
import { LATEST_VERSION, migrate } from '../migrations.js';

let root;
const folder = () => fs.mkdtempSync(path.join(root, 'lib-'));
const file = (dir) => path.join(dir, 'studio.db');

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'np-migrations-'));
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
const version = (db) => db.pragma('user_version', { simple: true });
const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') ORDER BY name").all().map((r) => r.name);

// The columns every table has today. A library at any version must end up with all of them.
const EXPECTED = {
  generations: ['kind', 'stage', 'version', 'built_version', 'profile_id'],
  versions: ['details_json', 'host_usd', 'render_kept'],
  cost_ledger: ['host_usd'],
  profiles: ['host_cap_usd', 'require_pin_to_add'],
  settings: ['profile_id', 'key'],
  settings_history: ['profile_id', 'seq'],
};
const assertCurrentShape = (db) => {
  for (const [table, wanted] of Object.entries(EXPECTED)) {
    const have = columns(db, table);
    for (const c of wanted) assert.ok(have.includes(c), `${table} has ${c}`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'settings_legacy'").get().n, 0);
};

/** The very first library: no kind, stage, version or owner columns, no ledger or versions table. */
function makeOldestLibrary(dir) {
  const db = new Database(file(dir));
  db.exec(`
    CREATE TABLE generations (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, title TEXT NOT NULL, source_name TEXT,
      text TEXT NOT NULL, text_hash TEXT NOT NULL, config_hash TEXT NOT NULL, char_count INTEGER NOT NULL,
      word_count INTEGER NOT NULL, voice_id TEXT NOT NULL, voice_name TEXT, model_id TEXT NOT NULL,
      settings_json TEXT NOT NULL, status TEXT NOT NULL, progress_done INTEGER NOT NULL DEFAULT 0,
      progress_total INTEGER NOT NULL DEFAULT 0, error TEXT, audio_bytes INTEGER, duration_sec REAL,
      favorite INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, finished_at INTEGER
    );
    CREATE VIRTUAL TABLE gen_fts USING fts5(title, text, tags, content='generations', content_rowid='seq', tokenize='porter unicode61');
    CREATE TRIGGER gen_ai AFTER INSERT ON generations BEGIN
      INSERT INTO gen_fts(rowid, title, text, tags) VALUES (new.seq, new.title, new.text, new.tags);
    END;
    INSERT INTO generations (id, title, text, text_hash, config_hash, char_count, word_count, voice_id, model_id, settings_json, status, created_at)
      VALUES ('old-1', 'Eigenvalues', 'matrices stretch space', 'h1', 'c1', 22, 3, 'af_heart', 'kokoro', '{}', 'done', 1000),
             ('old-2', 'Gradients', 'slopes in many dimensions', 'h2', 'c2', 25, 4, 'af_heart', 'kokoro', '{}', 'done', 2000);

    CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
    CREATE TABLE settings_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, old_json TEXT, new_json TEXT, by TEXT NOT NULL, at INTEGER NOT NULL, undone INTEGER NOT NULL DEFAULT 0, undo_of INTEGER);
    INSERT INTO settings VALUES ('lesson.defaults', '{"minutes":7}', 1, 'you');
    INSERT INTO settings_history (key, old_json, new_json, by, at) VALUES ('lesson.defaults', NULL, '{"minutes":7}', 'you', 1);

    CREATE TABLE profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar_json TEXT NOT NULL, pin_hash TEXT, pin_salt TEXT,
      is_owner INTEGER NOT NULL DEFAULT 0, can_use_host_claude INTEGER NOT NULL DEFAULT 0,
      can_use_host_keys INTEGER NOT NULL DEFAULT 0, require_pin_to_add INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    INSERT INTO profiles (id, name, avatar_json, is_owner, created_at) VALUES ('boss', 'Boss', '{"color":"#c2410c","glyph":"B"}', 1, 5);

    CREATE TABLE cost_ledger (profile_id TEXT NOT NULL, created_at INTEGER NOT NULL, cost_usd REAL NOT NULL);
    INSERT INTO cost_ledger VALUES ('boss', 10, 1.25);
    CREATE TABLE versions (
      generation_id TEXT NOT NULL, n INTEGER NOT NULL, source TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL,
      cost_usd REAL, usage_json TEXT, check_ok INTEGER, warnings INTEGER, built_at INTEGER, quality TEXT,
      duration_sec REAL, video_bytes INTEGER, render_kept INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (generation_id, n)
    );
    INSERT INTO versions (generation_id, n, source, created_at, cost_usd) VALUES ('old-1', 1, 'written', 20, 0.5);
  `);
  assert.equal(version(db), 0, 'a library from before versioned migrations reports version 0');
  db.close();
}

test('a new library ends at the latest version with every table and column', () => {
  const dir = folder();
  const store = createStore(dir);
  assert.equal(version(store.db), LATEST_VERSION);
  assertCurrentShape(store.db);
  store.close();
});

test('the oldest library upgrades on first open and keeps its rows', () => {
  const dir = folder();
  makeOldestLibrary(dir);
  const store = createStore(dir);
  assert.equal(version(store.db), LATEST_VERSION);
  assertCurrentShape(store.db);

  const rows = store.db.prepare('SELECT id, title, kind, version, built_version, profile_id, stage FROM generations ORDER BY seq').all();
  assert.deepEqual(rows, [
    { id: 'old-1', title: 'Eigenvalues', kind: 'audio', version: 0, built_version: 0, profile_id: '', stage: null },
    { id: 'old-2', title: 'Gradients', kind: 'audio', version: 0, built_version: 0, profile_id: '', stage: null },
  ]);
  assert.equal(store.db.prepare('SELECT cost_usd, host_usd FROM cost_ledger').get().cost_usd, 1.25);
  assert.equal(store.versions.get('old-1', 1).cost_usd, 0.5);
  assert.equal(store.versions.get('old-1', 1).details_json, null);
  // The search index still finds the old rows, and keeps indexing new ones, after the columns were added.
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM gen_fts WHERE gen_fts MATCH 'matrices'").get().n, 1);
  store.insert({
    id: 'new-1', profile_id: 'boss', kind: 'video', title: 'Fresh', source_name: null, text: 'fresh words', text_hash: 'h3', config_hash: 'c3', char_count: 11, word_count: 2,
    voice_id: 'af_heart', voice_name: null, model_id: 'm', settings_json: '{}', status: 'done', tags: '', created_at: 3000,
  });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM gen_fts WHERE gen_fts MATCH 'fresh'").get().n, 1);

  // The profile and settings modules take over what the old shapes held: the settings go to the Owner.
  const profiles = createProfiles({ db: store.db, dataDir: dir });
  assert.equal(profiles.owner().id, 'boss');
  assert.equal(profiles.get('boss').hostCapUsd, null);
  createSettings({ db: store.db, getConfig: () => ({}), secrets: {}, profiles });
  assert.equal(store.db.prepare("SELECT profile_id FROM settings WHERE key = 'lesson.defaults'").get().profile_id, 'boss');
  assert.equal(store.db.prepare('SELECT profile_id FROM settings_history').get().profile_id, 'boss');
  assert.equal(store.db.prepare("SELECT profile_id FROM generations WHERE id = 'old-1'").get().profile_id, 'boss', 'ownerless lessons are the Owner\'s');
  store.close();
});

test('opening a library twice is a no-op', () => {
  const dir = folder();
  makeOldestLibrary(dir);
  createStore(dir).close();
  const before = new Database(file(dir), { readonly: true });
  const shape = tables(before);
  const generations = before.prepare('SELECT * FROM generations ORDER BY seq').all();
  before.close();

  const again = createStore(dir);
  assert.equal(version(again.db), LATEST_VERSION);
  assert.deepEqual(tables(again.db), shape);
  assert.deepEqual(again.db.prepare('SELECT * FROM generations ORDER BY seq').all(), generations);
  again.close();
});

test('a library already at the latest version is not touched', () => {
  const dir = folder();
  createStore(dir).close();
  // If anything ran again it would put this column back (the baseline checks for it by name).
  const db = new Database(file(dir));
  db.exec('ALTER TABLE generations DROP COLUMN stage');
  assert.equal(version(db), LATEST_VERSION);
  migrate(db);
  assert.equal(version(db), LATEST_VERSION);
  assert.ok(!columns(db, 'generations').includes('stage'), 'no step ran');
  db.close();
});

test('a failing step changes nothing and leaves the version where it was', () => {
  const dir = folder();
  const db = new Database(file(dir));
  // Version 0 with an old settings table whose rename is blocked by a leftover table of the new name.
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL)');
  db.exec('CREATE TABLE settings_legacy (x)');
  assert.throws(() => migrate(db), /settings_legacy/);
  assert.equal(version(db), 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'generations'").get().n, 0, 'the tables made before the failure were rolled back');
  db.close();
});

test('a library made by a newer app is refused, not changed', () => {
  const dir = folder();
  const db = new Database(file(dir));
  db.pragma(`user_version = ${LATEST_VERSION + 1}`);
  db.close();
  assert.throws(() => createStore(dir), /newer version/);
  const peek = new Database(file(dir), { readonly: true });
  assert.equal(version(peek), LATEST_VERSION + 1);
  assert.equal(peek.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'generations'").get().n, 0);
  peek.close();
});
