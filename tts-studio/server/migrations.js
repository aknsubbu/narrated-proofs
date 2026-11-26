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
  // Append new steps here.
];

export const LATEST_VERSION = STEPS.length;

const versionOf = (db) => db.pragma('user_version', { simple: true });

/** Bring the database to the latest version. Safe to call on every start, and from two processes at once. */
export function migrate(db) {
  const start = versionOf(db);
  if (start === LATEST_VERSION) return;
  // A newer app wrote this file. Running older code on it could quietly damage what it added.
  if (start > LATEST_VERSION) {
    throw new Error(`This library was made by a newer version of the app (database version ${start}, this app knows ${LATEST_VERSION}). Update the app to open it.`);
  }
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
