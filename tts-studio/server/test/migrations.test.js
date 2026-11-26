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
  versions: ['details_json', 'render_kept'],
  spend: ['id', 'profile_id', 'generation_id', 'version_n', 'created_at', 'cost_usd', 'host_usd', 'settled', 'step', 'provider'],
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
  // The money is all in spend: the old places for it are gone.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'cost_ledger'").get().n, 0);
  for (const c of ['cost_usd', 'host_usd']) assert.ok(!columns(db, 'versions').includes(c), `versions no longer has ${c}`);
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
  // The ledger row and the version's cost are now spend rows: the first belongs to no lesson, the second to old-1's version 1.
  assert.deepEqual(store.db.prepare('SELECT profile_id, generation_id, version_n, created_at, cost_usd, host_usd FROM spend ORDER BY created_at').all(), [
    { profile_id: 'boss', generation_id: null, version_n: null, created_at: 10, cost_usd: 1.25, host_usd: 0 },
    { profile_id: '', generation_id: 'old-1', version_n: 1, created_at: 20, cost_usd: 0.5, host_usd: 0 },
  ]);
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
  // What an ownerless lesson cost goes with it to the Owner (a spend row for no lesson was nobody's, and stays so).
  assert.equal(store.db.prepare("SELECT profile_id FROM spend WHERE generation_id = 'old-1'").get().profile_id, 'boss');
  assert.equal(store.db.prepare('SELECT profile_id FROM spend WHERE generation_id IS NULL').get().profile_id, 'boss');
  store.close();
});

/** The oldest library plus every column the app had added by the day before the spend table, with money in all four old places. */
function makeLibraryWithMoney(dir, { monthStart, lastMonth }) {
  makeOldestLibrary(dir);
  const db = new Database(file(dir));
  db.exec(`
    ALTER TABLE generations ADD COLUMN kind TEXT NOT NULL DEFAULT 'audio';
    ALTER TABLE generations ADD COLUMN stage TEXT;
    ALTER TABLE generations ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE generations ADD COLUMN built_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE generations ADD COLUMN profile_id TEXT NOT NULL DEFAULT '';
    ALTER TABLE versions ADD COLUMN details_json TEXT;
    ALTER TABLE versions ADD COLUMN host_usd REAL;
    ALTER TABLE cost_ledger ADD COLUMN host_usd REAL;
    ALTER TABLE profiles ADD COLUMN host_cap_usd REAL;
    UPDATE generations SET profile_id = 'boss';
    INSERT INTO profiles (id, name, avatar_json, created_at) VALUES ('kid', 'Kid', '{"color":"#000","glyph":"K"}', 6);
  `);
  const lesson = (id, profile, version, createdAt, lessonFields) => db.prepare(`
    INSERT INTO generations (id, profile_id, kind, title, text, text_hash, config_hash, char_count, word_count, voice_id, model_id, settings_json, status, version, created_at)
    VALUES (?, ?, 'video', ?, 'x', ?, ?, 1, 1, 'af_heart', 'm', ?, 'error', ?, ?)`)
    .run(id, profile, id, id, id, JSON.stringify({ project: id, scenes: [], lesson: { topic: 't', ...lessonFields } }), version, createdAt);
  const version_ = db.prepare('INSERT INTO versions (generation_id, n, source, created_at, cost_usd, host_usd) VALUES (?, ?, ?, ?, ?, ?)');
  const ledger = db.prepare('INSERT INTO cost_ledger (profile_id, created_at, cost_usd, host_usd) VALUES (?, ?, ?, ?)');
  const m = monthStart;

  // Written and revised (last month) and then edited, with a failed revision since. Its waiting figures are in version 1's cost already.
  lesson('les-written', 'boss', 3, m + 1, { costUsd: 2, failedUsd: 0.4, failedHostUsd: 0.1, scriptCostUsd: 0.75, scriptHostUsd: 0.5 });
  version_.run('les-written', 1, 'written', m + 10, 1.0, 0.6);
  version_.run('les-written', 2, 'revised', lastMonth, 0.5, 0);
  version_.run('les-written', 3, 'edited', m + 11, null, null);
  // An outline and a narration waiting for approval, and no version: both count until one holds them.
  lesson('les-waiting', 'boss', 0, m + 2, { outlineCostUsd: 0.25, outlineHostUsd: 0.25, scriptCostUsd: 0.75, scriptHostUsd: 0.5 });
  // A failed attempt this month, and one from a lesson made last month.
  lesson('les-failed', 'boss', 0, m + 3, { failedUsd: 2, failedHostUsd: 1 });
  lesson('les-oldfail', 'boss', 0, lastMonth, { failedUsd: 2, failedHostUsd: 1 });
  // Somebody else's.
  lesson('kid-les', 'kid', 1, m + 4, {});
  version_.run('kid-les', 1, 'written', m + 5, 0.7, 0.7);
  // Deleted lessons' costs: one with no host figure (from before it was kept), one this month with, one last month.
  ledger.run('boss', m + 30, 1.25, null);
  ledger.run('boss', m + 40, 3, 2);
  ledger.run('boss', lastMonth, 9, 9);
  ledger.run('kid', m + 50, 0.3, 0.3);
  db.close();
}

