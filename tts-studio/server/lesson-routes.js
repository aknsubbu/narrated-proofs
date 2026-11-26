import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { countWords, slugify } from './text.js';
import { MODEL_ID } from './kokoro.js';
import { NotesError, saveAttachments } from './notes.js';
import { chaptersOf, stillsOf } from './versions.js';
import { actorOf } from './settings-routes.js';
import { SettingsError } from './settings.js';
import { CHAPTERS_FROM, LESSON_MINUTES, MAX_NOTES, VIDEO_QUALITIES } from '../shared/limits.js';
import { normalizeOutline } from '../author/pipeline.js';
import { httpError, normalizeTags, sha } from './route-helpers.js';

/**
 * Lessons: starting one, and steering it once it is running (retry, cancel, approve, outline,
 * revise), plus the storyboard it shows while it waits for you.
 */
export function lessonRoutes({ store, runner, engine, lessons, versions, settings, getConfig, helpers }) {
  const r = express.Router();
  const { findOwned, checkVoice } = helpers;

  // A lesson: Claude (or the writer chosen in Settings) writes the script and the scenes from a
  // topic and notes, then it is built like any other video. The row exists from the start so the
  // library shows each stage. Lessons Claude starts through MCP have origin "claude": its own
  // writer and defaults, when Settings gives it some.
  r.post('/lessons', async (req, res) => {
    if (!lessons) throw httpError(503, 'Lessons are not set up on this server.');
    const b = req.body || {};
    // `profile` is the name older MCP clients send for this.
    const origin = (b.origin || b.profile) === 'claude' || actorOf(req) === 'claude' ? 'claude' : 'page';
    const mine = settings ? settings.for(req.profile.id) : null;
    const defaults = mine ? mine.lessonDefaults(origin) : { minutes: 2, quality: 'default', review: getConfig().lessonReview || 'render', voiceId: getConfig().defaultVoiceId };
    const topic = String(b.topic || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const goal = String(b.goal || '').trim().slice(0, 2000);
    const notes = String(b.notes || '').trim();
    if (!topic) throw httpError(400, 'Say what the video should be about.');
    if (notes.length > MAX_NOTES) throw httpError(400, `Notes are limited to ${MAX_NOTES.toLocaleString('en-US')} characters; these have ${notes.length.toLocaleString('en-US')}.`);
    const voiceId = String(b.voiceId || defaults.voiceId || getConfig().defaultVoiceId);
    checkVoice(voiceId);
    // Marks need word timings, which only the English voices have.
    if (!/^[ab]/.test(voiceId)) throw httpError(400, 'Lessons need an English voice, so animations can follow individual words.');
    const minutes = LESSON_MINUTES.includes(Number(b.minutes)) ? Number(b.minutes) : defaults.minutes;
    // From CHAPTERS_FROM minutes a lesson is written in chapters, after an outline you can review.
    const chaptered = minutes >= CHAPTERS_FROM;
    const outlineReview = chaptered && b.outlineReview !== false;
    const titleCards = chaptered ? b.titleCards !== false : undefined;
    const quality = VIDEO_QUALITIES.includes(b.quality) ? b.quality : defaults.quality;
    // "storyboard" stops before rendering so the lesson can be looked at first; "script" stops
    // after the narration, so the scenes are written only for a narration you approve. A lesson
    // in chapters is reviewed at its outline instead of its narration.
    let review = ['render', 'storyboard', 'script'].includes(b.review) ? b.review : defaults.review || 'render';
    if (chaptered && review === 'script') review = 'render';
    const visualReview = b.visualReview === undefined ? (settings ? defaults.visualReview : undefined) : Boolean(b.visualReview);
    // A writer chosen for this lesson alone: one provider set up in Settings, for every step.
    const override = b.writer?.provider ? { provider: String(b.writer.provider).slice(0, 40), model: String(b.writer.model || '').slice(0, 200) } : null;
    if (settings) {
      try {
        if (override && !mine.provider(override.provider)) throw new SettingsError(`There is no provider called “${override.provider}”.`);
        await mine.checkWriter(mine.resolveWriter(origin, override));
        const { monthCapUsd } = mine.costs();
        // Read once: it scans every lesson of the profile, and both checks need it.
        const spent = store.stats(req.profile.id);
        const allowance = await mine.hostAllowance(mine.resolveWriter(origin, override), spent.hostSpentThisMonthUsd);
        if (allowance?.usesHost && allowance.leftUsd <= 0) throw new SettingsError(mine.hostAllowanceMessage(allowance));
        if (monthCapUsd != null && spent.costThisMonthUsd >= monthCapUsd) {
          throw new SettingsError(`This month's lessons have reached the monthly cap of $${monthCapUsd.toFixed(2)}. Raise it in Settings → Costs, or choose a free writer.`);
        }
      } catch (e) {
        if (e instanceof SettingsError) throw httpError(400, e.message);
        throw e;
      }
    }
    const id = crypto.randomUUID();
    const project = `${slugify(topic, 'lesson').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'lesson'}-${id.slice(0, 6)}`;
    const ownTitle = String(b.title || '').trim().slice(0, 120);
    // Photos, PDFs and documents are saved into the project now, so only their names travel on
    // to the lesson writer. Documents, and PDFs sent as text, become text and join the typed notes.
    // If anything after this fails, the folder goes too, so no lesson-less folder is left behind. Only
    // a folder this request made is removed: the random end of the name makes that certain, but check.
    const projectDir = path.join(getConfig().videoDir, 'projects', project);
    const madeFolder = !fs.existsSync(projectDir);
    let inserted = false;
    try {
      let attached;
      try {
        attached = await saveAttachments(projectDir, b.attachments, { maxEdge: getConfig().notesImageEdge });
      } catch (e) {
        if (e instanceof NotesError) throw httpError(400, e.message);
        throw e;
      }
      const allNotes = [notes, attached.text].filter(Boolean).join('\n\n');
      if (allNotes.length > MAX_NOTES) {
        throw httpError(400, `With the attached documents the notes come to ${allNotes.length.toLocaleString('en-US')} characters; the limit is ${MAX_NOTES.toLocaleString('en-US')}. Attach a long document as a PDF instead.`);
      }
      const brief = [topic, goal, allNotes].filter(Boolean).join('\n\n');
      store.insert({
        id,
        profile_id: req.profile.id,
        kind: 'video',
        title: ownTitle || topic.slice(0, 120),
        source_name: `video/projects/${project}`,
        text: brief,
        text_hash: sha(brief),
        config_hash: sha(`lesson:${id}`),
        char_count: brief.length,
        word_count: countWords(brief),
        voice_id: voiceId,
        voice_name: engine.catalog().voices.find((v) => v.voiceId === voiceId)?.name || null,
        model_id: MODEL_ID,
        settings_json: JSON.stringify({
          project, quality, speed: 1, scenes: [],
          lesson: {
            topic, goal, minutes, review, ownTitle: !!ownTitle,
            attachments: attached.files.map(({ name, file, kind, pages, asText }) => ({ name, file, kind, ...(pages ? { pages } : {}), ...(asText ? { asText } : {}) })),
            ...(origin === 'claude' ? { origin } : {}),
            ...(override ? { writer: override } : {}),
            ...(chaptered ? { chaptered, outlineReview } : {}),
          },
        }),
        status: 'queued',
        tags: normalizeTags(b.tags ?? ['lesson']).join(','),
        created_at: Date.now(),
      });
      inserted = true;
      await lessons.start(id, { topic, goal, notes: allNotes, minutes, voice: voiceId, attachments: attached.files.filter((f) => !f.asText), visualReview, ...(chaptered ? { titleCards } : {}) });
    } catch (e) {
      if (inserted) {
        // The lesson cannot go on, and it would claim a folder that is about to be gone.
        lessons.cancel(id);
        store.remove(id);
      }
      if (madeFolder) fs.rmSync(projectDir, { recursive: true, force: true });
      throw e;
    }
    res.status(201).json({ generation: store.get(id) });
  });

  r.post('/generations/:id/retry', async (req, res) => {
    const row = findOwned(req);
    if (!row) throw httpError(404, 'Not found');
    if (!['error', 'cancelled'].includes(row.status)) throw httpError(409, 'Only failed or cancelled items can be retried.');
    if (row.kind !== 'video') checkVoice(row.voice_id); // a video's voice is checked by its build
    const settings = JSON.parse(row.settings_json);
    if (settings.lesson && lessons && !lessons.isWritten(settings.project)) {
      // Claude never finished this one: go back to the writer, which picks up where it stopped.
      await lessons.start(row.id);
      return res.json(store.get(row.id));
    }
    store.update(row.id, { status: 'queued', error: null, progress_done: 0, finished_at: null });
    runner.enqueue(row.id);
    res.json(store.get(row.id));
  });

  r.post('/generations/:id/cancel', (req, res) => {
    const row = findOwned(req);
    if (!row) throw httpError(404, 'Not found');
    if (row.status === 'awaiting') {
      // Waiting on the person: cancelling means "don't render it". Retry renders it after all.
      store.update(row.id, { status: 'cancelled', error: 'Cancelled', stage: null, finished_at: Date.now() });
    } else if (!runner.cancel(row.id)) {
      lessons?.cancel(row.id);
    }
    res.json(store.get(req.params.id));
  });

  // A lesson waiting on you: { action: "render" } renders it after its storyboard, optionally at
  // another quality; { action: "scenes" } has the scenes written for a narration you approved.
  r.post('/generations/:id/approve', async (req, res) => {
    const row = findOwned(req);
    if (!row) throw httpError(404, 'Not found');
    if (row.status !== 'awaiting') throw httpError(409, 'This lesson is not waiting for approval.');
    const b = req.body || {};
    const settings = JSON.parse(row.settings_json);
    const narration = settings.lesson?.phase === 'script';
    if (settings.lesson?.phase === 'outline') {
      // The outline is approved, as it is or as edited here: the chapters are written.
      if ((b.action ?? 'chapters') !== 'chapters') throw httpError(409, 'This lesson is waiting on its outline: approve it with { action: "chapters" }.');
      if (!lessons) throw httpError(503, 'Lessons are not set up on this server.');
      if (b.outline) saveOutline(row, b.outline);
      const fresh = JSON.parse(store.getRaw(row.id).settings_json);
      if (VIDEO_QUALITIES.includes(b.quality)) fresh.quality = b.quality;
      fresh.lesson = { ...fresh.lesson, outlineApproved: true, phase: null };
      store.update(row.id, { settings_json: JSON.stringify(fresh) });
      await lessons.start(row.id);
      return res.json(store.get(row.id));
    }
    const action = b.action ?? (narration ? 'scenes' : 'render');
    if (narration) {
      if (action !== 'scenes') throw httpError(409, 'This lesson is waiting on its narration: approve it with { action: "scenes" }.');
      if (!lessons) throw httpError(503, 'Lessons are not set up on this server.');
      if (VIDEO_QUALITIES.includes(b.quality)) settings.quality = b.quality;
      settings.lesson = { ...settings.lesson, scriptApproved: true };
      store.update(row.id, { settings_json: JSON.stringify(settings) });
      await lessons.start(row.id);
      return res.json(store.get(row.id));
    }
    if (action !== 'render') throw httpError(400, 'This lesson is waiting on its storyboard: approve it with { action: "render" }.');
    if (VIDEO_QUALITIES.includes(b.quality)) settings.quality = b.quality;
    store.update(row.id, { status: 'queued', stage: null, error: null, progress_done: 0, finished_at: null, settings_json: JSON.stringify(settings) });
    runner.enqueue(row.id);
    res.json(store.get(row.id));
  });

  // A long lesson's outline: read it, change it while it waits for you, or have it redone.
  const outlineFile = (row) => path.join(getConfig().videoDir, 'projects', JSON.parse(row.settings_json).project, 'outline.json');
  function saveOutline(row, raw) {
    let outline;
    try {
      outline = normalizeOutline(raw, { maxChapters: getConfig().maxChapters });
    } catch (e) {
      throw httpError(400, e.message);
    }
    fs.writeFileSync(outlineFile(row), `${JSON.stringify(outline, null, 2)}\n`);
    const settings = JSON.parse(row.settings_json);
    settings.lesson = { ...settings.lesson, chapters: outline.chapters.map(({ id, title, minutes }) => ({ id, title, minutes })) };
    store.update(row.id, {
      settings_json: JSON.stringify(settings),
      ...(settings.lesson.ownTitle ? {} : { title: outline.title.slice(0, 120) }),
      stage: `Outline ready: ${outline.chapters.length} chapters, about ${outline.chapters.reduce((t, c) => t + c.minutes, 0)} minutes`,
    });
    return outline;
  }
  const waitingOnOutline = (row) => {
    if (!row) throw httpError(404, 'Not found');
    if (row.status !== 'awaiting' || JSON.parse(row.settings_json).lesson?.phase !== 'outline') throw httpError(409, 'The outline can be changed only while it waits for you, before the chapters are written.');
  };

  r.get('/generations/:id/outline', (req, res) => {
    const row = findOwned(req);
    if (!row) throw httpError(404, 'Not found');
    let outline;
    try {
      outline = JSON.parse(fs.readFileSync(outlineFile(row), 'utf8'));
    } catch {
      throw httpError(404, 'This lesson has no outline.');
    }
    const root = path.dirname(outlineFile(row));
    res.json({
      ...outline,
      chapters: outline.chapters.map((c) => ({ ...c, written: fs.existsSync(path.join(root, 'chapters', c.id, 'author.json')) })),
      waiting: row.status === 'awaiting' && JSON.parse(row.settings_json).lesson?.phase === 'outline',
    });
  });

  r.put('/generations/:id/outline', (req, res) => {
    const row = findOwned(req);
    waitingOnOutline(row);
    res.json({ outline: saveOutline(row, req.body?.outline || req.body), generation: store.get(row.id) });
  });

  r.post('/generations/:id/outline/redo', async (req, res) => {
    const row = findOwned(req);
    waitingOnOutline(row);
    const request = String(req.body?.request || '').trim();
    if (!request) throw httpError(400, 'Say what to change in the outline.');
    await lessons.start(row.id, undefined, { phase: 'outline', redo: request.slice(0, 2000) });
    res.json(store.get(row.id));
  });

  // Ask for a change to a written lesson. The writer answers with only what changes; the result is
  // checked, becomes the next version, and renders (or waits at its storyboard with review).
  r.post('/generations/:id/revise', async (req, res) => {
    const row = findOwned(req);
    if (!row) throw httpError(404, 'Not found');
    const settings = JSON.parse(row.settings_json);
    if (!settings.lesson || !lessons) throw httpError(403, 'Only lessons can be revised. A project written by hand is edited in its folder.');
    if (['queued', 'processing'].includes(row.status)) throw httpError(409, 'This lesson is being written, checked or built. Wait for it to finish.');
    if (settings.lesson.phase === 'script') throw httpError(409, 'The narration is waiting for you: change it in the Edit tab, then approve it.');
    const root = path.join(getConfig().videoDir, 'projects', settings.project);
    if (!fs.existsSync(path.join(root, 'scenes.py')) && !chaptersOf(root).length) throw httpError(409, 'This lesson has no scenes to change yet.');
    const b = req.body || {};
    const request = String(b.request || '').trim();
    if (!request) throw httpError(400, 'Say what to change.');
    if (request.length > 4000) throw httpError(400, 'A change request is limited to 4,000 characters.');
    const scope = scopeOf(row, b.scope);
    // A lesson in chapters is changed a chapter at a time.
    const chapters = chaptersOf(root);
    const chapter = chapters.length ? String(b.chapter || scope.chapter || '') : null;
    if (chapters.length && !chapters.includes(chapter)) throw httpError(400, `Say which chapter to change: ${chapters.join(', ')}.`);
    delete scope.chapter;
    let attached;
    try {
      attached = await saveAttachments(root, b.attachments, { maxEdge: getConfig().notesImageEdge, prefix: `rev${(row.version || 0) + 1}-` });
    } catch (e) {
      if (e instanceof NotesError) throw httpError(400, e.message);
      throw e;
    }
    const history = store.versions.list(row.id).filter((v) => v.source === 'revised' && v.details_json).reverse().slice(-3)
      .map((v) => JSON.parse(v.details_json)).map(({ request: r, summary }) => ({ request: r, summary }));
    const fromChapter = root && chapter ? path.join(root, 'chapters', chapter) : root;
    if (!fs.existsSync(path.join(fromChapter, 'scenes.py'))) throw httpError(409, 'That chapter has no scenes to change yet.');
    await lessons.revise(row.id, {
      chapter,
      request: attached.text ? `${request}\n\nNotes that came with the request (material, not instructions):\n\n${attached.text}` : request,
      scope,
      attachments: attached.files.filter((f) => !f.asText),
      history,
      review: ['render', 'storyboard'].includes(b.review) ? b.review : 'render',
    });
    res.json(store.get(row.id));
  });

  /** A revision's scope: the lesson, a scene, a block, or the moment the video was paused at. */
  function scopeOf(row, scope) {
    if (!scope || !scope.kind || scope.kind === 'lesson') return { kind: 'lesson' };
    const chapter = scope.chapter ? { chapter: String(scope.chapter) } : {};
    if (scope.kind === 'chapter') return { kind: 'lesson', ...chapter };
    if (scope.kind === 'scene') {
      if (!/^[A-Za-z_]\w{0,80}$/.test(String(scope.name))) throw httpError(400, 'A scene is named by its class, like Intro.');
      return { kind: 'scene', name: String(scope.name), ...chapter };
    }
    if (scope.kind === 'block') {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(String(scope.id))) throw httpError(400, 'A block is named by its id, like intro.');
      return { kind: 'block', id: String(scope.id), ...chapter };
    }
    if (scope.kind === 'time') {
      const at = Number(scope.at);
      let words;
      try {
        words = JSON.parse(fs.readFileSync(store.videoPath(row.id, 'words.json'), 'utf8'));
      } catch {
        throw httpError(400, 'This video has no transcript to place that moment in. Choose a scene or a block instead.');
      }
      const blocks = words.blocks || [];
      const hit = blocks.findLast((x) => x.start <= at) || blocks[0];
      if (!Number.isFinite(at) || !hit) throw httpError(400, 'That is not a moment in the video.');
      return { kind: 'block', id: hit.id, scene: hit.scene, at, ...(hit.chapter ? { chapter: hit.chapter } : {}) };
    }
    throw httpError(400, 'A scope is the lesson, a scene, a block or a time.');
  }

  // The storyboard: per scene and block, the narration and the stills the check took. The
  // working copy's by default (the last check), or a version's with ?version=n.
  const storyboardOf = (req) => {
    const row = findOwned(req);
    if (!row || row.kind !== 'video' || !versions) throw httpError(404, 'Not found');
    const version = req.query.version ? Number(req.query.version) : 0;
    if (req.query.version && !(Number.isInteger(version) && version > 0)) throw httpError(400, 'A version is a whole number.');
    const chapter = req.query.chapter ? String(req.query.chapter) : null;
    const found = versions.storyboard(row, version, chapter);
    if (!found) throw httpError(404, 'No storyboard yet. It appears once the scenes have been checked.');
    return { row, version, chapter, ...found };
  };

  r.get('/generations/:id/storyboard', (req, res) => {
    const { row, version, chapter, board } = storyboardOf(req);
    const params = new URLSearchParams({ ...(version ? { version: String(version) } : {}), ...(chapter ? { chapter } : {}) }).toString();
    const q = params ? `?${params}` : '';
    const still = (s) => ({ ...s, url: `/api/generations/${row.id}/storyboard/${encodeURIComponent(path.basename(String(s.file)))}${q}` });
    res.json({
      ...board,
      version: version || null,
      scenes: (board.scenes || []).map((scene) => ({
        ...scene,
        endUrl: scene.end ? still({ file: scene.end }).url : null,
        blocks: (scene.blocks || []).map((b) => ({
          ...b,
          stills: (b.stills || []).map(still),
          // Narration is only on disk for the working copy: an edit re-speaks and drops old blocks.
          audioUrl: version ? null : `/api/generations/${row.id}/narration/${encodeURIComponent(b.id)}${chapter ? `?chapter=${encodeURIComponent(chapter)}` : ''}`,
        })),
      })),
    });
  });

  r.get('/generations/:id/storyboard/:file', (req, res) => {
    const { frames, board } = storyboardOf(req);
    const file = String(req.params.file);
    if (!/^[A-Za-z0-9_-]+\.png$/.test(file) || !stillsOf(board).has(file)) throw httpError(404, 'No such still');
    const full = path.join(frames, file);
    if (!fs.existsSync(full)) throw httpError(404, 'That still is no longer on disk');
    res.set('Cache-Control', 'private, max-age=60');
    res.sendFile(full, { dotfiles: 'allow' });
  });

  return r;
}
