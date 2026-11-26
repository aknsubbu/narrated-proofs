/**
 * Where a lesson is in its life, and what may happen to it next. The one place that reads a lesson's state, so
 * the routes, the writer's callbacks and the edits all agree on it.
 *
 * A row keeps its state in two fields. `status` is one of:
 *
 *   queued      waiting for the renderer (or for the writer, until it picks the lesson up)
 *   processing  the writer, a check or the renderer is working on it
 *   awaiting    waiting for the person; settings.lesson.phase says for what (see WAITING)
 *   done        built; it plays
 *   error       stopped with a reason; Retry continues
 *   cancelled   stopped by the person; Retry continues
 *
 * and, while it is awaiting, `settings.lesson.phase` says what it waits on: 'outline' (a long lesson's chapters,
 * before they are written), 'script' (a narration to approve before the scenes are written), or nothing (its
 * storyboard, before it renders).
 *
 * The moves between them:
 *
 *   queued ─▶ processing ─▶ done ─(edit, revise)─▶ processing
 *                │    │
 *                │    └─▶ awaiting ─(approve)─▶ queued or processing
 *                │           │
 *                ▼           ▼ (cancel)
 *        error, cancelled ◀──┘ ─(retry)─▶ queued or processing
 *
 * The writer's flags `outlineApproved` and `scriptApproved` record what the person has approved, so a Retry picks
 * up after it; `nextPhase` is the only reader of them.
 */

export const STATUSES = ['queued', 'processing', 'awaiting', 'done', 'error', 'cancelled'];

/**
 * The status changes the server makes, from each status. A move to the same status is always allowed. The
 * store checks every status change against this: a move not listed throws under the tests, so a bug fails
 * there, and in use it is logged with the item and the move and still made, so nothing is left stuck because
 * this table missed a case. It holds for every item, not only lessons: audio and videos use the same statuses.
 */
export const MOVES = {
  queued: ['processing', 'cancelled', 'error'],
  processing: ['done', 'error', 'cancelled', 'awaiting', 'queued'],
  awaiting: ['queued', 'processing', 'cancelled'],
  done: ['processing', 'queued'],
  error: ['queued', 'processing', 'done'],
  cancelled: ['queued', 'processing', 'done'],
};

/** True when an item may go from status `from` to status `to`. */
export function canMove(from, to) {
  return from === to || Boolean(MOVES[from]?.includes(to));
}

/** What an awaiting lesson waits for, by its settings.lesson.phase. */
const WAITING = { outline: 'outline', script: 'narration' };

export class LessonStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LessonStateError';
    this.status = 409; // the request is fine; the lesson is not in a state to take it
  }
}

/** { status, waitingFor }: waitingFor is 'outline', 'narration' or 'storyboard' while awaiting, else null. */
export function stateOf(row) {
  if (row.status !== 'awaiting') return { status: row.status, waitingFor: null };
  let phase;
  try {
    phase = JSON.parse(row.settings_json || '{}').lesson?.phase;
  } catch {
    phase = undefined;
  }
  return { status: 'awaiting', waitingFor: WAITING[phase] || 'storyboard' };
}

/**
 * What the person may ask of a lesson, and from which states. Anything else is refused with the reason, before
 * any work starts. Cancel is not here: it is always accepted, and does nothing to a lesson that has stopped.
 */
const ACTIONS = {
  retry: { from: ['error', 'cancelled'], refuse: 'Only failed or cancelled items can be retried.' },
  approve: { from: ['awaiting'], refuse: 'This lesson is not waiting for approval.' },
  editOutline: {
    from: ['awaiting'],
    waitingFor: 'outline',
    refuse: 'The outline can be changed only while it waits for you, before the chapters are written.',
  },
};

/** True when `action` may start from this row's state. */
export function can(row, action) {
  const rule = ACTIONS[action];
  if (!rule) throw new Error(`Unknown lesson action: ${action}`);
  const { status, waitingFor } = stateOf(row);
  return rule.from.includes(status) && (!rule.waitingFor || rule.waitingFor === waitingFor);
}

/** Throws a LessonStateError (409) with the action's reason unless it may start from this row's state. */
export function check(row, action) {
  if (!can(row, action)) throw new LessonStateError(ACTIONS[action].refuse);
}

/**
 * What the writer does next for a lesson, from what the person has approved: for a long lesson, its outline (when
 * the person reviews it) and then its chapters; for a narration approved first, the narration and then the scenes.
 * undefined means the whole lesson in one go.
 */
export function nextPhase(lesson) {
  if (lesson?.chaptered) return lesson.outlineReview && !lesson.outlineApproved ? 'outline' : undefined;
  return lesson?.review === 'script' ? (lesson.scriptApproved ? 'scenes' : 'script') : undefined;
}

/** A lesson's settings once the person has approved what it was waiting for, so the writer goes on from there. */
export function approved(lesson, waitingFor) {
  if (waitingFor === 'outline') return { ...lesson, outlineApproved: true, phase: null };
  if (waitingFor === 'narration') return { ...lesson, scriptApproved: true };
  return lesson;
}

/**
 * The fields each status sets, so every move into it leaves the row the same way. `extra` adds to them (or
 * overrides one, where a caller means to): what a move does besides change the state.
 */
export const to = {
  /** Waiting for the renderer: nothing left over from the last attempt. */
  queued: (extra = {}) => ({ status: 'queued', stage: null, error: null, progress_done: 0, finished_at: null, ...extra }),
  /** Work has started; `stage` is what the page shows meanwhile. */
  processing: (stage, extra = {}) => ({ status: 'processing', stage, error: null, progress_done: 0, progress_total: 0, ...extra }),
  /** Waiting for the person; `stage` says for what. */
  awaiting: (stage, extra = {}) => ({ status: 'awaiting', stage, error: null, ...extra }),
  /** Built and playing. */
  done: (extra = {}) => ({ status: 'done', stage: null, error: null, finished_at: Date.now(), ...extra }),
  /** Stopped with a reason the page shows; Retry continues. */
  failed: (message, extra = {}) => ({ status: 'error', error: message, stage: null, finished_at: Date.now(), ...extra }),
  /** Stopped by the person; Retry continues. */
  cancelled: (extra = {}) => ({ status: 'cancelled', error: 'Cancelled', stage: null, finished_at: Date.now(), ...extra }),
};
