import express from 'express';
import { MAX_CHARS } from './route-helpers.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** GET /health: comes before choosing who is watching, so it needs no profile. */
export function healthRoutes({ engine, store, getConfig, code }) {
  const r = express.Router();
  let lastStart = 0;

  r.get('/health', (req, res) => {
    // Bring the engine up if it is down, so a finished `npm run setup` or a crash
    // recovers without restarting the server. Spaced out so a broken install is not hammered.
    if (engine.info().status !== 'ready' && Date.now() - lastStart > 10_000) {
      lastStart = Date.now();
      engine.start().catch(() => {});
    }
    res.json({
      ok: true,
      engine: engine.info(),
      defaultVoiceId: getConfig().defaultVoiceId,
      maxChars: MAX_CHARS,
      version: code?.version ?? null,
      commit: code?.commit ?? null,
      startedAt: code?.startedAt ?? null,
      behind: code ? code.behind() : false, // the folder has newer code than this server runs
      // Only for the connector that started this server, on this computer: what it needs to restart it.
      ...(code?.startedBy === 'mcp' && LOOPBACK.has(req.socket.remoteAddress) ? { restart: { pid: process.pid, busy: store.inFlight() } } : {}),
    });
  });

  return r;
}
