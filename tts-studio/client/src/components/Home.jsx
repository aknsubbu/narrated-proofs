import { fmtDuration, isActive, needsYou } from '../utils.js';
import { fractionOf, stateOf, useProgress } from '../progress.js';
import { Progress, StatusBadge } from './Library.jsx';

const playable = (g) => Boolean(g.videoUrl);

/** The lesson to pick up again: the one watched most recently that is not finished. */
export function pickContinue(items, progress) {
  return items
    .filter((g) => g.kind === 'video' && playable(g) && stateOf(progress[g.id]) === 'started')
    .sort((a, b) => (progress[b.id].at || 0) - (progress[a.id].at || 0))[0] || null;
}

function Poster({ g }) {
  return (
    <span className={`home-poster${g.posterUrl ? ' has-img' : ''}`} aria-hidden="true">
      {g.posterUrl && <img src={g.posterUrl} alt="" loading="lazy" />}
      <span className="play-icon">▶</span>
    </span>
  );
}

function Continue({ g, p, onOpen }) {
  const left = Math.max(0, p.d - p.t);
  return (
    <section className="home-card continue" aria-labelledby="home-continue">
      <h2 id="home-continue" className="eyebrow">Pick up where you left off</h2>
      <div className="continue-row">
        <Poster g={g} />
        <div className="continue-body">
          <h3>{g.title}</h3>
          <p className="hint">{fmtDuration(left)} left of {fmtDuration(p.d)}</p>
          <div className="meter slim" role="progressbar" aria-label="How much you have watched" aria-valuenow={Math.round(fractionOf(p) * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className="meter-fill" style={{ width: `${Math.max(4, fractionOf(p) * 100)}%` }} />
          </div>
        </div>
        <button className="btn primary" onClick={() => onOpen(g.id, true)} aria-label={`Continue ${g.title}`}>Continue</button>
      </div>
    </section>
  );
}

function NeedsLook({ items, onOpen }) {
  return (
    <section className="home-card needs" aria-labelledby="home-needs">
      <h2 id="home-needs" className="eyebrow">Waiting for your look</h2>
      <ul className="home-list">
        {items.map((g) => (
          <li key={g.id}>
            <div>
              <strong>{g.title}</strong>
              <span className="hint">{g.stage || 'Look it over before it is made'}</span>
            </div>
            <button className="btn" onClick={() => onOpen(g.id)} aria-label={`Look over ${g.title}`}>Look it over</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MakingNow({ items, onOpen }) {
  return (
    <section className="home-card making" aria-labelledby="home-making">
      <h2 id="home-making" className="eyebrow">Being made now</h2>
      <ul className="home-list">
        {items.map((g) => (
          <li key={g.id}>
            <div className="making-text">
              <strong>{g.title}</strong>
              <StatusBadge g={g} />
              <Progress g={g} />
            </div>
            <button className="btn" onClick={() => onOpen(g.id)} aria-label={`Open ${g.title}`}>Open</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What to do next, before the library: carry on, look something over, or see what is being made. */
export default function Home({ profile, lessons, loaded, onOpen }) {
  const progress = useProgress();
  const resume = pickContinue(lessons, progress);
  const waiting = lessons.filter(needsYou);
  const making = lessons.filter(isActive);
  const nothing = loaded && !lessons.length;

  return (
    <section className="home" aria-label="Your learning">
      <div className="home-head">
        <h2>{profile?.name ? `Welcome back, ${profile.name}` : 'What would you like to learn?'}</h2>
        {!nothing && <p className="hint">Pick up a lesson, or make a new one from your notes.</p>}
      </div>

      {nothing && (
        <div className="home-card start">
          <h3>Make your first lesson</h3>
          <p>Name a topic, add your notes, and get a narrated video that explains it step by step.</p>
          <a className="btn primary" href="#make">Make a lesson</a>
        </div>
      )}
      {resume && <Continue g={resume} p={progress[resume.id]} onOpen={onOpen} />}
      {waiting.length > 0 && <NeedsLook items={waiting} onOpen={onOpen} />}
      {making.length > 0 && <MakingNow items={making} onOpen={onOpen} />}
    </section>
  );
}
