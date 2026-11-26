import crypto from 'node:crypto';

export const MAX_CHARS = 200_000;

export const httpError = (status, message) => Object.assign(new Error(message), { status });
export const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

export function normalizeTags(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(',');
  const seen = new Set();
  for (const t of raw) {
    const tag = String(t).toLowerCase().replace(/[,\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
    if (tag) seen.add(tag);
    if (seen.size >= 12) break;
  }
  return [...seen];
}

/** What the library and lesson routes all lean on, bound to this server's store, queue and voice engine. */
export function routeHelpers({ store, runner, engine }) {
  /** A waiting job shows how many are ahead of it: the render queue is shared by every profile. */
  const withQueue = (g) => {
    const n = g && runner.ahead?.(g.id);
    return n ? { ...g, queuedBehind: n } : g;
  };
  /** A lesson of the signed-in profile, or null: someone else's is the same as none, so it answers 404 like a missing one. */
  const findOwned = (req, id = req.params.id) => store.getRawOwned(id, req.profile.id);

  /** Reject voices Kokoro cannot speak. Returns the catalog entry once the engine has loaded. */
  function checkVoice(voiceId) {
    const { status, error } = engine.info();
    if (status === 'error') throw httpError(503, error);
    if (!/^[a-z]{2}_[a-z0-9_]{1,40}$/.test(voiceId)) throw httpError(400, 'That voice id looks invalid.');
    if (status !== 'ready') return null; // still loading; the worker checks again when the job runs
    const { voices, languages } = engine.catalog();
    const voice = voices.find((v) => v.voiceId === voiceId);
    if (!voice) throw httpError(400, `Kokoro has no voice called “${voiceId}”.`);
    const language = languages.find((l) => l.code === voice.lang);
    if (language && !language.available) throw httpError(400, `${language.name} voices are not set up. ${language.hint}`);
    return voice;
  }

  return { withQueue, findOwned, checkVoice };
}
