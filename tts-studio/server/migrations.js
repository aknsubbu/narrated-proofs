import fs from 'node:fs';
import path from 'node:path';

/**
 * How studio.db gets its shape. The library, the profiles and the settings all share this one
 * file, and SQLite keeps a single version number per file (PRAGMA user_version), so every change
 * to any table goes in the one ordered list at the bottom of this file. Nothing else alters tables.
 */

const LIBRARY_SCHEMA = `
CREATE TABLE IF NOT EXISTS generations (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  title           TEXT NOT NULL,
  source_name     TEXT,
  text            TEXT NOT NULL,
  text_hash       TEXT NOT NULL,
  config_hash     TEXT NOT NULL,
  char_count      INTEGER NOT NULL,
  word_count      INTEGER NOT NULL,
  voice_id        TEXT NOT NULL,
  voice_name      TEXT,
  model_id        TEXT NOT NULL,
  settings_json   TEXT NOT NULL,
  status          TEXT NOT NULL,
  progress_done   INTEGER NOT NULL DEFAULT 0,
  progress_total  INTEGER NOT NULL DEFAULT 0,
  error           TEXT,
  audio_bytes     INTEGER,
  duration_sec    REAL,
  favorite        INTEGER NOT NULL DEFAULT 0,
  tags            TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  finished_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gen_created ON generations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gen_config ON generations(config_hash);
CREATE INDEX IF NOT EXISTS idx_gen_text ON generations(text_hash);
CREATE INDEX IF NOT EXISTS idx_gen_status ON generations(status);

CREATE VIRTUAL TABLE IF NOT EXISTS gen_fts USING fts5(
  title, text, tags,
  content='generations', content_rowid='seq',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS gen_ai AFTER INSERT ON generations BEGIN
  INSERT INTO gen_fts(rowid, title, text, tags) VALUES (new.seq, new.title, new.text, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS gen_ad AFTER DELETE ON generations BEGIN
  INSERT INTO gen_fts(gen_fts, rowid, title, text, tags) VALUES ('delete', old.seq, old.title, old.text, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS gen_au AFTER UPDATE OF title, text, tags ON generations BEGIN
  INSERT INTO gen_fts(gen_fts, rowid, title, text, tags) VALUES ('delete', old.seq, old.title, old.text, old.tags);
  INSERT INTO gen_fts(rowid, title, text, tags) VALUES (new.seq, new.title, new.text, new.tags);
END;

-- What deleted lessons cost, kept so deleting a lesson (or a profile) cannot reset the month's cap.
CREATE TABLE IF NOT EXISTS cost_ledger (
  profile_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  cost_usd    REAL NOT NULL
);

-- Each version of a lesson: what made it, what it cost, and whether it was built.
-- Its files are a snapshot in the project's versions/NNN/ folder.
CREATE TABLE IF NOT EXISTS versions (
  generation_id   TEXT NOT NULL,
  n               INTEGER NOT NULL,
  source          TEXT NOT NULL,
  note            TEXT,
  created_at      INTEGER NOT NULL,
  cost_usd        REAL,
  usage_json      TEXT,
  check_ok        INTEGER,
  warnings        INTEGER,
  built_at        INTEGER,
  quality         TEXT,
  duration_sec    REAL,
  video_bytes     INTEGER,
  render_kept     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (generation_id, n)
);
`;

const PROFILES_SCHEMA = `
CREATE TABLE IF NOT EXISTS profiles (
  id                   TEXT PRIMARY KEY,
  name                 TEXT NOT NULL,
  avatar_json          TEXT NOT NULL,
  pin_hash             TEXT,
  pin_salt             TEXT,
  is_owner             INTEGER NOT NULL DEFAULT 0,
  can_use_host_claude  INTEGER NOT NULL DEFAULT 0,
  can_use_host_keys    INTEGER NOT NULL DEFAULT 0,
  require_pin_to_add   INTEGER NOT NULL DEFAULT 0,
  host_cap_usd         REAL,
  created_at           INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_profile ON sessions(profile_id);
-- What lets Claude (through the MCP connector) act as one profile. Only a hash is kept.
CREATE TABLE IF NOT EXISTS connector_tokens (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  label       TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tokens_profile ON connector_tokens(profile_id);
CREATE TABLE IF NOT EXISTS pin_attempts (
  profile_id    TEXT PRIMARY KEY,
  failures      INTEGER NOT NULL DEFAULT 0,
  locked_until  INTEGER NOT NULL DEFAULT 0
);
`;

const SETTINGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  profile_id  TEXT NOT NULL DEFAULT '',
  key         TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT NOT NULL,
  PRIMARY KEY (profile_id, key)
);
CREATE TABLE IF NOT EXISTS settings_history (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id TEXT NOT NULL DEFAULT '',
  key       TEXT NOT NULL,
  old_json  TEXT,
  new_json  TEXT,
  by        TEXT NOT NULL,
  at        INTEGER NOT NULL,
  undone    INTEGER NOT NULL DEFAULT 0,
  undo_of   INTEGER
);
`;

// Columns added to generations after the first release. Only the baseline step reads this list.
// kind is 'audio' or 'video'. stage says what a lesson is doing while Claude writes it.
const LIBRARY_COLUMNS = [
  ['kind', "ALTER TABLE generations ADD COLUMN kind TEXT NOT NULL DEFAULT 'audio'"],
  ['stage', 'ALTER TABLE generations ADD COLUMN stage TEXT'],
  // The version a lesson is on, and the one its library video shows. A lesson being revised or
  // rebuilt keeps playing the built one.
  ['version', 'ALTER TABLE generations ADD COLUMN version INTEGER NOT NULL DEFAULT 0'],
  ['built_version', 'ALTER TABLE generations ADD COLUMN built_version INTEGER NOT NULL DEFAULT 0'],
  // Whose lesson it is. Rows from before profiles are '' until the Owner profile exists and takes them.
  ['profile_id', "ALTER TABLE generations ADD COLUMN profile_id TEXT NOT NULL DEFAULT ''"],
];

const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const hasColumn = (db, table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
const addColumn = (db, table, column, definition) => {
  if (!hasColumn(db, table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
};

/**
 * Everything up to the day versioned migrations began. Libraries made at any earlier point all
 * report version 0, and each has a different set of columns, so this step looks at what is there
 * and adds what is missing, as the app did on every start before. It is safe to run on an empty
 * file too, which is how a new library gets its tables. Its checks are frozen: never extend them.
 */
function baseline(db) {
  db.exec(LIBRARY_SCHEMA);
  for (const [column, sql] of LIBRARY_COLUMNS) if (!hasColumn(db, 'generations', column)) db.exec(sql);
  db.exec('CREATE INDEX IF NOT EXISTS idx_gen_profile ON generations(profile_id, created_at DESC)');
  // What a revision asked for and changed, on versions made before it existed too.
  addColumn(db, 'versions', 'details_json', 'TEXT');
  // How much of a cost the host's own Claude sign-in or keys paid, which the Owner may limit per profile.
  addColumn(db, 'versions', 'host_usd', 'REAL');
  addColumn(db, 'cost_ledger', 'host_usd', 'REAL');

  db.exec(PROFILES_SCHEMA);
  // What the Owner lets a profile spend a month with the host's Claude sign-in and keys: null is no limit.
  addColumn(db, 'profiles', 'host_cap_usd', 'REAL');

  // Settings from before profiles had no owner. Their table is rebuilt with the owner column; the
  // rows keep the empty owner here and createSettings hands them to the Owner, who exists only later.
  const legacySettings = hasTable(db, 'settings') && !hasColumn(db, 'settings', 'profile_id');
  if (legacySettings) db.exec('ALTER TABLE settings RENAME TO settings_legacy');
  db.exec(SETTINGS_SCHEMA);
  addColumn(db, 'settings_history', 'profile_id', "TEXT NOT NULL DEFAULT ''");
  if (legacySettings) {
    db.exec(`INSERT INTO settings (profile_id, key, value_json, updated_at, updated_by)
             SELECT '', key, value_json, updated_at, updated_by FROM settings_legacy`);
    db.exec('DROP TABLE settings_legacy');
  }
}

// What an outline, a narration or a failed attempt had cost, kept on a lesson's settings before there was a spend table.
const LEGACY_LESSON_FIELDS = ['outlineCostUsd', 'outlineHostUsd', 'scriptCostUsd', 'scriptHostUsd', 'failedUsd', 'failedHostUsd', 'costUsd'];

/**
 * Money used to be kept in four places: each version's cost, the cost_ledger of deleted lessons, figures on a
 * lesson's settings (a waiting outline or narration, and what a failed attempt spent), and a spent.json in the
 * project folder. All of it becomes rows of one table, `spend`: one row for each request the writer paid for.
 *
 * Every figure is carried over so the month's total and the host's total come out exactly as they did, with one
 * deliberate difference: what a lesson had spent that no version held yet (the "pending" amounts, which the old
 * month total counted in whatever month it was asked) is dated to the day the lesson was made, as a version's cost is
 * dated to the day the version was. A pending amount can no longer drift into a later month.
 *
 * spent.json is not read here, because a migration only knows the database. It held nothing the settings did not,
 * except for a lesson the server stopped under; lessons.importLegacySpend() reads those at the next start.
 */
function spendTable(db) {
  db.exec(`
    -- One row for each request the writer paid for (a free one is a row of nothing, so a version can say it cost $0).
    -- version_n is empty until the lesson makes a version, and that version then takes the lesson's empty rows.
    -- settled is 1 once a finished job has counted the row in its result: the next job's own budget then leaves it out
    -- (it carries only the failed attempts it continues), while the month's total counts every row once.
    -- A deleted lesson's rows stay, with its id, so deleting never lowers the month's spend.
    CREATE TABLE spend (
      id             INTEGER PRIMARY KEY,
      profile_id     TEXT NOT NULL,
      generation_id  TEXT,
      version_n      INTEGER,
      created_at     INTEGER NOT NULL,
      cost_usd       REAL NOT NULL,
      host_usd       REAL NOT NULL DEFAULT 0,
      settled        INTEGER NOT NULL DEFAULT 0,
      step           TEXT,
      provider       TEXT
    );
    CREATE INDEX idx_spend_profile ON spend(profile_id, created_at);
    CREATE INDEX idx_spend_generation ON spend(generation_id, version_n);
  `);

  // What each version cost, dated to the version. A version with no figure (an edit, a restore) has no row.
  db.exec(`
    INSERT INTO spend (profile_id, generation_id, version_n, created_at, cost_usd, host_usd, settled, step)
    SELECT g.profile_id, v.generation_id, v.n, v.created_at, COALESCE(v.cost_usd, 0), COALESCE(v.host_usd, 0), 1, 'version'
    FROM versions v JOIN generations g ON g.id = v.generation_id
    WHERE v.cost_usd IS NOT NULL OR v.host_usd IS NOT NULL`);

  // What deleted lessons cost: no lesson any more.
  db.exec(`
    INSERT INTO spend (profile_id, generation_id, version_n, created_at, cost_usd, host_usd, settled, step)
    SELECT profile_id, NULL, NULL, created_at, cost_usd, COALESCE(host_usd, 0), 1, 'deleted lesson' FROM cost_ledger`);

  // What a lesson has spent that no version holds yet: a failed or cancelled attempt always, and an outline or a
  // narration waiting to be approved while the lesson has no version (a version's cost already includes them).
  const add = db.prepare(`INSERT INTO spend (profile_id, generation_id, version_n, created_at, cost_usd, host_usd, settled, step)
                          VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`);
  const save = db.prepare('UPDATE generations SET settings_json = ? WHERE id = ?');
  const num = (n) => Number(n) || 0;
  for (const g of db.prepare("SELECT id, profile_id, version, created_at, settings_json FROM generations WHERE settings_json LIKE '%\"lesson\"%'").all()) {
    let settings;
    try {
      settings = JSON.parse(g.settings_json);
    } catch {
      continue; // nothing readable to carry over
    }
    const l = settings?.lesson;
    if (!l || typeof l !== 'object') continue;
    const [failed, failedHost] = [num(l.failedUsd), num(l.failedHostUsd)];
    if (failed > 0 || failedHost > 0) add.run(g.profile_id, g.id, g.created_at, failed, failedHost, 0, 'failed attempt');
    if (!g.version) {
      const waiting = num(l.scriptCostUsd) + num(l.outlineCostUsd);
      const waitingHost = num(l.scriptHostUsd) + num(l.outlineHostUsd);
      if (waiting > 0 || waitingHost > 0) add.run(g.profile_id, g.id, g.created_at, waiting, waitingHost, 1, 'waiting phase');
    }
    // The figures are rows now. A lesson's cost is read from them, so a copy left on the lesson could only go stale.
    if (LEGACY_LESSON_FIELDS.some((k) => k in l)) {
      for (const k of LEGACY_LESSON_FIELDS) delete l[k];
      save.run(JSON.stringify(settings), g.id);
    }
  }

  db.exec('DROP TABLE cost_ledger');
  db.exec('ALTER TABLE versions DROP COLUMN cost_usd');
  db.exec('ALTER TABLE versions DROP COLUMN host_usd');
}

/**
 * The ordered list of changes. Entry n takes the database from version n to n + 1, and
 * PRAGMA user_version is how many entries have run.
 *
 * To change the database, append a function at the end that makes the change, for example
 *   (db) => db.exec('ALTER TABLE generations ADD COLUMN note TEXT'),
 * and change nothing else. Never edit or reorder an entry that has shipped: other people's
 * databases have already run it, so a changed entry would leave them different from new ones.
 * That includes the schema text above, which is only the starting point the baseline builds on.
 * Each entry runs once, in a transaction with its version bump, so a step that throws changes nothing.
 */
const STEPS = [
  baseline,
  spendTable,
  // Append new steps here.
];

export const LATEST_VERSION = STEPS.length;

const versionOf = (db) => db.pragma('user_version', { simple: true });

/** Bring the database to the latest version. Safe to call on every start, and from two processes at once. */
/**
 * Copy a library that holds anything into data/backups before a migration changes it, so a step that turns out
 * wrong (they drop tables and columns once their contents are carried over) can be undone by putting the copy
 * back. A new, empty library has nothing to lose and gets none. VACUUM INTO writes a consistent copy, including
 * what is still in the write-ahead log. If the copy cannot be made the migration does not run: the app stops with
 * the reason rather than change a library it could not save first. Returns the copy's path, or null.
 */
export function backUp(db, version, now = new Date()) {
  const file = db.name;
  if (!file || file === ':memory:' || db.memory) return null;
  const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().n;
  if (!tables) return null;
  const dir = path.join(path.dirname(file), 'backups');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const copy = path.join(dir, `${path.basename(file, '.db')}-v${version}-${stamp}.db`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(copy)) db.prepare('VACUUM INTO ?').run(copy);
  } catch (e) {
    throw new Error(`Could not back up the library to ${copy} before updating it (${e.message}). Free some disk space, or check the data folder can be written, and start again.`);
  }
  console.log(`  Library backed up to ${copy} before updating it (database version ${version} to ${LATEST_VERSION}).`);
  return copy;
}

export function migrate(db) {
  const start = versionOf(db);
  if (start === LATEST_VERSION) return;
  // A newer app wrote this file. Running older code on it could quietly damage what it added.
  if (start > LATEST_VERSION) {
    throw new Error(`This library was made by a newer version of the app (database version ${start}, this app knows ${LATEST_VERSION}). Update the app to open it.`);
  }
  backUp(db, start);
  for (let n = start; n < STEPS.length; n += 1) {
    // immediate() takes the write lock first, so a second process starting at the same moment waits,
    // then sees the step done and skips it.
    db.transaction(() => {
      if (versionOf(db) > n) return;
      STEPS[n](db);
      db.pragma(`user_version = ${n + 1}`);
    }).immediate();
  }
}
