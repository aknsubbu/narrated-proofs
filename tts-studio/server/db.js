import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { canMove } from './lesson-state.js';
import { migrate } from './migrations.js';
import { cleanText } from './text.js';

// Control characters wrap matches in search snippets. The client splits on them
// and renders <mark> elements, so no HTML is ever injected.
export const MARK_START = '\u0001';
export const MARK_END = '\u0002';

const UPDATABLE = new Set([
  'title',
  'tags',
  'favorite',
  'status',
  'progress_done',
  'progress_total',
  'error',
  'audio_bytes',
  'duration_sec',
  'finished_at',
  'voice_name',
  'stage',
  'version',
  'built_version',
  // A lesson starts as the brief and becomes the narration once Claude has written it.
  'text',
  'char_count',
  'word_count',
  'settings_json',
]);

/** Turn free text into a safe FTS5 prefix query: every word must match, as a prefix. */
export function buildFtsQuery(q) {
  const tokens = String(q ?? '').match(/[\p{L}\p{N}_]+/gu) || [];
  if (!tokens.length) return null;
  return tokens
    .slice(0, 12)
    .map((t) => `"${t}"*`)
    .join(' ');
}

const round3 = (n) => Math.round(n * 1000) / 1000;

/**
 * A lesson as the API shows it. `costUsd` is what the lesson has cost in all, from its spend rows (null when it has
 * none): it is put on settings.lesson, where the page and the connector read it, and is never taken from what the
 * lesson's settings say.
 */
export function toApi(row, { withText = false, costUsd = null } = {}) {
  if (!row) return null;
  // A video plays once it is done, and a lesson keeps playing its last built version while a
  // newer one is written, checked or built.
  const playable = row.kind === 'video' && (row.status === 'done' || row.built_version > 0);
  const out = {
    id: row.id,
    title: row.title,
    sourceName: row.source_name,
    // Cards show a readable preview: markdown stripped, whitespace collapsed.
    preview: cleanText(row.text.slice(0, 1200)).replace(/\s+/g, ' ').slice(0, 240).trim(),
    charCount: row.char_count,
    wordCount: row.word_count,
    voiceId: row.voice_id,
    voiceName: row.voice_name,
    modelId: row.model_id,
    settings: withCost(JSON.parse(row.settings_json), costUsd),
    status: row.status,
    progressDone: row.progress_done,
    progressTotal: row.progress_total,
    error: row.error,
    stage: row.stage || null,
    audioBytes: row.audio_bytes,
    durationSec: row.duration_sec,
    kind: row.kind || 'audio',
    favorite: !!row.favorite,
    tags: row.tags ? row.tags.split(',') : [],
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    version: row.version || 0,
    builtVersion: row.built_version || 0,
    audioUrl: row.status === 'done' && row.kind !== 'video' ? `/api/generations/${row.id}/audio` : null,
    videoUrl: playable ? `/api/generations/${row.id}/video` : null,
    posterUrl: playable ? `/api/generations/${row.id}/poster` : null,
  };
  if (withText) out.text = row.text;
  if (row.snip !== undefined) {
    out.snippet = row.snip && row.snip.includes(MARK_START) ? row.snip : null;
    out.titleSnippet =
      row.title_snip && row.title_snip.includes(MARK_START) ? row.title_snip : null;
  }
  return out;
}

function withCost(settings, costUsd) {
  if (!settings.lesson) return settings;
  const lesson = { ...settings.lesson };
  delete lesson.costUsd; // a figure kept on the lesson itself can only be out of date
  return { ...settings, lesson: costUsd == null ? lesson : { ...lesson, costUsd: round3(costUsd) } };
}

/**
 * `strictMoves`: throw on a status change lesson-state.js does not allow, instead of logging it and making it.
 * On under the tests (node --test sets NODE_TEST_CONTEXT), so a wrong move fails them.
 */
