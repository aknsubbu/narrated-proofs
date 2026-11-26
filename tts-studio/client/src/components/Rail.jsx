import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtDuration } from '../utils.js';
import Transcript from './Transcript.jsx';

const seconds = (stamp) => {
  const parts = stamp.trim().split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((t, n) => t * 60 + n, 0);
};

/** The cues of a chapters.vtt as [{ start, end, title }], in order. */
export function parseChaptersVtt(text) {
  const cues = [];
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\S+)\s+-->\s+(\S+)/.exec(lines[i]);
    if (!m) continue;
    const start = seconds(m[1]);
    const end = seconds(m[2]);
    const title = [];
    for (i += 1; i < lines.length && lines[i].trim(); i += 1) title.push(lines[i].trim());
    if (start != null && end != null && title.length) cues.push({ start, end, title: title.join(' ') });
  }
  return cues;
}

/** The chapters, each a way in: click one and the video jumps there. */
function Chapters({ id, builtVersion, videoRef }) {
  const [cues, setCues] = useState(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    let live = true;
    fetch(`/api/generations/${id}/chapters.vtt`)
      .then((r) => (r.ok ? r.text() : ''))
      .then((t) => live && setCues(parseChaptersVtt(t)))
      .catch(() => live && setCues([]));
    return () => {
      live = false;
    };
  }, [id, builtVersion]);

  useEffect(() => {
    const video = videoRef?.current;
    if (!video) return undefined;
    const tick = () => setNow(video.currentTime);
    video.addEventListener('timeupdate', tick);
    return () => video.removeEventListener('timeupdate', tick);
  }, [videoRef, cues]);

  if (!cues) return <p className="hint">Loading the chapters…</p>;
  if (!cues.length) return <p className="hint">This lesson has no chapters.</p>;
  const go = (t) => {
    const video = videoRef?.current;
    if (!video) return;
    video.currentTime = t;
    video.play?.().catch(() => {});
  };
  return (
    <ol className="rail-chapters">
      {cues.map((c, n) => {
        const here = now >= c.start && now < c.end;
        return (
          <li key={c.start}>
            <button type="button" className={here ? 'on' : ''} aria-current={here ? 'true' : undefined} onClick={() => go(c.start)}>
              <span className="n">{n + 1}</span>
              <span className="t">{c.title}</span>
              <span className="when">{fmtDuration(c.start)}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** The symbols every chapter writes the same way, to look up while watching. */
function Notation({ id }) {
  const [symbols, setSymbols] = useState(null);
  useEffect(() => {
    let live = true;
    api.outline(id).then((o) => live && setSymbols(o.notation || []), () => live && setSymbols([]));
    return () => {
      live = false;
    };
  }, [id]);
  if (!symbols) return <p className="hint">Loading the notation…</p>;
  if (!symbols.length) return <p className="hint">This lesson shares no symbols between its chapters.</p>;
  return (
    <ul className="rail-notation">
      {symbols.map((s, i) => (
        <li key={i}>
          <code>{s.tex}</code>
          <span>{s.meaning}</span>
        </li>
      ))}
    </ul>
  );
}

/** Beside the video: the chapters, the words as they are spoken, and the notation. */
export default function Rail({ g, videoRef }) {
  const chaptered = Boolean(g.settings?.lesson?.chaptered);
  const tabs = [...(chaptered ? [['chapters', 'Chapters']] : []), ['transcript', 'Transcript'], ...(chaptered ? [['notation', 'Notation']] : [])];
  const [tab, setTab] = useState(tabs[0][0]);
  return (
    <div className="rail">
      <div className="rail-tabs" role="tablist" aria-label="Beside the video">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      <div className="rail-body" role="tabpanel">
        {tab === 'chapters' && <Chapters id={g.id} builtVersion={g.builtVersion} videoRef={videoRef} />}
        {tab === 'transcript' && <Transcript id={g.id} builtVersion={g.builtVersion} videoRef={videoRef} />}
        {tab === 'notation' && <Notation id={g.id} />}
      </div>
    </div>
  );
}
