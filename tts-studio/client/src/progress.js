import { useEffect, useState } from 'react';

/**
 * Where each learner got to in each lesson. It lives in this browser, per profile, so housemates
 * on one computer keep their own place. { [lessonId]: { t: seconds in, d: lesson length, at: when } }
 */
const BASE = 'tts-studio.progress';
const CHANGED = 'tts:progress';
const FINISHED_AT = 0.95; // watching this much counts as finished
const MIN_SECONDS = 5; // a few seconds in is not "started"

let scope = '';
/** Which profile's progress is read and written. The Owner keeps the unsuffixed key. */
export const setProgressScope = (next) => {
  scope = next || '';
};

const key = () => `${BASE}${scope}`;

export function readProgress() {
  try {
    const raw = JSON.parse(localStorage.getItem(key()) || '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

const write = (all) => {
  try {
    localStorage.setItem(key(), JSON.stringify(all));
  } catch {
    /* storage can be full or blocked: the place is a convenience, not a record */
  }
  window.dispatchEvent(new Event(CHANGED));
};

/** Remember `t` seconds into lesson `id`, which is `d` seconds long. */
export function saveProgress(id, t, d) {
  if (!id || !Number.isFinite(t) || !Number.isFinite(d) || d <= 0) return;
  const all = readProgress();
  const was = all[id];
  // Moving back by a hair after a finished lesson should not unfinish it.
  const t2 = was && was.t / was.d >= FINISHED_AT && t / d < FINISHED_AT && t < MIN_SECONDS ? was.t : t;
  all[id] = { t: Math.round(t2 * 10) / 10, d: Math.round(d * 10) / 10, at: Date.now() };
  write(all);
}

export function forgetProgress(id) {
  const all = readProgress();
  if (!(id in all)) return;
  delete all[id];
  write(all);
}

/** 0..1 of the lesson watched, or 0. */
export const fractionOf = (p) => (p && p.d > 0 ? Math.min(1, Math.max(0, p.t / p.d)) : 0);

/** 'new' (not started), 'started' (partway) or 'finished'. */
export function stateOf(p) {
  if (!p || p.t < MIN_SECONDS) return 'new';
  return fractionOf(p) >= FINISHED_AT ? 'finished' : 'started';
}

/** Where to resume: the saved second, or 0 when there is nothing to resume. */
export const resumeAt = (p) => (stateOf(p) === 'started' ? p.t : 0);

/** How many lessons a profile has partly watched and finished, as this browser remembers it. */
export function summaryFor(profile) {
  let all = {};
  try {
    const raw = JSON.parse(localStorage.getItem(`${BASE}${profile && !profile.isOwner ? `.${profile.id}` : ''}`) || '{}');
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) all = raw;
  } catch {
    /* unreadable: nothing to say */
  }
  const states = Object.values(all).map(stateOf);
  return { started: states.filter((s) => s === 'started').length, finished: states.filter((s) => s === 'finished').length };
}

/** All progress, kept current as the player writes it (here or in another tab). */
export function useProgress() {
  const [all, setAll] = useState(readProgress);
  useEffect(() => {
    const sync = () => setAll(readProgress());
    window.addEventListener(CHANGED, sync);
    window.addEventListener('storage', sync);
    sync(); // the profile may have changed since the first read
    return () => {
      window.removeEventListener(CHANGED, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return all;
}
