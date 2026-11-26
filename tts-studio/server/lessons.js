import fs from 'node:fs';
import path from 'node:path';
import { countWords } from './text.js';
import { PROJECT_NAME, readProject } from './video.js';
import { VIDEO_QUALITIES } from '../shared/limits.js';
import { filesIn, hashOf, readProjectText } from './edits.js';
import { chapterDir } from './versions.js';
import { WAITING_STAGE } from '../author/jobs.js';

/**
 * Follows lessons through the lesson writer's job queue (author/jobs.js).
 *
 * A lesson is a video whose script and scenes Claude writes from a topic and notes.
 * Writing takes minutes and needs no Kokoro, so it does not wait in the runner's
 * queue: the row sits at "processing" with a stage, and joins the queue as an
 * ordinary video build once its project is ready.
 */
export function createLessons({ store, runner, getConfig, jobs, versions = null, settings = null }) {
  const watching = new Map(); // generation id -> { jobId, kind, ... }
  // What the Owner's allowance for the host's sign-in and keys is held back for lessons that are running, so lessons
  // started together cannot each be given all of it. Set in the same step as it is read, released when the lesson stops.
  const reservations = new Map(); // generation id -> { profileId, hostUsd, monthUsd }

  function unwatch(id) {
    watching.delete(id);
    reservations.delete(id);
    if (!watching.size) jobs.events.off('change', onJobChange); // nothing left to follow, so nothing is listening
  }

  /**
   * Follow a lesson's job. One listener serves every lesson, and it is only attached while some lesson is
   * being followed: a listener for each lesson would pass the emitter's limit of ten with a few lessons at once.
   */
  function follow(id, watch) {
    // Every job starts at the same placeholder stage, which the row already shows or has replaced on purpose (a check
    // says what it is checking). Anything else the writer has said since, even before we listened, is passed on.
    watching.set(id, { ...watch, stage: WAITING_STAGE });
    jobs.events.off('change', onJobChange); // never twice
    jobs.events.on('change', onJobChange);
    // The writer may have moved on (or lost the job) between submitting it and our listening, so look once now.
    settle(id, jobs.get(watch.jobId));
  }

  function onJobChange(job) {
    for (const [id, watch] of watching) {
      if (watch.jobId === job.id) return settle(id, job);
    }
  }

  /**
   * What the writer records as each of this lesson's requests completes: one spend row, as it happens. Nothing waits for
   * the job to end, so an attempt that fails, is cancelled, or is cut off by a restart has already paid into the month's
   * total and the Owner's allowance, and a Retry finds what it spent in the table.
   */
  const recorder = (id, profileId) => ({ costUsd, hostFunded, step, provider }) => {
    store.spend.add({ profileId, generationId: id, costUsd, hostUsd: hostFunded ? costUsd : 0, step, provider });
  };

  /**
   * What goes with a job to the writer besides its plan: what this lesson's failed attempts already spent, which the job
   * continues from (so a Retry stays within the same per-lesson cap), and where to record each request. Spending that a
   * finished job has already counted (an outline or a narration waiting to be approved) is not carried: each job
   * has its own cap, as it always did.
   */
  const spendFor = (id, profileId) => {
    const before = store.spend.open(id);
    return { spentBefore: before.usd, hostBefore: before.host, onSpend: recorder(id, profileId) };
  };

  function fail(id, message) {
    unwatch(id);
    store.update(id, { status: 'error', error: message, stage: null, finished_at: Date.now() });
  }

  /**
   * True once the project's scenes (every chapter's, for a long lesson) are written and passed
   * their check, so a retry only needs to build it. An outline or a narration alone is not.
   */
  function isWritten(project) {
    const root = path.join(getConfig().videoDir, 'projects', project);
    try {
      const done = JSON.parse(fs.readFileSync(path.join(root, 'author.json'), 'utf8'));
      return !['outline', 'script'].includes(done.phase);
    } catch {
      return false;
    }
  }

  /**
   * What the writer does next: for a long lesson, its outline (when the person reviews it) and then
   * its chapters; for a narration approved first, the narration and then the scenes.
   */
  const phaseOf = (lesson) => {
    if (lesson?.chaptered) return lesson.outlineReview && !lesson.outlineApproved ? 'outline' : undefined;
    return lesson?.review === 'script' ? (lesson.scriptApproved ? 'scenes' : 'script') : undefined;
  };

  /**
   * Who writes each step, and what the lesson may still spend, from Settings as they are now.
   * A retry gets them afresh, so a raised cap or a newly set up provider applies.
   */
  async function writerFor(lesson = {}, profileId, lessonId = null) {
    if (!settings) return {};
    const mine = settings.for(profileId); // the lesson's owner's writer, keys and caps
    const writer = mine.resolveWriter(lesson.origin || lesson.profile || 'page', lesson.writer || null);
    await mine.checkWriter(writer);
    const { lessonCapUsd, monthCapUsd } = mine.costs();
    // The one thing that waits (a key lookup) comes first. From here to the reservation nothing awaits, so lessons
    // started together are decided one after another and cannot each be given the whole of what is left.
    const allowance = await mine.hostAllowance(writer, 0);
    // Without this lesson's own failed attempts: the job counts those itself (spentBefore, from the same rows), so
    // leaving them in here as well would hold the retry to them twice.
    const spentNow = store.stats(profileId, { excludeId: lessonId });
    const others = [...reservations].filter(([rid, hold]) => rid !== lessonId && hold.profileId === profileId).map(([, hold]) => hold);
    const held = (field) => others.reduce((n, hold) => n + (hold[field] || 0), 0);
    let capUsd = lessonCapUsd;
    let monthLeft = null;
    if (monthCapUsd != null) {
      const left = Math.round((monthCapUsd - spentNow.costThisMonthUsd) * 100) / 100;
      monthLeft = Math.round((left - held('monthUsd')) * 100) / 100;
      if (monthLeft <= 0) {
        throw new Error(left > 0
          ? 'Your other lessons may spend what is left of this month’s cap. Press Retry when they have finished.'
          : `This month's lessons have reached the monthly cap of $${monthCapUsd.toFixed(2)}. Raise it in Settings → Costs, then press Retry.`);
      }
      capUsd = capUsd == null ? monthLeft : Math.min(capUsd, monthLeft);
    }
    // The Owner's limit on what this profile spends with the host's own sign-in and keys. The job is held to what is
    // left of it (less what its other running lessons may still spend), whichever writer it starts with.
    let hostCapUsd = null;
    if (allowance) {
      const left = Math.max(0, Math.round((allowance.capUsd - spentNow.hostSpentThisMonthUsd) * 100) / 100);
      hostCapUsd = Math.max(0, Math.round((left - held('hostUsd')) * 100) / 100);
      if (allowance.usesHost && hostCapUsd <= 0) {
        throw new Error(left > 0
          ? 'Your other lessons are using the allowance the Owner set for this computer’s Claude sign-in and keys. Press Retry when they have finished.'
          : `${mine.hostAllowanceMessage({ ...allowance, leftUsd: left })} Then press Retry.`);
      }
    }
    if (lessonId && (hostCapUsd != null || monthLeft != null)) reservations.set(lessonId, { profileId, hostUsd: hostCapUsd || 0, monthUsd: capUsd ?? 0 });
    return { writer, capUsd, hostCapUsd };
  }

  /**
   * Hand a lesson to the writer and start following it. `brief` is { topic, goal, notes,
   * minutes, voice, visualReview }; leave it out to retry with the brief saved in the project.
   */
  async function start(id, brief, extra = {}) {
    const row = store.getRaw(id);
    const { project, lesson } = JSON.parse(row.settings_json);
    store.update(id, {
      status: 'processing', stage: WAITING_STAGE, error: null,
      progress_done: 0, progress_total: 0, finished_at: null,
    });
    let plan;
    try {
      plan = await writerFor(lesson, row.profile_id, id);
    } catch (e) {
      return fail(id, e.message);
    }
    let job;
    try {
      const phase = phaseOf(lesson);
      const { onSpend, ...carried } = spendFor(id, row.profile_id);
      job = jobs.submit({ project, ...brief, ...plan, ...carried, ...(phase ? { phase } : {}), ...extra }, { onSpend });
    } catch (e) {
      return fail(id, e.message);
    }
    follow(id, { jobId: job.id });
  }

  /** The job changed (or was just looked at): finish the lesson if the job has ended, else show its stage. */
  function settle(id, job) {
    const watch = watching.get(id);
    if (!watch) return;
    if (!job) return fail(id, 'The lesson writer lost this lesson. Press Retry.');
    if (watch.kind === 'revise') {
      if (job.status === 'done') return finishRevise(id, job.result, watch);
      if (job.status === 'error') return endRevise(id, watch, job.error || 'The revision could not be made.');
      if (job.status === 'cancelled') return endRevise(id, watch, null);
    }
    if (watch.kind === 'check') {
      if (job.status === 'done') return finishCheck(id, job.result, watch);
      if (job.status === 'error') return endCheck(id, watch, { ok: false, error: job.error || 'The check could not run.' });
      if (job.status === 'cancelled') return endCheck(id, watch, null);
    }
    if (job.status === 'done') return finish(id, job.result);
    if (job.status === 'error') return fail(id, job.error || 'The lesson could not be written.');
    if (job.status === 'cancelled') {
      unwatch(id);
      return store.update(id, { status: 'cancelled', error: 'Cancelled', stage: null, finished_at: Date.now() });
    }
    if (job.stage !== watch.stage) {
      watch.stage = job.stage;
      store.update(id, { stage: job.stage });
    }
  }

  /**
   * The project is written and checked: fill in the row, make it a version, and queue the
   * build, or stop at the storyboard when the person asked to see it first.
   */
  function finish(id, result) {
    unwatch(id);
    const row = store.getRaw(id);
    if (!row) return;
    // The job is over, and its result counts what it and the attempts before it spent. Those rows wait for a version
    // to take them (or, for an outline or narration, for the approval), and a later job does not continue from them.
    store.spend.settle(id);
    const settings = JSON.parse(row.settings_json);
    const project = readProject(getConfig().videoDir, settings.project);
    const script = project?.script || result.script || row.text;
    if (result.phase === 'outline') {
      // A long lesson waits for its outline to be looked over before any chapter is written.
      const o = result.outline;
      const minutes = o.chapters.reduce((t, c) => t + c.minutes, 0);
      settings.lesson = {
        ...settings.lesson,
        phase: 'outline',
        chapters: o.chapters.map(({ id, title, minutes: m }) => ({ id, title, minutes: m })),
      };
      return store.update(id, {
        ...(settings.lesson.ownTitle ? {} : { title: String(o.title || row.title).slice(0, 120) }),
        settings_json: JSON.stringify(settings),
        status: 'awaiting',
        stage: `Outline ready: ${o.chapters.length} chapters, about ${minutes} minutes`,
      });
    }
    // The totals stay on the row; each request's figures are in the version and in author.json.
    const usage = result.usage ? { ...result.usage } : null;
    if (usage) delete usage.requests;
    if (result.phase === 'script') {
      // The narration waits for the person; the scenes are written once it is approved.
      settings.lesson = { ...settings.lesson, phase: 'script', writtenBy: result.writtenBy || [] };
      return store.update(id, {
        ...(settings.lesson.ownTitle ? {} : { title: String(result.title || row.title).slice(0, 120) }),
        text: script,
        char_count: script.length,
        word_count: countWords(script),
        settings_json: JSON.stringify(settings),
        status: 'awaiting',
        stage: 'Narration ready: have a look',
      });
    }
    // What this version cost is whatever the lesson has spent that no version has: this job, the attempts before it,
    // and a narration or outline approved first. The version takes those rows below, and its cost is read from them.
    Object.assign(settings, {
      scenes: result.scenes,
      lesson: {
        ...settings.lesson,
        fixes: result.fixes,
        autofixed: result.autofixed?.length || 0,
        polished: result.polished,
        warnings: result.warnings?.length || 0,
        usage,
        phase: null,
        ...(result.chapters ? { chapters: result.chapters } : {}),
        ...(result.writtenBy ? { writtenBy: [...(settings.lesson.writtenBy || []).filter((w) => w.step === 'write' && settings.lesson.phase === 'script'), ...result.writtenBy] } : {}),
      },
    });
    const review = settings.lesson.review === 'storyboard';
    store.update(id, {
      // Keep a title the person typed; otherwise use the one Claude gave the video.
      ...(settings.lesson.ownTitle ? {} : { title: String(result.title || row.title).slice(0, 120) }),
      text: script,
      char_count: script.length,
      word_count: countWords(script),
      settings_json: JSON.stringify(settings),
      status: review ? 'awaiting' : 'queued',
      stage: review ? 'Storyboard ready: have a look' : null,
    });
    try {
      versions?.snapshot(id, {
        source: 'written',
        usage: result.usage || null,
        takesSpend: true,
        check: { ok: true, warnings: result.warnings?.length || 0 },
      });
    } catch (e) {
      console.error(`Could not keep version files for ${settings.project}: ${e.message}`);
    }
    if (!review) runner.enqueue(id);
  }

  /**
   * Check a lesson's edited files in full: the narration is spoken and every scene run without
   * drawing, leaving a fresh storyboard. With then: 'build', a passing check makes the next
   * version and builds it. Either way the lesson goes back to where it was while it is checked,
   * so a built lesson keeps playing its video.
   */
  async function checkEdit(id, { then = null, quality = null, chapter = null } = {}) {
    const row = store.getRaw(id);
    const { project } = JSON.parse(row.settings_json);
    const prior = { status: row.status, stage: row.stage, error: row.error, finished_at: row.finished_at };
    store.update(id, { status: 'processing', stage: then === 'build' ? 'Checking your changes before rendering' : 'Checking your changes', error: null, progress_done: 0, progress_total: 0 });
    let job;
    try {
      job = jobs.submit({ project, kind: 'check', ...(chapter ? { chapter } : {}) });
    } catch (e) {
      reservations.delete(id); // it never started, so it holds nothing
      store.update(id, prior);
      throw Object.assign(new Error(e.message), { status: e.status || 400 });
    }
    follow(id, { jobId: job.id, kind: 'check', prior, then, quality, chapter });
  }

  function saveCheck(id, report, summary, chapter = null) {
    const row = store.getRaw(id);
    if (!row) return null;
    const settings = JSON.parse(row.settings_json);
    const lessonRoot = path.join(getConfig().videoDir, 'projects', settings.project);
    const root = chapterDir(lessonRoot, chapter);
    if (report) {
      fs.mkdirSync(path.join(root, 'build', 'check'), { recursive: true });
      fs.writeFileSync(path.join(root, 'build', 'check', 'report.json'), JSON.stringify({ ...report, at: Date.now() }));
      if (report.scenes?.length && !chapter) settings.scenes = report.scenes;
    }
    settings.edit = { checkedAt: Date.now(), ...summary, ...(chapter ? { chapter } : {}) };
    return { settings, root, lessonRoot };
  }

  /** The check finished: keep its report, then build the edit as the next version or go back to where it was. */
  function finishCheck(id, report, watch) {
    unwatch(id);
    const saved = saveCheck(id, report, { ok: !!report.ok, errors: report.errors?.length || 0, warnings: report.warnings?.length || 0 }, watch.chapter);
    if (!saved) return;
    const { settings, root, lessonRoot } = saved;
    if (watch.then === 'build' && report.ok) {
      const script = readProject(getConfig().videoDir, settings.project)?.script || readProjectText(lessonRoot);
      if (VIDEO_QUALITIES.includes(watch.quality)) settings.quality = watch.quality;
      store.update(id, { settings_json: JSON.stringify(settings), text: script, char_count: script.length, word_count: countWords(script) });
      try {
        // Files the same as the current version (one whose build failed, say) build that version again.
        const row = store.getRaw(id);
        const current = row.version ? chapterDir(path.join(lessonRoot, 'versions', String(row.version).padStart(3, '0')), watch.chapter) : null;
        const same = current && fs.existsSync(current) && hashOf(filesIn(current)) === hashOf(filesIn(root));
        if (!same) versions?.snapshot(id, { source: 'edited', note: 'Edited in the dashboard', check: { ok: true, warnings: report.warnings?.length || 0 } });
      } catch (e) {
        console.error(`Could not keep version files for ${settings.project}: ${e.message}`);
      }
      store.update(id, { status: 'queued', stage: null, error: null, progress_done: 0, finished_at: null });
      return runner.enqueue(id);
    }
    store.update(id, { settings_json: JSON.stringify(settings), ...watch.prior });
  }

  function endCheck(id, watch, failure) {
    unwatch(id);
    const saved = failure ? saveCheck(id, null, failure, watch.chapter) : null;
    store.update(id, { ...(saved ? { settings_json: JSON.stringify(saved.settings) } : {}), ...watch.prior });
  }

  /**
   * Ask the writer for a change to a written lesson: { request, scope, attachments, history,
   * review }. The lesson keeps playing its built video meanwhile; a revision that fails or is
   * cancelled leaves the files as the current version has them.
   */
  async function revise(id, { request, scope, chapter = null, attachments = [], history = [], review = 'render' }) {
    const row = store.getRaw(id);
    const settings = JSON.parse(row.settings_json);
    const prior = { status: row.status, stage: row.stage, error: row.error, finished_at: row.finished_at };
    store.update(id, { status: 'processing', stage: WAITING_STAGE, error: null, progress_done: 0, progress_total: 0 });
    let job;
    try {
      const plan = await writerFor(settings.lesson, row.profile_id, id);
      const { onSpend, ...carried } = spendFor(id, row.profile_id);
      job = jobs.submit({ project: settings.project, kind: 'revise', request, scope, attachments, history, ...(chapter ? { chapter } : {}), ...plan, ...carried }, { onSpend });
    } catch (e) {
      reservations.delete(id); // it never started, so it holds nothing
      store.update(id, prior);
      throw Object.assign(new Error(e.message), { status: e.status || 400 });
    }
    follow(id, { jobId: job.id, kind: 'revise', prior, review, request, scope, chapter });
  }

  /** The revision is written and checked: it becomes the next version, then renders or waits at its storyboard. */
  function finishRevise(id, result, watch) {
    unwatch(id);
    const row = store.getRaw(id);
    if (!row) return;
    store.spend.settle(id); // as in finish(): the job's result has counted it
    const settings = JSON.parse(row.settings_json);
    const project = readProject(getConfig().videoDir, settings.project);
    const script = project?.script || row.text;
    const usage = result.usage ? { ...result.usage } : null;
    if (usage) delete usage.requests;
    if (!watch.chapter) settings.scenes = result.scenes || settings.scenes;
    settings.lastRevision = { request: watch.request, summary: result.summary || '', at: Date.now(), ok: true };
    store.update(id, { text: script, char_count: script.length, word_count: countWords(script), settings_json: JSON.stringify(settings) });
    try {
      versions?.snapshot(id, {
        source: 'revised',
        note: watch.request,
        usage: result.usage || null,
        takesSpend: true,
        check: { ok: true, warnings: result.warnings?.length || 0 },
        details: {
          request: watch.request,
          summary: result.summary || '',
          scope: result.scope || watch.scope || { kind: 'lesson' },
          ...(watch.chapter ? { chapter: watch.chapter } : {}),
          changed: result.changed || {},
          outsideScope: result.outsideScope || [],
          fixes: result.fixes || 0,
          polished: !!result.polished,
          writtenBy: result.writtenBy || [],
        },
      });
    } catch (e) {
      console.error(`Could not keep version files for ${settings.project}: ${e.message}`);
    }
    if (watch.review === 'storyboard') return store.update(id, { status: 'awaiting', stage: 'Storyboard ready: have a look', error: null });
    store.update(id, { status: 'queued', stage: null, error: null, progress_done: 0, finished_at: null });
    runner.enqueue(id);
  }

  function endRevise(id, watch, error) {
    unwatch(id);
    const row = store.getRaw(id);
    if (!row) return;
    if (row.version) versions?.resetTo(id, row.version);
    const settings = JSON.parse(row.settings_json);
    settings.lastRevision = { request: watch.request, error: error || 'Cancelled', at: Date.now(), ok: false };
    store.update(id, { settings_json: JSON.stringify(settings), ...watch.prior });
  }

  /** Stop following a lesson and tell the writer to stop too. Returns true if it was being written or checked. */
  function cancel(id) {
    const watch = watching.get(id);
    if (!watch) return false;
    // Let go first: cancelling a waiting job announces it at once, and this function settles the lesson itself.
    watching.delete(id);
    if (!watching.size) jobs.events.off('change', onJobChange);
    jobs.cancel(watch.jobId);
    if (watch.kind === 'check') {
      endCheck(id, watch, null); // a cancelled check leaves the lesson as it was
      return true;
    }
    if (watch.kind === 'revise') {
      endRevise(id, watch, null); // so does a cancelled revision, files included
      return true;
    }
    unwatch(id);
    store.update(id, { status: 'cancelled', error: 'Cancelled', stage: null, finished_at: Date.now() });
    return true;
  }

  function stop() {
    watching.clear();
    jobs.events.off('change', onJobChange);
  }

  /**
   * Before the spend table, a running job kept its total in build/author/spent.json in the project, and a lesson's
   * settings took it from there when the job failed. A lesson the server was stopped under (or killed) never got that far,
   * so its file can hold more than the migration found on the lesson. Take the difference into the table, once, and
   * remove the file: the new writer never makes one. A file that holds nothing more is just removed. Safe to run again.
   * Returns how many lessons had a file.
   */
  function importLegacySpend() {
    let found = 0;
    for (const g of store.db.prepare("SELECT id, profile_id, settings_json FROM generations WHERE settings_json LIKE '%\"lesson\"%'").all()) {
      let project;
      try {
        project = JSON.parse(g.settings_json).project;
      } catch {
        continue;
      }
      if (!PROJECT_NAME.test(String(project))) continue;
      const file = path.join(getConfig().videoDir, 'projects', project, 'build', 'author', 'spent.json');
      let spent;
      let at;
      try {
        spent = JSON.parse(fs.readFileSync(file, 'utf8'));
        at = fs.statSync(file).mtimeMs; // when its last request finished: the month it belongs to
      } catch {
        if (fs.existsSync(file)) fs.rmSync(file, { force: true }); // unreadable: nothing in it to count
        continue;
      }
      found += 1;
      const known = store.spend.open(g.id); // the migration took the failed attempts' share from the lesson's settings
      const usd = Math.max(0, (Number(spent.usd) || 0) - known.usd);
      const host = Math.max(0, (Number(spent.hostUsd) || 0) - known.host);
      store.db.transaction(() => {
        if (usd > 0 || host > 0) store.spend.add({ profileId: g.profile_id, generationId: g.id, costUsd: usd, hostUsd: host, at, step: 'before the spend table' });
        fs.rmSync(file, { force: true });
      })();
    }
    return found;
  }

  return { start, checkEdit, revise, cancel, stop, importLegacySpend, isWritten, isActive: (id) => watching.has(id) };
}
