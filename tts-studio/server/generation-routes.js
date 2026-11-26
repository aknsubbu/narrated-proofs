import crypto from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import { toApi } from './db.js';
import { cleanText, countWords, slugify } from './text.js';
import { AUDIO_VERSION, MODEL_ID } from './kokoro.js';
import { httpError, MAX_CHARS, normalizeTags, sha } from './route-helpers.js';

const clamp = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

export function normalizeSettings(s = {}) {
  return {
    speed: clamp(s.speed, 0.5, 2, 1),
    stripMarkdown: s.stripMarkdown !== false,
  };
}

function deriveTitle(text) {
  const first = text.split('\n').map((l) => l.replace(/^#+\s*/, '').trim()).find(Boolean) || '';
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first || 'Untitled script';
}

/**
 * The library and the voices: listing, creating (plain audio), renaming, deleting and playing items,
 * the live event stream, and the voice catalog with its previews.
 */
export function generationRoutes({ store, runner, engine, getConfig, helpers, removeLesson }) {
  const r = express.Router();
  const { withQueue, findOwned, checkVoice } = helpers;

  const previews = new Map(); // voice id -> in-flight preview render

  r.get('/voices', async (req, res) => {
    await engine.start();
    const { voices, languages } = engine.catalog();
    res.json({ voices, languages });
  });

  // A short sample of each voice, rendered on first request and kept on disk.
  r.get('/voices/:id/preview', async (req, res) => {
    await engine.start();
    const { voices, languages, samples } = engine.catalog();
    const voice = voices.find((v) => v.voiceId === req.params.id);
    if (!voice) throw httpError(404, 'Unknown voice');
    const language = languages.find((l) => l.code === voice.lang);
    if (language && !language.available) throw httpError(400, `${language.name} voices are not set up. ${language.hint}`);
    const file = store.previewPath(voice.voiceId, AUDIO_VERSION);
    if (!fs.existsSync(file)) {
      if (!previews.has(voice.voiceId)) {
        const tmp = `${file}.tmp`;
        const job = engine
          .synthesize({ text: samples[voice.lang], voice: voice.voiceId, out: tmp })
          .then(() => fs.renameSync(tmp, file))
          .finally(() => previews.delete(voice.voiceId));
        previews.set(voice.voiceId, job);
      }
      await previews.get(voice.voiceId);
    }
    res.type('audio/mpeg');
    // The browser asks again each time (a 304 when nothing changed), so a sample made by an older engine is not replayed.
    res.set('Cache-Control', 'private, no-cache');
    res.sendFile(file, { dotfiles: 'allow' });
  });

  r.get('/stats', (req, res) => res.json(store.stats(req.profile.id)));

  // Live updates: every change to an item, as Server-Sent Events. Progress can change many times
  // a second, so each item is sent at most every 200 ms, with its latest state.
  r.get('/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const due = new Map(); // id -> timer
    // A stream lasts long: it ends when its session does (sign-out, a PIN reset, a deleted profile).
    const stillMe = () => req.credential?.() === req.profile.id;
    const send = (id) => {
      due.delete(id);
      if (!stillMe()) return res.end();
      const g = withQueue(store.getOwned(id, req.profile.id));
      res.write(`event: generation\ndata: ${JSON.stringify(g || { id, deleted: true })}\n\n`);
    };
    // Only changes to this profile's own lessons are sent down this connection.
    const onChange = (id, owner) => {
      if (owner !== req.profile.id) return;
      if (!due.has(id)) due.set(id, setTimeout(() => send(id), 200));
    };
    const ping = setInterval(() => (stillMe() ? res.write(': ping\n\n') : res.end()), 25_000);
    store.events.on('change', onChange);
    req.on('close', () => {
      store.events.off('change', onChange);
      clearInterval(ping);
      for (const t of due.values()) clearTimeout(t);
    });
  });
  r.get('/tags', (req, res) => res.json({ tags: store.tags(req.profile.id) }));

  r.get('/generations', (req, res) => {
    const { q, status, voiceId, favorite, tag, sort, kind } = req.query;
    const page = store.list(req.profile.id, {
        q: q ? String(q) : '',
        status: status ? String(status) : '',
        voiceId: voiceId ? String(voiceId) : '',
        favorite: favorite === '1' || favorite === 'true',
        tag: tag ? String(tag) : '',
        kind: ['audio', 'video'].includes(kind) ? kind : '',
        sort: sort ? String(sort) : '',
        limit: Number(req.query.limit) || 30,
        offset: Number(req.query.offset) || 0,
    });
    res.json({ ...page, items: page.items.map(withQueue) });
  });

  r.get('/generations/:id', (req, res) => {
    const g = store.getOwned(req.params.id, req.profile.id, { withText: true });
    if (!g) throw httpError(404, 'Not found');
    res.json(withQueue(g));
  });

  r.post('/generations', (req, res) => {
    const b = req.body || {};
    const rawText = typeof b.text === 'string' ? b.text : '';
    if (!rawText.trim()) throw httpError(400, 'The script is empty.');

    const settings = normalizeSettings(b.settings);
    const cleaned = cleanText(rawText, { stripMarkdown: settings.stripMarkdown });
    if (!cleaned) throw httpError(400, 'Nothing speakable is left after cleanup.');
    if (cleaned.length > MAX_CHARS) {
      throw httpError(413, `Script is ${cleaned.length.toLocaleString()} characters; the limit is ${MAX_CHARS.toLocaleString()}.`);
    }

    const voiceId = String(b.voiceId || getConfig().defaultVoiceId).trim();
    const voice = checkVoice(voiceId);

    const configHash = sha(JSON.stringify([cleaned, voiceId, MODEL_ID, settings, AUDIO_VERSION]));
    if (!b.force) {
      const existing = store.findByConfig(req.profile.id, configHash);
      if (existing) return res.json({ duplicate: true, generation: toApi(existing) });
    }

    const id = crypto.randomUUID();
    const title = String(b.title || '').trim().slice(0, 120) || deriveTitle(cleaned);
    store.insert({
      id,
      profile_id: req.profile.id,
      title,
      source_name: b.sourceName ? String(b.sourceName).slice(0, 200) : null,
      text: rawText,
      text_hash: sha(cleaned),
      config_hash: configHash,
      char_count: cleaned.length,
      word_count: countWords(cleaned),
      voice_id: voiceId,
      voice_name: voice?.name || (b.voiceName ? String(b.voiceName).slice(0, 100) : null),
      model_id: MODEL_ID,
      settings_json: JSON.stringify(settings),
      status: 'queued',
      tags: normalizeTags(b.tags).join(','),
      created_at: Date.now(),
    });
    runner.enqueue(id);
    res.status(201).json({ duplicate: false, generation: store.get(id) });
  });

  r.patch('/generations/:id', (req, res) => {
    if (!findOwned(req)) throw httpError(404, 'Not found');
    const b = req.body || {};
    const patch = {};
    if (b.title !== undefined) {
      const title = String(b.title).trim().slice(0, 120);
      if (!title) throw httpError(400, 'Title cannot be empty.');
      patch.title = title;
    }
    if (b.tags !== undefined) patch.tags = normalizeTags(b.tags).join(',');
    if (b.favorite !== undefined) patch.favorite = b.favorite ? 1 : 0;
    store.update(req.params.id, patch);
    res.json(store.get(req.params.id));
  });

  r.delete('/generations/:id', (req, res) => {
    const row = findOwned(req);
    if (!row) throw httpError(404, 'Not found');
    const projectRemoved = removeLesson(row, { project: ['1', 'true'].includes(String(req.query.project)) });
    res.json({ ok: true, projectRemoved });
  });

  r.get('/generations/:id/audio', (req, res) => {
    const row = findOwned(req);
    if (!row || row.status !== 'done' || row.kind === 'video') throw httpError(404, 'Audio not available');
    const file = store.audioPath(row.id);
    if (!fs.existsSync(file)) throw httpError(404, 'Audio file is missing on disk');
    if (req.query.download) {
      res.attachment(`${slugify(row.title)}.mp3`);
    }
    res.type('audio/mpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    res.sendFile(file, { dotfiles: 'allow' }); // sendFile handles Range requests, so seeking works
  });

  r.get('/generations/:id/script', (req, res) => {
    const row = findOwned(req);
    if (!row) throw httpError(404, 'Not found');
    if (req.query.download) res.attachment(`${slugify(row.title, 'script')}.txt`);
    res.type('text/plain; charset=utf-8').send(row.text);
  });

  return r;
}
