import express from 'express';
import { createEdits, EditError } from './edits.js';
import { VIDEO_QUALITIES } from '../shared/limits.js';
import { httpError } from './route-helpers.js';

/** Editing a lesson's working copy, and the list of its versions. */
export function editRoutes({ store, runner, lessons, versions, profiles, getConfig, helpers }) {
  const r = express.Router();
  const { findOwned } = helpers;

  // Editing a lesson: its working copy, saved with a quick check, checked in full, rendered as the
  // next version, discarded, or an earlier version restored. See edits.js.
  const edits = versions ? createEdits({ store, versions, getConfig, runner, lessons }) : null;
  /**
   * Saving, checking and building run the Python in a lesson's scenes.py. With the macOS sandbox that code is confined;
   * without it (Linux, Docker) it runs as this server, which can read every profile's library and keys. So where
   * people share an install, only the Owner may run code they wrote. Lessons the writer makes are still checked.
   */
  const unconfinedForYou = (req) => !req.profile.isOwner && !getConfig().sandboxed && profiles.list().length > 1;
  const editing = (fn, { runsCode = false } = {}) => async (req, res) => {
    if (!edits) throw httpError(404, 'Not found');
    try {
      const row = findOwned(req);
      if (runsCode && row && unconfinedForYou(req)) {
        throw new EditError('On this computer a lesson’s scenes run with no sandbox, so only the Owner can save, check or build code here while others share this install. Ask for a change instead, or ask the Owner.', 403);
      }
      res.json(await fn(row, req.body || {}, req));
    } catch (e) {
      if (e instanceof EditError) {
        res.status(e.status).json({ error: e.message, ...(e.current ? { current: e.current } : {}) });
        return;
      }
      throw e;
    }
  };
  r.get('/generations/:id/source', editing((row, b, req) => edits.source(row, req.query.chapter ? String(req.query.chapter) : null)));
  r.put('/generations/:id/source', editing((row, b) => edits.save(row, b), { runsCode: true }));
  r.post('/generations/:id/check', editing((row, b) => edits.check(row, { chapter: b.chapter || null }), { runsCode: true }));
  r.post('/generations/:id/build', editing((row, b) => edits.check(row, { build: true, quality: VIDEO_QUALITIES.includes(b.quality) ? b.quality : null, chapter: b.chapter || null }), { runsCode: true }));
  r.post('/generations/:id/discard', editing((row) => edits.discard(row)));
  r.post('/generations/:id/restore', editing((row, b) => {
    const n = Number(b.version);
    if (!Number.isInteger(n) || n < 1) throw new EditError('Say which version to restore: { version: n }.');
    return edits.restore(row, n);
  }, { runsCode: true }));
  r.get('/generations/:id/versions/:n/source', editing((row, b, req) => edits.versionSource(row, Number(req.params.n), req.query.chapter ? String(req.query.chapter) : null)));

  // A lesson's versions, newest first.
  r.get('/generations/:id/versions', (req, res) => {
    const row = findOwned(req);
    if (!row) throw httpError(404, 'Not found');
    res.json({
      current: row.version || 0,
      built: row.built_version || 0,
      versions: store.versions.list(row.id).map((v) => ({
        n: v.n,
        source: v.source,
        note: v.note,
        createdAt: v.created_at,
        costUsd: v.cost_usd,
        usage: v.usage_json ? JSON.parse(v.usage_json) : null,
        checkOk: v.check_ok == null ? null : !!v.check_ok,
        warnings: v.warnings,
        builtAt: v.built_at,
        quality: v.quality,
        durationSec: v.duration_sec,
        renderKept: !!v.render_kept,
        details: v.details_json ? JSON.parse(v.details_json) : null,
      })),
    });
  });

  return r;
}
