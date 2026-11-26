// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { forgetProgress, fractionOf, readProgress, resumeAt, saveProgress, setProgressScope, stateOf } from './progress.js';

beforeEach(() => {
  localStorage.clear();
  setProgressScope('');
});

describe('progress', () => {
  it('remembers how far into a lesson someone got', () => {
    saveProgress('a', 42, 120);
    expect(readProgress().a).toMatchObject({ t: 42, d: 120 });
    expect(fractionOf(readProgress().a)).toBeCloseTo(0.35);
  });

  it('ignores a length it cannot trust', () => {
    saveProgress('a', 10, 0);
    saveProgress('a', NaN, 100);
    saveProgress('a', 10, Infinity);
    expect(readProgress()).toEqual({});
  });

  it('calls a lesson new, started or finished', () => {
    expect(stateOf(undefined)).toBe('new');
    expect(stateOf({ t: 2, d: 100 })).toBe('new');
    expect(stateOf({ t: 30, d: 100 })).toBe('started');
    expect(stateOf({ t: 96, d: 100 })).toBe('finished');
  });

  it('resumes only a lesson that is partway through', () => {
    expect(resumeAt({ t: 30, d: 100 })).toBe(30);
    expect(resumeAt({ t: 99, d: 100 })).toBe(0);
    expect(resumeAt(undefined)).toBe(0);
  });

  it('does not unfinish a finished lesson when it is reopened at the start', () => {
    saveProgress('a', 99, 100);
    saveProgress('a', 0.4, 100);
    expect(stateOf(readProgress().a)).toBe('finished');
  });

  it('keeps each profile’s place apart', () => {
    saveProgress('a', 30, 100);
    setProgressScope('.kid');
    expect(readProgress()).toEqual({});
    saveProgress('a', 80, 100);
    setProgressScope('');
    expect(readProgress().a.t).toBe(30);
  });

  it('forgets a lesson’s place', () => {
    saveProgress('a', 30, 100);
    forgetProgress('a');
    expect(readProgress()).toEqual({});
  });

  it('survives storage holding something unreadable', () => {
    localStorage.setItem('tts-studio.progress', '{not json');
    expect(readProgress()).toEqual({});
    localStorage.setItem('tts-studio.progress', '[1,2]');
    expect(readProgress()).toEqual({});
  });
});
