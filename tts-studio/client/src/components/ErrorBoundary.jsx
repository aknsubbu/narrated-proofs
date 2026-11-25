import { Component } from 'react';

/**
 * Catches a page that fails while it draws, so one bad lesson does not blank the whole dashboard.
 * Try again draws it afresh (often enough once whatever it was waiting on has arrived); Reload starts
 * the page over. When `resetKey` changes, say to another lesson, the failure is forgotten on its own.
 */
export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('The page failed to draw.', error, info?.componentStack);
  }

  componentDidUpdate(prev) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.reset();
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { title = 'Something went wrong showing this page.', page = false } = this.props;
    return (
      <div className={`crash panel${page ? ' page' : ''}`} role="alert">
        <h2 className="panel-title">{title}</h2>
        <p className="hint">Your lessons are safe. Try again, and if it keeps happening, reload the page.</p>
        <details>
          <summary className="hint">What went wrong</summary>
          <pre className="crash-detail">{error?.message || String(error)}</pre>
        </details>
        <div className="row">
          <button className="btn primary" onClick={this.reset}>Try again</button>
          <button className="btn" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}
