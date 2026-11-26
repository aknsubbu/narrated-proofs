import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createStore } from '../db.js';
import { createLessons } from '../lessons.js';
import { createProfiles } from '../profiles.js';

/** How lessons.js learns of the writer's jobs: by their events, with one look at the job when it starts following it. */
let dir, store, ownerId, lessons, jobs, table, cancelled;
let seq = 0;

const row = (id) => ({
  id, profile_id: ownerId, kind: 'video', title: id, source_name: `video/projects/${id}`, text: 'x', text_hash: id, config_hash: id, char_count: 1, word_count: 1,
  voice_id: 'af_heart', voice_name: null, model_id: 'm', status: 'queued', tags: '', created_at: Date.now(),
  settings_json: JSON.stringify({ project: id, quality: 'low', scenes: [], lesson: { topic: 't', review: 'render' } }),
});
const stateOf = (id) => store.getRaw(id);
const listeners = () => jobs.events.listenerCount('change');
/** A job as the queue would show it: what is set here is what jobs.get answers, and what a test can then announce. */
const make = (props = {}) => {
  const job = { id: `job-${++seq}`, kind: 'write', status: 'working', stage: 'Waiting for the lesson writer', error: null, result: null, ...props };
  table.set(job.id, job);
  return job;
};
const change = (job, props) => {
  Object.assign(job, props);
  jobs.events.emit('change', { ...job });
};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'np-lessons-events-'));
  store = createStore(path.join(dir, 'data'));
  ownerId = createProfiles({ db: store.db, dataDir: path.join(dir, 'data') }).owner().id;
});
after(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const fresh = (next = () => make()) => {
  table = new Map();
  cancelled = [];
  jobs = { submit: () => next(), get: (id) => table.get(id) || null, cancel: (id) => { cancelled.push(id); }, events: new EventEmitter() };
  lessons = createLessons({ store, runner: { enqueue() {} }, getConfig: () => ({ videoDir: path.join(dir, 'video') }), jobs });
};
const insert = (id) => store.insert(row(id));
const brief = { topic: 't', goal: '', notes: '', minutes: 1, voice: 'af_heart', attachments: [] };

test('a stage the writer reports reaches the row, and nothing listens once the lesson ends', async () => {
  fresh();
  insert('e1');
  await lessons.start('e1', brief);
  assert.equal(listeners(), 1);
  assert.ok(lessons.isActive('e1'));
  const job = [...table.values()][0];
  change(job, { stage: 'Writing the lesson' });
  assert.equal(stateOf('e1').stage, 'Writing the lesson');
  change(job, { status: 'error', stage: 'Failed', error: 'Credit balance is too low' });
  assert.equal(stateOf('e1').status, 'error');
  assert.equal(stateOf('e1').error, 'Credit balance is too low');
  assert.equal(listeners(), 0);
  assert.ok(!lessons.isActive('e1'));
});

test('a job that ended before the listener was attached is not missed', async () => {
  fresh(() => make({ status: 'error', stage: 'Failed', error: 'Too quick' }));
  insert('e2');
  await lessons.start('e2', brief);
  assert.equal(stateOf('e2').status, 'error');
  assert.equal(stateOf('e2').error, 'Too quick');
  assert.equal(listeners(), 0);
});

test('a job that is gone leaves a lesson to retry', async () => {
  fresh(() => ({ id: 'vanished' }));
  insert('e3');
  await lessons.start('e3', brief);
  assert.equal(stateOf('e3').status, 'error');
  assert.equal(stateOf('e3').error, 'The lesson writer lost this lesson. Press Retry.');
  assert.equal(listeners(), 0);
});

test('a cancelled job cancels its lesson; a cancel by the person is settled once, and a late event is ignored', async () => {
  fresh();
  insert('e4');
  insert('e5');
  await lessons.start('e4', brief);
  const one = [...table.values()].at(-1);
  change(one, { status: 'cancelled', stage: 'Cancelled' });
  assert.equal(stateOf('e4').status, 'cancelled');
  assert.equal(listeners(), 0);

  await lessons.start('e5', brief);
  const two = [...table.values()].at(-1);
  assert.equal(lessons.cancel('e5'), true);
  assert.deepEqual(cancelled, [two.id]);
  assert.equal(stateOf('e5').status, 'cancelled');
  assert.equal(listeners(), 0);
  // The writer reports its job as done a moment after the person cancelled: the lesson stays cancelled.
  change(two, { status: 'done', result: { phase: 'scenes' } });
  assert.equal(stateOf('e5').status, 'cancelled');
  assert.equal(lessons.cancel('e5'), false);
});

test('a waiting job announced as cancelled during the person\'s own cancel is not settled twice', async () => {
  fresh();
  insert('e6');
  await lessons.start('e6', brief);
  const job = [...table.values()].at(-1);
  // The real queue announces a cancelled job from inside cancel(), before it returns.
  jobs.cancel = (id) => { cancelled.push(id); change(job, { status: 'cancelled', stage: 'Cancelled' }); };
  const updates = [];
  const update = store.update;
  store.update = (id, patch) => { updates.push(patch.status); return update(id, patch); };
  try {
    assert.equal(lessons.cancel('e6'), true);
  } finally {
    store.update = update;
  }
  assert.deepEqual(updates, ['cancelled']);
});

test('many lessons share one listener, and stop() lets go of it', async () => {
  fresh();
  const ids = Array.from({ length: 15 }, (_, i) => `m${i}`);
  for (const id of ids) {
    insert(id);
    await lessons.start(id, brief);
  }
  assert.equal(listeners(), 1, 'one listener, so the emitter never warns of a leak');
  const all = [...table.values()];
  change(all[3], { stage: 'Writing the lesson' });
  assert.equal(stateOf('m3').stage, 'Writing the lesson');
  assert.equal(stateOf('m4').stage, 'Waiting for the lesson writer', 'only the lesson that owns the job hears of it');
  for (const id of ids.slice(0, 14)) lessons.cancel(id);
  assert.equal(listeners(), 1, 'still one lesson being followed');
  lessons.stop();
  assert.equal(listeners(), 0);
  change(all[14], { status: 'done', result: {} });
  assert.equal(stateOf('m14').status, 'processing', 'a server shutting down leaves its lessons for the restart to settle');
});

test('a stage the writer reported before the lesson began to listen is shown at once', async () => {
  fresh(() => make({ stage: 'Waiting for another lesson to finish its check' }));
  insert('s1');
  await lessons.start('s1', brief);
  assert.equal(stateOf('s1').stage, 'Waiting for another lesson to finish its check');
});

test('a check keeps its own label while the job is still at the placeholder stage', async () => {
  fresh();
  insert('s2');
  await lessons.checkEdit('s2', { then: 'build' });
  assert.equal(stateOf('s2').stage, 'Checking your changes before rendering');
});
