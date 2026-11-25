// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import ErrorBoundary from './ErrorBoundary.jsx';

let broken = true;
function Child() {
  if (broken) throw new Error('The lesson had no scenes to draw.');
  return <p>The lesson is drawn.</p>;
}

beforeEach(() => {
  broken = true;
  vi.spyOn(console, 'error').mockImplementation(() => {}); // React logs every error a boundary catches
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('shows a friendly message and what went wrong in place of a page that fails to draw', () => {
    render(<ErrorBoundary title="This lesson could not be shown."><Child /></ErrorBoundary>);
    expect(screen.getByRole('alert').textContent).toMatch(/This lesson could not be shown/);
    expect(screen.getByText('The lesson had no scenes to draw.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.queryByText('The lesson is drawn.')).toBeNull();
  });

  it('draws the page again on Try again once it no longer fails', () => {
    render(<ErrorBoundary><Child /></ErrorBoundary>);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('alert'), 'still failing, so still the message').toBeTruthy();
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('The lesson is drawn.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('forgets the failure when it is shown something else', () => {
    const { rerender } = render(<ErrorBoundary resetKey="a"><Child /></ErrorBoundary>);
    expect(screen.getByRole('alert')).toBeTruthy();
    broken = false;
    rerender(<ErrorBoundary resetKey="b"><Child /></ErrorBoundary>);
    expect(screen.getByText('The lesson is drawn.')).toBeTruthy();
  });
});
