import { QUALITIES } from './qualities.js';

/**
 * The steps a lesson goes through, and which one is waiting for the learner: so that a page asking
 * for approval always says where in the process it is, and what happens next.
 */
export function phaseSteps(g) {
  const lesson = g?.settings?.lesson;
  const phase = lesson?.phase; // 'outline' | 'script' while waiting on those; otherwise the storyboard
  const steps = [
    ...(lesson?.chaptered ? [['outline', 'Outline']] : []),
    ['narration', 'Narration'],
    ['storyboard', 'Storyboard'],
    ['render', 'Render'],
  ];
  const now = phase === 'outline' ? 'outline' : phase === 'script' ? 'narration' : 'storyboard';
  const at = steps.findIndex(([id]) => id === now);
  return steps.map(([id, label], i) => ({ id, label, state: i < at ? 'done' : i === at ? 'now' : 'next' }));
}

/** Outline, Narration, Storyboard, Render, with the one waiting for you marked. */
export function PhaseBar({ g }) {
  const steps = phaseSteps(g);
  return (
    <ol className="phase-bar" aria-label="Where this lesson is">
      {steps.map((s, i) => (
        <li key={s.id} className={s.state} aria-current={s.state === 'now' ? 'step' : undefined}>
          <span className="phase-dot" aria-hidden="true">{s.state === 'done' ? '✓' : i + 1}</span>
          <span>{s.label}</span>
          {s.state === 'now' && <small>waiting for you</small>}
        </li>
      ))}
    </ol>
  );
}

const QUALITY_LABEL = Object.fromEntries(QUALITIES);

/** What approving does, in a sentence. */
function nextStep(outlining, narration, quality, onOutlineTab) {
  if (outlining) return onOutlineTab ? 'Change anything you like, then approve the outline at the end of the page. Each chapter is written after it.' : 'Look over the outline first. Once you approve it, each chapter is written, one after another.';
  if (narration) return 'Approve the narration and the scenes are written to go with it.';
  return `Approve and the video is rendered at ${QUALITY_LABEL[quality] || quality}. You can still ask for changes once it plays.`;
}

/** Stays in view while a lesson is looked over: the next step, the quality, and the buttons. */
export default function ApproveCard({ g, quality, setQuality, outlining, narration, onOutlineTab, outlineHref, onApprove, onCancel }) {
  return (
    <section className="approve-card" aria-label="Approve this lesson">
      <div className="approve-text">
        <strong>Does this look right?</strong>
        <span className="hint">{nextStep(outlining, narration, quality, onOutlineTab)}</span>
      </div>
      <div className="row approve">
        <select className="input" aria-label="Quality" value={quality} onChange={(e) => setQuality(e.target.value)}>
          {QUALITIES.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
        </select>
        {outlining
          ? !onOutlineTab && <a className="btn primary" href={outlineHref}>Review the outline</a>
          : narration
            ? <button className="btn primary" onClick={() => onApprove(g, { quality, action: 'scenes' })}>Approve the narration</button>
            : <button className="btn primary" onClick={() => onApprove(g, { quality })}>Approve and render</button>}
        <button className="btn" onClick={() => onCancel(g)}>Don’t render</button>
      </div>
    </section>
  );
}
