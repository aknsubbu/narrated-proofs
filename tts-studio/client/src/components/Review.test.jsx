// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import ApproveCard, { PhaseBar, phaseSteps } from './Review.jsx';

afterEach(cleanup);
const lesson = (over) => ({ id: 'g1', settings: { lesson: over } });
const states = (g) => phaseSteps(g).map((s) => `${s.label}:${s.state}`);

describe('the steps of a lesson', () => {
  it('a short lesson waiting at its storyboard has written its narration and has the render to come', () => {
    expect(states(lesson({}))).toEqual(['Narration:done', 'Storyboard:now', 'Render:next']);
  });

  it('a lesson waiting on its narration is at the narration', () => {
    expect(states(lesson({ phase: 'script' }))).toEqual(['Narration:now', 'Storyboard:next', 'Render:next']);
  });

  it('a lesson in chapters starts with its outline', () => {
    expect(states(lesson({ chaptered: true, phase: 'outline' }))).toEqual(['Outline:now', 'Narration:next', 'Storyboard:next', 'Render:next']);
    expect(states(lesson({ chaptered: true }))).toEqual(['Outline:done', 'Narration:done', 'Storyboard:now', 'Render:next']);
  });

  it('says which step is waiting for you, to a screen reader as well', () => {
    render(<PhaseBar g={lesson({})} />);
    const now = screen.getByRole('listitem', { current: 'step' });
    expect(now.textContent).toMatch(/Storyboard\s*waiting for you/);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
});

describe('the approve card', () => {
  const show = (props = {}) => {
    const handlers = { onApprove: vi.fn(), onCancel: vi.fn(), setQuality: vi.fn() };
    render(<ApproveCard g={lesson({})} quality="medium" outlining={false} narration={false} onOutlineTab={false} outlineHref="#lesson/g1/outline" {...handlers} {...props} />);
    return handlers;
  };

  it('says what approving does, at the quality chosen', () => {
    show();
    expect(screen.getByText(/rendered at 720p/)).toBeTruthy();
  });

  it('approves at the chosen quality, or does not render', () => {
    const h = show();
    fireEvent.click(screen.getByRole('button', { name: 'Approve and render' }));
    expect(h.onApprove).toHaveBeenCalledWith(expect.anything(), { quality: 'medium' });
    fireEvent.click(screen.getByRole('button', { name: 'Don’t render' }));
    expect(h.onCancel).toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Quality'), { target: { value: 'low' } });
    expect(h.setQuality).toHaveBeenCalledWith('low');
  });

  it('approves a narration to have its scenes written', () => {
    const h = show({ narration: true });
    expect(screen.getByText(/scenes are written to go with it/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve the narration' }));
    expect(h.onApprove).toHaveBeenCalledWith(expect.anything(), { quality: 'medium', action: 'scenes' });
  });

  it('sends someone to the outline to look it over, rather than approving it blind', () => {
    const h = show({ outlining: true });
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Review the outline' }).getAttribute('href')).toBe('#lesson/g1/outline');
    expect(h.onApprove).not.toHaveBeenCalled();
  });

  it('on the outline page, leaves the approving to the outline itself', () => {
    show({ outlining: true, onOutlineTab: true });
    expect(screen.queryByRole('link', { name: 'Review the outline' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(screen.getByText(/approve the outline at the end of the page/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Don’t render' })).toBeTruthy();
  });

  it('is one region a learner can find', () => {
    show();
    expect(within(screen.getByRole('region', { name: 'Approve this lesson' })).getByText('Does this look right?')).toBeTruthy();
  });
});