export function createStore(dataDir, { strictMoves = Boolean(process.env.NODE_TEST_CONTEXT) } = {}) {
  const audioDir = path.join(dataDir, 'audio');
  const previewDir = path.join(dataDir, 'previews');
  const videoDir = path.join(dataDir, 'video');
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(videoDir, { recursive: true });
  fs.mkdirSync(previewDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'studio.db'));
  db.pragma('journal_mode = WAL');
  // Every table in the file, the profiles' and settings' too, is made and changed here (see migrations.js).
  migrate(db);

  const insertStmt = db.prepare(`
    INSERT INTO generations (
      id, profile_id, kind, title, source_name, text, text_hash, config_hash, char_count, word_count,
      voice_id, voice_name, model_id, settings_json, status, tags, created_at
    ) VALUES (
      @id, @profile_id, @kind, @title, @source_name, @text, @text_hash, @config_hash, @char_count, @word_count,
      @voice_id, @voice_name, @model_id, @settings_json, @status, @tags, @created_at
    )`);
  const getStmt = db.prepare('SELECT * FROM generations WHERE id = ?');
  // Anything that changes an item is announced, for the page's live updates: 'change' with its id.
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const deleteStmt = db.prepare('DELETE FROM generations WHERE id = ?');
  const ownerStmt = db.prepare('SELECT profile_id FROM generations WHERE id = ?');
  const findByConfigStmt = db.prepare(
    `SELECT * FROM generations
     WHERE profile_id = ? AND config_hash = ? AND status IN ('queued','processing','done')
     ORDER BY created_at DESC LIMIT 1`,
  );

  const audioPath = (id) => path.join(audioDir, `${id}.mp3`);
  /** A voice's sample, named for the engine's audio version so a new engine renders it again. */
  const previewPath = (voiceId, version) => path.join(previewDir, `${voiceId}.v${version}.mp3`);
  /** A built video, its captions and its poster: ext is mp4, srt, vtt or jpg. */
  const videoPath = (id, ext = 'mp4') => path.join(videoDir, `${id}.${ext}`);

  const statusStmt = db.prepare('SELECT status FROM generations WHERE id = ?');

  /** Checks a status change against the allowed moves (see MOVES in lesson-state.js). */
  function checkMove(id, to) {
    const from = statusStmt.get(id)?.status;
    if (from === undefined || canMove(from, to)) return;
    const message = `Item ${id} cannot move from ${from} to ${to}`;
    if (strictMoves) {
      console.error(message); // so a caller that catches the throw cannot hide it from the tests
      throw new Error(message);
    }
    console.warn(`${message}; made the change anyway so it is not left stuck.`);
  }

  function update(id, patch) {
    const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
    if (!keys.length) return;
    if (keys.includes('status')) checkMove(id, patch.status);
    const set = keys.map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE generations SET ${set} WHERE id = @id`).run({ ...patch, id });
    events.emit('change', id, ownerStmt.get(id)?.profile_id);
  }

  // Every request the writer paid for, one row each. See migrations.js for what the columns mean.
  const spendStmts = {
    add: db.prepare(`INSERT INTO spend (profile_id, generation_id, version_n, created_at, cost_usd, host_usd, settled, step, provider)
                     VALUES (@profile_id, @generation_id, @version_n, @created_at, @cost_usd, @host_usd, @settled, @step, @provider)`),
    // The rows a lesson has made that no version has taken yet.
    stamp: db.prepare('UPDATE spend SET version_n = ? WHERE generation_id = ? AND version_n IS NULL'),
    settle: db.prepare('UPDATE spend SET settled = 1 WHERE generation_id = ? AND version_n IS NULL AND settled = 0'),
    open: db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd, COALESCE(SUM(host_usd), 0) AS host, COUNT(*) AS n FROM spend WHERE generation_id = ? AND version_n IS NULL AND settled = 0'),
    waiting: db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd, COALESCE(SUM(host_usd), 0) AS host FROM spend WHERE generation_id = ? AND version_n IS NULL'),
    byVersion: db.prepare('SELECT version_n AS n, SUM(cost_usd) AS usd, SUM(host_usd) AS host FROM spend WHERE generation_id = ? AND version_n IS NOT NULL GROUP BY version_n'),
    lesson: db.prepare('SELECT SUM(cost_usd) AS usd FROM spend WHERE generation_id = ?'),
  };
  const spend = {
    /** Record a request's cost. `at` is when it was made; hostUsd is how much of it the host's own sign-in or keys paid. */
    add: ({ profileId, generationId = null, versionN = null, at = Date.now(), costUsd, hostUsd = 0, settled = false, step = null, provider = null }) => {
      if (!profileId) throw new Error('Spending is recorded for a profile.');
      return spendStmts.add.run({
        profile_id: profileId, generation_id: generationId, version_n: versionN, created_at: at,
        cost_usd: Number(costUsd) || 0, host_usd: Number(hostUsd) || 0, settled: settled ? 1 : 0, step, provider,
      });
    },
    /**
     * What a lesson's failed or cancelled attempts have spent since its last finished job: the figure the next job
     * continues from, so a Retry stays within the same per-lesson cap. A finished job settles it (see settle).
     */
    open: (id) => {
      const { usd, host } = spendStmts.open.get(id);
      return { usd, host };
    },
    /** A job finished: what it and the attempts before it spent is counted in its result, so it is no longer a retry's to continue. */
    settle: (id) => spendStmts.settle.run(id).changes,
    /** What no version holds yet: a waiting outline or narration, and failed attempts. The next written version takes it. */
    waiting: (id) => spendStmts.waiting.get(id),
    /** What each of a lesson's versions cost, as a Map of version number to dollars. A version with no rows is not in it. */
    byVersion: (id) => new Map(spendStmts.byVersion.all(id).map((r) => [r.n, r.usd])),
    /** What a lesson has cost in all, or null when nothing was ever recorded for it. */
    ofLesson: (id) => spendStmts.lesson.get(id).usd ?? null,
    /** The same for many lessons at once, as a Map of lesson id to dollars. */
    ofLessons: (ids) => {
      if (!ids.length) return new Map();
      const rows = db.prepare(`SELECT generation_id AS id, SUM(cost_usd) AS usd FROM spend WHERE generation_id IN (${ids.map(() => '?').join(',')}) GROUP BY generation_id`).all(...ids);
      return new Map(rows.map((r) => [r.id, r.usd]));
    },
  };

  const versionStmts = {
    insert: db.prepare(`INSERT INTO versions (generation_id, n, source, note, created_at, usage_json, check_ok, warnings, details_json)
                        VALUES (@generation_id, @n, @source, @note, @created_at, @usage_json, @check_ok, @warnings, @details_json)`),
    list: db.prepare('SELECT * FROM versions WHERE generation_id = ? ORDER BY n DESC'),
    get: db.prepare('SELECT * FROM versions WHERE generation_id = ? AND n = ?'),
    next: db.prepare('SELECT COALESCE(MAX(n), 0) + 1 AS n FROM versions WHERE generation_id = ?'),
    remove: db.prepare('DELETE FROM versions WHERE generation_id = ?'),
  };
  const VERSION_FIELDS = new Set(['built_at', 'quality', 'duration_sec', 'video_bytes', 'render_kept', 'note']);
  const versions = {
    next: (id) => versionStmts.next.get(id).n,
    /**
     * Add a version. With takesSpend it is the version the writer's work was for, and in the same step it takes the lesson's
     * spend rows that no version has (earlier outline and narration phases and failed attempts included), so each
     * request is part of exactly one version. An edit or a restore does not take them: it cost nothing, and those
     * rows belong to the next written version.
     */
    insert: (row, { takesSpend = false } = {}) => db.transaction(() => {
      const out = versionStmts.insert.run({ note: null, usage_json: null, check_ok: null, warnings: null, details_json: null, ...row });
      if (takesSpend) spendStmts.stamp.run(row.n, row.generation_id);
      return out;
    })(),
    list: (id) => versionStmts.list.all(id),
    get: (id, n) => versionStmts.get.get(id, n),
    update(id, n, patch) {
      const keys = Object.keys(patch).filter((k) => VERSION_FIELDS.has(k));
      if (!keys.length) return;
      db.prepare(`UPDATE versions SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE generation_id = @id AND n = @n`).run({ ...patch, id, n });
    },
    removeAll: (id) => versionStmts.remove.run(id),
  };

  /** Every read that returns many lessons takes the profile whose library it is: never optional. */
  const need = (profileId) => {
    if (!profileId) throw new Error('A library read needs a profile.');
    return profileId;
  };

  function list(profileId, { q, status, voiceId, favorite, tag, kind, sort, limit = 30, offset = 0 } = {}) {
    const fts = buildFtsQuery(q);
    const where = ['g.profile_id = ?'];
    const args = [need(profileId)];
    let from = 'generations g';
    let cols = 'g.*';
    if (fts) {
      from = 'gen_fts JOIN generations g ON g.seq = gen_fts.rowid';
      cols = `g.*,
        snippet(gen_fts, 1, '${MARK_START}', '${MARK_END}', '…', 24) AS snip,
        snippet(gen_fts, 0, '${MARK_START}', '${MARK_END}', '…', 12) AS title_snip`;
      where.push('gen_fts MATCH ?');
      args.push(fts);
    }
    if (status) {
      where.push('g.status = ?');
      args.push(status);
    }
    if (voiceId) {
      where.push('g.voice_id = ?');
      args.push(voiceId);
    }
    if (kind) {
      where.push('g.kind = ?');
      args.push(kind);
    }
    if (favorite) where.push('g.favorite = 1');
    if (tag) {
      where.push("instr(',' || g.tags || ',', ?) > 0");
      args.push(`,${String(tag).toLowerCase()},`);
    }
    const orders = {
      new: 'g.created_at DESC',
      old: 'g.created_at ASC',
      longest: 'COALESCE(g.duration_sec, 0) DESC, g.created_at DESC',
      title: 'g.title COLLATE NOCASE ASC',
      relevance: fts ? 'gen_fts.rank, g.created_at DESC' : 'g.created_at DESC',
    };
    const key = !sort || sort === 'relevance' ? 'relevance' : orders[sort] ? sort : 'new';
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT COUNT(*) AS n FROM ${from} ${whereSql}`).get(...args).n;
    const rows = db
      .prepare(`SELECT ${cols} FROM ${from} ${whereSql} ORDER BY ${orders[key]} LIMIT ? OFFSET ?`)
      .all(...args, Math.min(Math.max(limit, 1), 200), Math.max(offset, 0));
    const costs = spend.ofLessons(rows.map((r) => r.id));
    return { total, items: rows.map((r) => toApi(r, { costUsd: costs.get(r.id) ?? null })) };
  }

  function stats(profileId, { excludeId = null } = {}) {
    need(profileId);
    const done = db
      .prepare(
        `SELECT COUNT(*) AS files,
                COALESCE(SUM(char_count), 0) AS chars,
                COALESCE(SUM(duration_sec), 0) AS seconds,
                COALESCE(SUM(audio_bytes), 0) AS bytes
         FROM generations WHERE profile_id = ? AND status = 'done'`,
      )
      .get(profileId);
    const active = db
      .prepare(`SELECT COUNT(*) AS n FROM generations WHERE profile_id = ? AND status IN ('queued','processing')`)
      .get(profileId).n;
    const awaiting = db.prepare(`SELECT COUNT(*) AS n FROM generations WHERE profile_id = ? AND status = 'awaiting'`).get(profileId).n;
    // What writing lessons cost this calendar month: every request made in it, whatever became of its lesson. A request
    // is one row, so a figure is counted once however many places it used to be kept (a version, a waiting outline,
    // a failed attempt, a deleted lesson).
    const month = new Date();
    month.setDate(1);
    month.setHours(0, 0, 0, 0);
    // A lesson being retried is held to its own caps with its failed attempts' spending counted by the job itself
    // (it continues from them), so those rows alone are left out here: everything else it has spent still counts, once.
    const mine = excludeId ? ' AND NOT (generation_id IS ? AND version_n IS NULL AND settled = 0)' : '';
    const spent = db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS usd, COALESCE(SUM(host_usd), 0) AS host FROM spend WHERE profile_id = ? AND created_at >= ?${mine}`)
      .get(profileId, month.getTime(), ...(excludeId ? [excludeId] : []));
    const voices = db
      .prepare(
        `SELECT voice_id AS voiceId, COALESCE(MAX(voice_name), voice_id) AS name, COUNT(*) AS n
         FROM generations WHERE profile_id = ? GROUP BY voice_id ORDER BY n DESC`,
      )
      .all(profileId);
    return { ...done, active, awaiting, voices, costThisMonthUsd: Math.round(spent.usd * 100) / 100, hostSpentThisMonthUsd: Math.round(spent.host * 100) / 100 };
  }

  function tags(profileId) {
    const counts = new Map();
    for (const { tags: t } of db.prepare("SELECT tags FROM generations WHERE profile_id = ? AND tags != ''").all(need(profileId))) {
      for (const tag of t.split(',')) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, n]) => ({ tag, n }))
      .sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag));
  }

  /**
   * Jobs that were running when the server stopped cannot continue; flag them so they can be retried.
   * A job that was only waiting its turn is left alone for resumeQueued: it had cost nothing yet.
   * A running one may be the lesson writer, which spends money, so it is never started again on its own.
   */
  function markInterrupted() {
    return db
      .prepare(
        `UPDATE generations SET status = 'error', error = 'Interrupted by a server restart. Press Retry.',
                finished_at = ? WHERE status = 'processing'`,
      )
      .run(Date.now()).changes;
  }

  /**
   * The jobs that were waiting their turn when the server stopped, oldest first, with their progress cleared.
   * A waiting job is only ever narrating audio or building a video that is already written, which costs
   * nothing, so the caller can put them straight back in the queue.
   */
  function resumeQueued() {
    const ids = db.prepare(`SELECT id FROM generations WHERE status = 'queued' ORDER BY created_at, seq`).all().map((r) => r.id);
    for (const id of ids) update(id, { progress_done: 0, progress_total: 0, error: null, finished_at: null });
    return ids;
  }

  return {
    db,
    dataDir,
    audioPath,
    previewPath,
    videoPath,
    insert: (row) => {
      if (!row.profile_id) throw new Error('A lesson is inserted for a profile.');
      const out = insertStmt.run({ kind: 'audio', ...row });
      events.emit('change', row.id, row.profile_id);
      return out;
    },
    getRaw: (id) => getStmt.get(id),
    get: (id, opts) => toApi(getStmt.get(id), { costUsd: spend.ofLesson(id), ...opts }),
    findByConfig: (profileId, hash) => findByConfigStmt.get(need(profileId), hash),
    /** A lesson only if it is this profile's. Anyone else's is the same as none. */
    getOwned: (id, profileId, opts) => {
      const row = getStmt.get(id);
      return row && row.profile_id === profileId ? toApi(row, { costUsd: spend.ofLesson(id), ...opts }) : null;
    },
    getRawOwned: (id, profileId) => {
      const row = getStmt.get(id);
      return row && row.profile_id === profileId ? row : null;
    },
    /** Every lesson a profile has, as rows. */
    rowsOf: (profileId) => db.prepare('SELECT * FROM generations WHERE profile_id = ?').all(need(profileId)),
    update,
    remove: (id) => {
      // One step: a crash partway must not leave the versions gone and the lesson still there. The lesson's spend rows are
      // not touched at all: they carry the profile and the date, so a deleted lesson's cost stays in the month's total.
      const removal = db.transaction(() => {
        const owner = ownerStmt.get(id)?.profile_id;
        versions.removeAll(id);
        return { owner, n: deleteStmt.run(id).changes };
      });
      const { owner, n } = removal();
      // Announced only once it is saved, so the page never hears of a removal that was rolled back.
      if (n) events.emit('change', id, owner);
      return n;
    },
    versions,
    spend,
    events,
    // Across every profile on purpose: a folder is removed only when nobody's lesson still uses it.
    /** Which profiles have a lesson built from each project folder: name -> Set of profile ids. */
    projectOwners: () => {
      const owners = new Map();
      for (const r of db.prepare("SELECT DISTINCT source_name, profile_id FROM generations WHERE source_name LIKE 'video/projects/%'").all()) {
        const name = r.source_name.slice('video/projects/'.length);
        owners.set(name, (owners.get(name) || new Set()).add(r.profile_id));
      }
      return owners;
    },
    countBySource: (source) => db.prepare('SELECT COUNT(*) AS n FROM generations WHERE source_name = ?').get(source).n,
    /** Jobs a restart would interrupt, across every profile. A waiting job is not one: it is queued again on start. */
    inFlight: () => db.prepare(`SELECT COUNT(*) AS n FROM generations WHERE status = 'processing'`).get().n,
    list,
    stats,
    tags,
    markInterrupted,
    resumeQueued,
    close: () => db.close(),
  };
}