test('money from every old place becomes spend rows, and the month and host totals come out as they did', () => {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const lastMonth = monthStart - 3 * 24 * 3600 * 1000;
  const dir = folder();
  makeLibraryWithMoney(dir, { monthStart, lastMonth });
  const store = createStore(dir);
  createProfiles({ db: store.db, dataDir: dir });
  const cents = (n) => Math.round(n * 100) / 100;

  // What the old stats() gave Boss, by hand. From versions made this month: les-written v1 1.00 (host 0.60). From deleted
  // lessons this month: 1.25 + 3.00 (host 2.00). Not counted: v2 and the 9.00 are last month's, v3 and old-1's version are
  // out of the month. Pending: les-written's failed attempt 0.40 (host 0.10; its waiting 0.75 is in version 1 and not
  // counted again), les-waiting's outline and narration 0.25 + 0.75 (host 0.25 + 0.50), les-failed 2.00 (host 1.00),
  // and les-oldfail 2.00 (host 1.00), which the old total counted in whatever month it was asked.
  //   cost  1.00 + 4.25 + 0.40 + 1.00 + 2.00 + 2.00 = 10.65     host  0.60 + 2.00 + 0.10 + 0.75 + 1.00 + 1.00 = 5.45
  // The one deliberate difference: les-oldfail is dated to its lesson (last month), so it is no longer counted this month.
  const month = store.stats('boss');
  assert.equal(month.costThisMonthUsd, cents(10.65 - 2), 'everything but les-oldfail, which is now last month’s');
  assert.equal(month.hostSpentThisMonthUsd, cents(5.45 - 1));
  assert.equal(store.db.prepare("SELECT created_at FROM spend WHERE generation_id = 'les-oldfail'").get().created_at, lastMonth);
  // A retry of les-failed leaves out its failed attempt only (old: 10.65 - 2.00), les-written's leaves out its 0.40.
  assert.equal(store.stats('boss', { excludeId: 'les-failed' }).costThisMonthUsd, cents(10.65 - 2 - 2));
  assert.equal(store.stats('boss', { excludeId: 'les-failed' }).hostSpentThisMonthUsd, cents(5.45 - 1 - 1));
  assert.equal(store.stats('boss', { excludeId: 'les-written' }).costThisMonthUsd, cents(10.65 - 2 - 0.4));
  assert.equal(store.stats('boss', { excludeId: 'les-waiting' }).costThisMonthUsd, month.costThisMonthUsd, 'a waiting phase is not a failed attempt');
  // The kid's is only the kid's: v1 0.70 and the ledger's 0.30.
  assert.deepEqual([store.stats('kid').costThisMonthUsd, store.stats('kid').hostSpentThisMonthUsd], [1, 1]);

  // Where each lesson's money went. Failed attempts are open (a retry continues from them), waiting phases are settled.
  assert.deepEqual(store.spend.open('les-failed'), { usd: 2, host: 1 });
  assert.deepEqual(store.spend.open('les-waiting'), { usd: 0, host: 0 });
  assert.deepEqual(store.spend.waiting('les-waiting'), { usd: 1, host: 0.75 });
  assert.deepEqual(store.spend.open('les-written'), { usd: 0.4, host: 0.1 });
  assert.equal(store.spend.waiting('les-written').usd, 0.4, 'version 1 already holds the narration');
  assert.deepEqual([...store.spend.byVersion('les-written')], [[1, 1], [2, 0.5]], 'the edit has no figure');
  // As the API shows it: the lesson's cost is all its rows, however old the figure kept on its settings.
  assert.equal(store.get('les-written').settings.lesson.costUsd, 1.9);
  assert.equal(store.get('les-waiting').settings.lesson.costUsd, 1);
  assert.equal(store.get('kid-les').settings.lesson.costUsd, 0.7);
  // The figures kept on lessons are gone from their settings.
  for (const { settings_json: json } of store.db.prepare('SELECT settings_json FROM generations').all()) {
    const l = JSON.parse(json).lesson || {};
    for (const k of ['costUsd', 'failedUsd', 'failedHostUsd', 'scriptCostUsd', 'scriptHostUsd', 'outlineCostUsd', 'outlineHostUsd']) assert.ok(!(k in l), k);
  }
  assert.equal(JSON.parse(store.getRaw('les-written').settings_json).lesson.topic, 't', 'and nothing else was changed');
  // Versions with a figure: les-written's v1 and v2 (the edit has none), old-1's and the kid's. Ledger: the oldest library's
  // row and the four above. Then the three failed attempts and the one waiting phase.
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM spend').get().n, 4 + 5 + 3 + 1);
  assert.equal(version(store.db), LATEST_VERSION);
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
