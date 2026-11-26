// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import Workspace, { whoWrote } from './Workspace.jsx';
import { api } from '../api.js';

vi.mock('../api.js', () => ({ api: { get: vi.fn(), versions: vi.fn(), storyboard: vi.fn(), transcript: vi.fn() } }));

const LESSON = {
  id: 'g1', kind: 'video', title: 'Why the gradient collapses', status: 'awaiting', stage: 'Storyboard ready: have a look',
  version: 1, builtVersion: 0, videoUrl: null, voiceId: 'af_heart', wordCount: 391, createdAt: 0, text: '[model]\nA score z.', tags: [],
  settings: { project: 'grad-1', quality: 'default', lesson: { topic: 'Gradient', goal: 'Why', minutes: 2, costUsd: 0.7, fixes: 1, autofixed: 2, usage: { inputTokens: 900, cacheReadTokens: 6000, cacheWriteTokens: 0, outputTokens: 4000 }, attachments: [] } },
};

let props;
function show(over = {}, tab = 'watch') {
  props = { onClose: vi.fn(), onPatch: vi.fn(), onDelete: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(), onApprove: vi.fn(), toast: vi.fn() };
  api.get.mockResolvedValue({ ...LESSON, ...over });
  return render(<Workspace id="g1" tab={tab} {...props} />);
}

beforeEach(() => {
  api.get.mockReset();
  api.versions.mockReset().mockResolvedValue({ current: 1, built: 0, versions: [{ n: 1, source: 'written', createdAt: 0 }] });
  api.storyboard.mockReset().mockResolvedValue({ scenes: [], unplayed: [] });
  api.transcript.mockReset().mockRejectedValue(Object.assign(new Error('No transcript'), { status: 404 }));
});
afterEach(cleanup);

describe('the lesson workspace', () => {
  it('a lesson waiting on its storyboard is approved at the quality chosen', async () => {
    show();
    const approve = await screen.findByRole('button', { name: 'Approve and render' });
    fireEvent.change(screen.getByLabelText('Quality'), { target: { value: 'medium' } });
    fireEvent.click(approve);
    expect(props.onApprove).toHaveBeenCalledWith(expect.objectContaining({ id: 'g1' }), { quality: 'medium' });
    expect(screen.getByText(/Nothing is rendered yet/)).toBeTruthy();
    expect(screen.getByText('v1 · Written')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Don’t render' }));
    expect(props.onCancel).toHaveBeenCalled();
  });

  it('says what writing the lesson took', async () => {
    show({ status: 'done', stage: null, videoUrl: '/api/generations/g1/video', builtVersion: 1 });
    expect(await screen.findByText(/\$0\.70 · 6,900 tokens read \(6,000 from the cache\) · 4,000 written/)).toBeTruthy();
    expect(screen.getByText(/1 fix by the writer · 2 common mistakes fixed automatically/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve and render' })).toBeNull();
  });

  describe('watching a finished lesson', () => {
    const DONE = { status: 'done', stage: null, version: 2, builtVersion: 2, videoUrl: '/api/generations/g1/video', durationSec: 120 };

    it('puts asking for a different explanation directly under the video', async () => {
      show(DONE);
      const ask = await screen.findByRole('region', { name: 'Ask for a different explanation' });
      const video = document.querySelector('.yt-main video');
      expect(video).toBeTruthy();
      // The ask bar follows the player and comes before the title and details.
      expect(video.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(ask.compareDocumentPosition(document.querySelector('.yt-info')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getAllByRole('region', { name: /Ask for a/ })).toHaveLength(1);
    });

    it('keeps the rail beside the video: the transcript for a lesson without chapters', async () => {
      show(DONE);
      await screen.findByRole('region', { name: 'Ask for a different explanation' });
      expect(screen.getByRole('tablist', { name: 'Beside the video' })).toBeTruthy();
      expect(screen.getByRole('tab', { name: 'Transcript' })).toBeTruthy();
      expect(screen.queryByRole('tab', { name: 'Chapters' })).toBeNull();
    });

    it('has a Fine-tune button that opens the editor', async () => {
      show(DONE);
      const link = await screen.findByRole('link', { name: 'Fine-tune' });
      expect(link.getAttribute('href')).toBe('#lesson/g1/edit');
    });

    it('keeps Download and Delete in one More menu, asking before anything is deleted', async () => {
      show(DONE);
      await screen.findByRole('region', { name: 'Ask for a different explanation' });
      expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull(); // not loose on the page
      const menu = screen.getByText('⋯ More').closest('details');
      expect(within(menu).getByRole('link', { name: 'Download video (MP4)' })).toBeTruthy();
      fireEvent.click(within(menu).getByRole('button', { name: 'Delete this lesson…' }));
      expect(props.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'g1' })); // App.removeItem asks to confirm
    });

    it('calls the details “About this lesson” and keeps what it cost in there', async () => {
      show(DONE);
      const about = (await screen.findByText(/About this lesson/)).closest('details');
      expect(about.hasAttribute('open')).toBe(false);
      expect(within(about).getByText('What it took')).toBeTruthy();
    });
  });

  it('keeps the ask-for-a-different-explanation bar for when there is a video to ask about', async () => {
    show(); // waiting at its storyboard: nothing to watch yet, so the change bar stays at the foot of the page
    await screen.findByRole('button', { name: 'Approve and render' });
    expect(screen.queryByRole('region', { name: 'Ask for a different explanation' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Ask for a change' })).toBeTruthy();
  });

  it('says who wrote each step', () => {
    expect(whoWrote([
      { step: 'write', provider: 'claude-code', label: 'Claude Code', model: 'claude-opus-5-5' },
      { step: 'fix', provider: 'ollama', label: 'This Mac: Ollama', model: 'qwen3-coder' },
      { step: 'polish', provider: 'ollama', label: 'This Mac: Ollama', model: 'qwen3-coder' },
    ])).toBe('Claude Code (claude-opus-5-5) wrote; This Mac: Ollama (qwen3-coder) fixed, polished');
    expect(whoWrote(undefined)).toBeNull();
  });

  it('has a tab for each view, each with its own address', async () => {
    show({}, 'notes');
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((t) => [t.textContent, t.getAttribute('href')])).toEqual([
      ['Watch', '#lesson/g1/watch'], ['Storyboard', '#lesson/g1/storyboard'], ['Fine-tune', '#lesson/g1/edit'], ['Versions', '#lesson/g1/history'], ['Notes', '#lesson/g1/notes'],
    ]);
    expect(screen.getByRole('tab', { name: 'Notes' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('Gradient')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '← Home' }));
    expect(props.onClose).toHaveBeenCalled();
  });
});
