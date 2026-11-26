import crypto from 'node:crypto';
import express from 'express';
import { countWords } from './text.js';
import { MODEL_ID } from './kokoro.js';
import { listProjects, readProject } from './video.js';
import { VIDEO_QUALITIES } from '../shared/limits.js';
import { httpError, normalizeTags, sha } from './route-helpers.js';

/** Videos built from a project folder written by hand, rather than from a lesson. */
export function videoProjectRoutes({ store, runner, engine, getConfig }) {
  const r = express.Router();

  /**
   * A project folder is one profile's when a lesson of theirs was written into it. A folder no
   * lesson claims (one written by hand) is the Owner's. Projects stay where build.py expects them;
   * who may see one lives in the database.
   */
  const canUseProject = (req, name) => {
    const claimed = store.projectOwners().get(name);
    return claimed ? claimed.has(req.profile.id) : req.profile.isOwner;
  };

  // Narrated videos: video/projects/<name>, built by video/build.py through the same queue.
  r.get('/video/projects', (req, res) => {
    const { videoDir } = getConfig();
    const projects = videoDir ? listProjects(videoDir).filter((p) => canUseProject(req, p.name)) : [];
    res.json({ projects: projects.map(({ name, voice, speed, scenes }) => ({ name, voice, speed, scenes })) });
  });

  r.post('/videos', (req, res) => {
    const b = req.body || {};
    const { videoDir } = getConfig();
    const project = videoDir && canUseProject(req, String(b.project || '')) ? readProject(videoDir, String(b.project || '')) : null;
    if (!project) throw httpError(404, `No video project called “${b.project}”.`);
    if (!project.scenes.length) throw httpError(400, `Project “${project.name}” lists no scenes in project.json.`);
    const quality = VIDEO_QUALITIES.includes(b.quality) ? b.quality : 'default';
    const id = crypto.randomUUID();
    store.insert({
      id,
      profile_id: req.profile.id,
      kind: 'video',
      title: String(b.title || '').trim().slice(0, 120) || `${project.name} (video)`,
      source_name: `video/projects/${project.name}`,
      text: project.script,
      text_hash: sha(project.script),
      config_hash: sha(`video:${id}`), // every build is new: the scenes may have changed
      char_count: project.script.length,
      word_count: countWords(project.script),
      voice_id: project.voice,
      voice_name: engine.catalog().voices.find((v) => v.voiceId === project.voice)?.name || null,
      model_id: MODEL_ID,
      settings_json: JSON.stringify({ project: project.name, quality, speed: project.speed, scenes: project.scenes }),
      status: 'queued',
      tags: normalizeTags(b.tags ?? ['video']).join(','),
      created_at: Date.now(),
    });
    runner.enqueue(id);
    res.status(201).json({ generation: store.get(id) });
  });

  return r;
}
