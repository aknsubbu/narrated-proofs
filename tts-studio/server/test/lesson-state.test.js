import test from 'node:test';
import assert from 'node:assert/strict';
import { approved, can, check, LessonStateError, nextPhase, stateOf, STATUSES, to } from '../lesson-state.js';

const row = (status, phase) => ({ status, settings_json: JSON.stringify({ project: 'p', lesson: phase === undefined ? {} : { phase } }) });

test('an awaiting lesson says what it waits for; any other state waits for nothing', () => {
  assert.deepEqual(stateOf(row('awaiting', 'outline')), { status: 'awaiting', waitingFor: 'outline' });
  assert.deepEqual(stateOf(row('awaiting', 'script')), { status: 'awaiting', waitingFor: 'narration' });
  assert.deepEqual(stateOf(row('awaiting', null)), { status: 'awaiting', waitingFor: 'storyboard' });
  assert.deepEqual(stateOf(row('awaiting')), { status: 'awaiting', waitingFor: 'storyboard' });
  // A phase left on a lesson that has moved on means nothing.
  for (const status of STATUSES.filter((s) => s !== 'awaiting')) assert.deepEqual(stateOf(row(status, 'outline')), { status, waitingFor: null });
  assert.deepEqual(stateOf({ status: 'awaiting', settings_json: 'not json' }), { status: 'awaiting', waitingFor: 'storyboard' });
});

test('each action is allowed from exactly the states it names', () => {
  const states = [...STATUSES.filter((s) => s !== 'awaiting').map((s) => [s]), ['awaiting', 'outline'], ['awaiting', 'script'], ['awaiting', null]];
  const allowed = {
    retry: ['error', 'cancelled'],
    approve: ['awaiting/outline', 'awaiting/script', 'awaiting/null'],
    editOutline: ['awaiting/outline'],
  };
  for (const [action, from] of Object.entries(allowed)) {
    for (const [status, phase] of states) {
      const name = phase === undefined ? status : `${status}/${phase}`;
      assert.equal(can(row(status, phase), action), from.includes(name), `${action} from ${name}`);
    }
  }
  assert.throws(() => can(row('done'), 'explode'), /Unknown lesson action/);
});

test('a refused action says why, as a 409', () => {
  const refusal = (r, action) => {
    try {
      check(r, action);
      return null;
    } catch (e) {
      assert.ok(e instanceof LessonStateError);
      return [e.status, e.message];
    }
  };
  assert.deepEqual(refusal(row('done'), 'retry'), [409, 'Only failed or cancelled items can be retried.']);
  assert.deepEqual(refusal(row('processing'), 'approve'), [409, 'This lesson is not waiting for approval.']);
  assert.deepEqual(refusal(row('awaiting', 'script'), 'editOutline'), [409, 'The outline can be changed only while it waits for you, before the chapters are written.']);
  assert.equal(refusal(row('error'), 'retry'), null);
});

test('the writer goes on from what the person has approved', () => {
  assert.equal(nextPhase({ chaptered: true, outlineReview: true }), 'outline');
  assert.equal(nextPhase(approved({ chaptered: true, outlineReview: true, phase: 'outline' }, 'outline')), undefined, 'then the chapters');
  assert.equal(nextPhase({ chaptered: true }), undefined, 'an outline nobody reviews is written with the chapters');
  assert.equal(nextPhase({ review: 'script' }), 'script');
  assert.equal(nextPhase(approved({ review: 'script', phase: 'script' }, 'narration')), 'scenes');
  assert.equal(nextPhase({ review: 'render' }), undefined);
  assert.equal(nextPhase(undefined), undefined);
  assert.equal(approved({ phase: 'outline' }, 'outline').phase, null, 'no longer waiting on it');
  assert.deepEqual(approved({ a: 1 }, 'storyboard'), { a: 1 }, 'a storyboard approval changes nothing the writer reads');
});

test('every move into a state leaves the row the same way, and extras add to it', () => {
  assert.deepEqual(to.queued(), { status: 'queued', stage: null, error: null, progress_done: 0, finished_at: null });
  assert.deepEqual(to.processing('Writing'), { status: 'processing', stage: 'Writing', error: null, progress_done: 0, progress_total: 0 });
  assert.deepEqual(to.awaiting('Narration ready'), { status: 'awaiting', stage: 'Narration ready', error: null });
  const failed = to.failed('It broke');
  assert.deepEqual({ ...failed, finished_at: 0 }, { status: 'error', error: 'It broke', stage: null, finished_at: 0 });
  assert.ok(failed.finished_at > 0);
  assert.equal(to.cancelled().error, 'Cancelled');
  assert.equal(to.done().status, 'done');
  assert.deepEqual(to.queued({ settings_json: '{}' }).settings_json, '{}');
  assert.equal(to.processing('x', { finished_at: null }).finished_at, null);
});
