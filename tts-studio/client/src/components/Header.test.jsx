// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import Header, { Footer } from './Header.jsx';

afterEach(cleanup);
const current = () => screen.getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.textContent.trim() || a.getAttribute('aria-label'));

describe('the header says where you are', () => {
  it('marks Home on Home, and only Home', () => {
    render(<Header profile={null} page="home" />);
    expect(current()).toEqual(['Home']);
  });

  it('marks Make a lesson on the Make page', () => {
    render(<Header profile={null} page="make" />);
    expect(current()).toEqual(['＋ Make a lesson']);
  });

  it('marks Settings, not Home, inside Settings', () => {
    render(<Header profile={null} page="settings" />);
    expect(current()).toEqual(['Settings']);
  });

  it('marks nothing while a lesson is open', () => {
    render(<Header profile={null} page="lesson" />);
    expect(current()).toEqual([]);
  });
});

describe('the footer', () => {
  it('says whether the voice is ready, and stays quiet until it knows', () => {
    const { container, rerender } = render(<Footer health={null} />);
    expect(container.textContent).toBe('');
    rerender(<Footer health={{ engine: { status: 'ready' } }} />);
    expect(screen.getByText('Voice ready')).toBeTruthy();
    rerender(<Footer health={{ unreachable: true, engine: { status: 'error' } }} />);
    expect(screen.getByText('Voice offline')).toBeTruthy();
  });
});
