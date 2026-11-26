import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { slugify } from './text.js';
import { makePoster } from './video.js';
import { httpError } from './route-helpers.js';

/** A lesson's files: the video, its poster and captions, transcript, narration, notes, and where they sit on disk. */
export function lessonFilesRoutes({ store, versions, getConfig, helpers }) {
  const r = express.Router();
  const { findOwned } = helpers;
  const posters = new Map(); // generation id -> in-flight poster

  r.get('/generations/:id/video', (req, res) => {
    const row = findOwned(req);
    if (!row || row.kind !== 'video' || row.status !== 'done') throw httpError(404, 'Video not available');
    const file = store.videoPath(row.id);
    if (!fs.existsSync(file)) throw httpError(404, 'Video file is missing on disk');
    if (req.query.download) res.attachment(`${slugify(row.title)}.mp4`);
    res.type('video/mp4');
    res.set('Cache-Control', 'private, max-age=3600');
    res.sendFile(file, { dotfiles: 'allow' });
  });

  // A still from the video, for its card. A video built before posters existed gets one
  // made the first time its card is shown.
  r.get('/generations/:id/poster', async (req, res) => {
    const row = findOwned(req);
    if (!row || row.kind !== 'video' || row.status !== 'done') throw httpError(404, 'No poster');
    const file = store.videoPath(row.id, 'jpg');
    if (!fs.existsSync(file)) {
      const video = store.videoPath(row.id);
      if (!fs.existsSync(video)) throw httpError(404, 'No poster');
      if (!posters.has(row.id)) {
        posters.set(row.id, makePoster(video, file, row.duration_sec).finally(() => posters.delete(row.id)));
      }
      if (!(await posters.get(row.id))) throw httpError(404, 'No poster');
    }
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(file, { dotfiles: 'allow' });
  });

  // One of the images or PDFs attached to a lesson's notes.
  r.get('/generations/:id/notes/:file', (req, res) => {
    const row = findOwned(req);
    const settings = row ? JSON.parse(row.settings_json) : null;
    const wanted = settings?.lesson?.attachments?.find((a) => path.basename(a.file) === req.params.file);
    if (!wanted) throw httpError(404, 'No such file');
    const file = path.join(getConfig().videoDir, 'projects', settings.project, 'notes', path.basename(wanted.file));
    if (!fs.existsSync(file)) throw httpError(404, 'That file is no longer on disk');
    res.set('Cache-Control', 'private, max-age=3600');
    res.sendFile(file, { dotfiles: 'allow' });
  });

  r.get('/generations/:id/captions.:ext', (req, res) => {
    const row = findOwned(req);
    const ext = req.params.ext;
    if (!row || row.kind !== 'video' || row.status !== 'done' || !['srt', 'vtt'].includes(ext)) throw httpError(404, 'Captions not available');
    const file = store.videoPath(row.id, ext);
    if (!fs.existsSync(file)) throw httpError(404, 'Captions file is missing on disk');
    if (req.query.download) res.attachment(`${slugify(row.title)}.${ext}`);
    res.type(ext === 'vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8');
    res.sendFile(file, { dotfiles: 'allow' });
  });

  // One block's narration, as the check spoke it.
  r.get('/generations/:id/narration/:block', (req, res) => {
    const row = findOwned(req);
    const chapter = req.query.chapter ? String(req.query.chapter) : null;
    if (chapter && !/^\d{2}-[a-z0-9-]{1,48}$/.test(chapter)) throw httpError(404, 'Not found');
    const lessonRoot = row && versions?.projectRoot(row);
    const root = lessonRoot && (chapter ? path.join(lessonRoot, 'chapters', chapter) : lessonRoot);
    const block = String(req.params.block);
    if (!root || !/^[A-Za-z0-9_-]{1,80}$/.test(block)) throw httpError(404, 'Not found');
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(root, 'build', 'manifest.json'), 'utf8'));
    } catch {
      throw httpError(404, 'This lesson has not been spoken yet');
    }
    const wav = manifest.blocks?.[block]?.wav;
    const audio = wav && path.resolve(root, 'build', wav);
    if (!audio || !audio.startsWith(path.resolve(root, 'build', 'audio') + path.sep) || !fs.existsSync(audio)) throw httpError(404, 'No narration for that block');
    res.type('audio/wav');
    res.set('Cache-Control', 'private, max-age=60');
    res.sendFile(audio, { dotfiles: 'allow' });
  });

  // A long lesson's chapters as WebVTT, for the player's chapter list.
  r.get('/generations/:id/chapters.vtt', (req, res) => {
    const row = findOwned(req);
    const file = row && store.videoPath(row.id, 'chapters.vtt');
    if (!file || !fs.existsSync(file)) throw httpError(404, 'This video has no chapters.');
    res.type('text/vtt; charset=utf-8').sendFile(file, { dotfiles: 'allow' });
  });

  // Every spoken word of the built video with its time, for the transcript beside the player.
  r.get('/generations/:id/transcript', (req, res) => {
    const row = findOwned(req);
    const file = row && store.videoPath(row.id, 'words.json');
    if (!row || row.kind !== 'video' || (!row.built_version && row.status !== 'done') || !fs.existsSync(file)) throw httpError(404, 'No transcript for this video. Lessons built from now on have one.');
    res.set('Cache-Control', 'private, max-age=60');
    res.type('application/json').sendFile(file, { dotfiles: 'allow' });
  });

  // Where a lesson's files are on this machine, for the MCP connector and anything else local.
  r.get('/generations/:id/files', (req, res) => {
    const row = findOwned(req);
    if (!row) throw httpError(404, 'Not found');
    const has = (f) => (fs.existsSync(f) ? f : null);
    const settings = JSON.parse(row.settings_json);
    res.json({
      video: row.kind === 'video' ? has(store.videoPath(row.id)) : null,
      captions: row.kind === 'video' ? { srt: has(store.videoPath(row.id, 'srt')), vtt: has(store.videoPath(row.id, 'vtt')) } : null,
      poster: row.kind === 'video' ? has(store.videoPath(row.id, 'jpg')) : null,
      audio: row.kind !== 'video' ? has(store.audioPath(row.id)) : null,
      project: settings.project ? has(path.join(getConfig().videoDir, 'projects', settings.project)) : null,
    });
  });

  return r;
}
