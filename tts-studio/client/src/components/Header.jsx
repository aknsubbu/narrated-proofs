import { ProfileMenu } from './Profiles.jsx';

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M7 13v6M11.5 9v14M16 5v22M20.5 10v12M25 14v4" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

const ENGINE = {
  ready: { tone: 'ok', label: 'Voice ready' },
  starting: { tone: 'wait', label: 'Loading the voice…' },
  stopped: { tone: 'wait', label: 'Loading the voice…' },
  error: { tone: 'bad', label: 'Voice offline' },
};

/** The top bar says where you are and offers the two things you do: go home, or make something. */
export default function Header({ profile, page }) {
  return (
    <header className="topbar">
      <a className="brand" href="#" aria-label="Narrated Proofs, home">
        <Logo />
        <span className="brand-name">Narrated Proofs</span>
      </a>

      <nav className="topnav" aria-label="Main">
        <a href="#" className={page === 'home' ? 'on' : ''} aria-current={page === 'home' ? 'page' : undefined}>Home</a>
      </nav>

      <div className="topbar-right">
        <a className={`btn primary make-btn${page === 'make' ? ' on' : ''}`} href="#make" aria-current={page === 'make' ? 'page' : undefined}>
          <span aria-hidden="true">＋</span> Make a lesson
        </a>
        <ProfileMenu profile={profile} />
        <a className="icon-btn gear" href="#settings" aria-label="Settings" title="Settings">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path fill="currentColor" d="M19.4 13a7.5 7.5 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.4h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.6a7.5 7.5 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)" />
          </svg>
        </a>
      </div>
    </header>
  );
}

/** The voice engine's state, kept out of the way at the foot of the page. */
export function Footer({ health }) {
  const engine = health?.engine;
  if (!health) return null;
  const pill = ENGINE[engine?.status] || ENGINE.error;
  return (
    <footer className="foot">
      <span
        className={`pill ${pill.tone}`}
        title={engine?.error || (engine?.device ? `Running on this Mac (${engine.device}). Nothing leaves your computer.` : '')}
      >
        <span className="dot" />
        {pill.label}
      </span>
    </footer>
  );
}
