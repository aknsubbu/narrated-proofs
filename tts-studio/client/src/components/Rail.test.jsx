// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import Rail, { parseChaptersVtt } from './Rail.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({ api: { outline: vi.fn(), transcript: vi.fn() } }));

const VTT = `WEBVTT

1
00:00:00.000 --> 00:01:30.000
Why a gradient

2
00:01:30.000 --> 00:04:00.500
The chain rule, step by step
`;
const lesson = (chaptered) => ({ id: 'g1', builtVersion: 1, settings: { lesson: { chaptered } } });

beforeEach(() => {
  api.outline.mockReset().mockResolvedValue({ notation: [{ tex: '\\nabla L', meaning: 'the gradient of the loss', color: 'BLUE' }] });
  api.transcript.mockReset().mockRejectedValue(Object.assign(new Error('No transcript'), { status: 404 }));
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve(VTT) });
});
afterEach(cleanup);

describe('reading chapters.vtt', () => {
  it('gives each chapter its start, end and title', () => {
    expect(parseChaptersVtt(VTT)).toEqual([
      { start: 0, end: 90, title: 'Why a gradient' },
      { start: 90, end: 240.5, title: 'The chain rule, step by step' },
    ]);
  });

  it('reads short timestamps and ignores what is not a cue', () => {
    expect(parseChaptersVtt('WEBVTT\n\n01:05.000 --> 02:00.000\nOne\n')).toEqual([{ start: 65, end: 120, title: 'One' }]);
    expect(parseChaptersVtt('')).toEqual([]);
    expect(parseChaptersVtt(undefined)).toEqual([]);
  });
});

describe('the rail beside the video', () => {
  it('offers only the transcript for a lesson without chapters', () => {
    render(<Rail g={lesson(false)} videoRef={{ current: null }} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Transcript']);
  });

  it('offers Chapters, Transcript and Notation for a lesson in chapters, starting on Chapters', async () => {
    render(<Rail g={lesson(true)} videoRef={{ current: null }} />);
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Chapters', 'Transcript', 'Notation']);
    expect(screen.getByRole('tab', { name: 'Chapters' }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('Why a gradient')).toBeTruthy();
    expect(screen.getByText('The chain rule, step by step')).toBeTruthy();
  });

  it('jumps the video to a chapter and plays it', async () => {
    const video = document.createElement('video');
    video.play = vi.fn().mockResolvedValue();
    render(<Rail g={lesson(true)} videoRef={{ current: video }} />);
    fireEvent.click(await screen.findByRole('button', { name: /The chain rule/ }));
    expect(video.currentTime).toBe(90);
    expect(video.play).toHaveBeenCalled();
  });

  it('marks the chapter being watched', async () => {
    const video = document.createElement('video');
    Object.defineProperty(video, 'currentTime', { value: 100, writable: true });
    render(<Rail g={lesson(true)} videoRef={{ current: video }} />);
    await screen.findByText('Why a gradient');
    video.dispatchEvent(new Event('timeupdate'));
    await waitFor(() => expect(screen.getByRole('button', { name: /The chain rule/ }).getAttribute('aria-current')).toBe('true'));
    expect(screen.getByRole('button', { name: /Why a gradient/ }).getAttribute('aria-current')).toBeNull();
  });

  it('says so when a lesson has no chapters file', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, text: () => Promise.resolve('') });
    render(<Rail g={lesson(true)} videoRef={{ current: null }} />);
    expect(await screen.findByText('This lesson has no chapters.')).toBeTruthy();
  });

  it('shows the notation every chapter shares', async () => {
    render(<Rail g={lesson(true)} videoRef={{ current: null }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Notation' }));
    const panel = screen.getByRole('tabpanel');
    expect(await within(panel).findByText('the gradient of the loss')).toBeTruthy();
    expect(within(panel).getByText('\\nabla L')).toBeTruthy();
    expect(api.outline).toHaveBeenCalledWith('g1');
  });

  it('says so when there is no shared notation', async () => {
    api.outline.mockResolvedValue({ notation: [] });
    render(<Rail g={lesson(true)} videoRef={{ current: null }} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Notation' }));
    expect(await screen.findByText(/shares no symbols/)).toBeTruthy();
  });
});
