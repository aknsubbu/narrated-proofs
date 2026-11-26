// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import Home, { pickContinue } from './Home.jsx';
import Library from './Library.jsx';
import { saveProgress, setProgressScope } from '../progress.js';

const base = { kind: 'video', voiceId: 'v', voiceName: 'V', wordCount: 100, createdAt: Date.now(), tags: [], preview: '', settings: { lesson: {} }, version: 1, posterUrl: null };
const done = (id, title) => ({ ...base, id, title, status: 'done', videoUrl: `/v/${id}`, durationSec: 120 });
const LESSONS = [
  done('a', 'Eigenvalues'),
  done('b', 'Gradients'),
  done('c', 'Limits'),
  { ...base, id: 'w', title: 'Fourier series', status: 'awaiting', stage: 'Storyboard ready', videoUrl: null },
  { ...base, id: 'm', title: 'Bayes rule', status: 'processing', stage: 'Writing the lesson', progressDone: 1, progressTotal: 4, videoUrl: null },
];

beforeEach(() => {
  localStorage.clear();
  setProgressScope('');
});
afterEach(cleanup);

describe('Home', () => {
  it('offers to pick up the lesson watched most recently that is not finished', () => {
    localStorage.setItem('tts-studio.progress', JSON.stringify({
      a: { t: 30, d: 120, at: 1000 },
      b: { t: 60, d: 120, at: 2000 }, // watched most recently
      c: { t: 119, d: 120, at: 3000 }, // finished: never offered, however recent
    }));
    const onOpen = vi.fn();
    render(<Home profile={{ name: 'Sam' }} lessons={LESSONS} loaded onOpen={onOpen} />);
    expect(screen.getByText('Welcome back, Sam')).toBeTruthy();
    const card = screen.getByRole('region', { name: /pick up where you left off/i });
    expect(within(card).getByText('Gradients')).toBeTruthy();
    expect(within(card).getByText('1m 00s left of 2m 00s')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Continue Gradients' }));
    expect(onOpen).toHaveBeenCalledWith('b', true);
  });

  it('has nothing to continue until a lesson is partly watched', () => {
    saveProgress('a', 2, 120); // too early to count as started
    render(<Home lessons={LESSONS} loaded onOpen={() => {}} />);
    expect(screen.queryByText(/pick up where you left off/i)).toBeNull();
    expect(pickContinue(LESSONS, {})).toBeNull();
  });

  it('lists what waits for a look and what is being made, in plain words', () => {
    const onOpen = vi.fn();
    render(<Home lessons={LESSONS} loaded onOpen={onOpen} />);
    const waiting = screen.getByRole('region', { name: /waiting for your look/i });
    fireEvent.click(within(waiting).getByRole('button', { name: 'Look over Fourier series' }));
    expect(onOpen).toHaveBeenCalledWith('w');
    const making = screen.getByRole('region', { name: /being made now/i });
    expect(within(making).getByText('Writing the lesson')).toBeTruthy();
    expect(within(making).getByRole('progressbar')).toBeTruthy();
  });

  it('invites a first lesson when there are none', () => {
    render(<Home lessons={[]} loaded onOpen={() => {}} />);
    expect(screen.getByRole('link', { name: 'Make a lesson' }).getAttribute('href')).toBe('#make');
  });

  it('does not claim the library is empty while it is still loading', () => {
    render(<Home lessons={[]} loaded={false} onOpen={() => {}} />);
    expect(screen.queryByText('Make your first lesson')).toBeNull();
  });
});

describe('Library by progress', () => {
  function show() {
    render(
      <Library
        mode="lessons"
        setMode={vi.fn()}
        list={{ items: LESSONS.filter((g) => g.status === 'done'), total: 3, loaded: true, error: '' }}
        filters={{ q: '', status: '', voiceId: '', tag: '', favorite: false, sort: '' }}
        setFilters={vi.fn()} stats={{ voices: [] }} tags={[]} selectedId={null}
        onOpen={vi.fn()} onFavorite={vi.fn()} onDelete={vi.fn()} onCancel={vi.fn()} onRetry={vi.fn()} onMore={vi.fn()}
      />,
    );
  }
  const titles = () => [...document.querySelectorAll('.card h3')].map((h) => h.textContent);

  it('filters lessons by what has been watched', () => {
    saveProgress('a', 30, 120);
    saveProgress('b', 119, 120);
    show();
    expect(titles()).toEqual(['Eigenvalues', 'Gradients', 'Limits']);
    fireEvent.click(screen.getByRole('button', { name: 'In progress' }));
    expect(titles()).toEqual(['Eigenvalues']);
    fireEvent.click(screen.getByRole('button', { name: 'Finished' }));
    expect(titles()).toEqual(['Gradients']);
    fireEvent.click(screen.getByRole('button', { name: 'Not started' }));
    expect(titles()).toEqual(['Limits']);
  });

  it('shows a tick on a finished lesson and a bar on one in progress', () => {
    saveProgress('a', 30, 120);
    saveProgress('b', 119, 120);
    show();
    const card = (t) => screen.getByText(t).closest('article');
    expect(within(card('Gradients')).getByText('✓ Finished')).toBeTruthy();
    expect(within(card('Eigenvalues')).getByRole('progressbar', { name: 'Watched' })).toBeTruthy();
    expect(within(card('Limits')).queryByRole('progressbar')).toBeNull();
  });

  it('says so when nothing fits the progress filter', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Finished' }));
    expect(screen.getByText('Nothing here yet')).toBeTruthy();
  });
});
