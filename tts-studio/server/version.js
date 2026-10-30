import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

/** The checkout's commit, or null without git (a Docker image, a copied folder). */
export function commitOf(root = ROOT) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim() || null;
  } catch {
    return null;
  }
}

// What code this server runs, for /api/health. The connector that starts the dashboard
// (TTS_MCP_AUTOSTART) used to reuse whatever answered on the port, so a server started weeks
// earlier kept serving old code to a newer page. `behind()` compares the commit it started
// with against the folder now, at most every 10 seconds.
export function createCodeInfo({ root = ROOT, commitNow = () => commitOf(root), startedBy = null, now = Date.now } = {}) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const commit = commitNow();
  const startedAt = new Date(now()).toISOString();
  let checked = 0;
  let latest = commit;
  return {
    version,
    commit,
    startedAt,
    startedBy, // 'mcp' when the connector started it, so it may restart it too
    behind() {
      if (now() - checked > 10_000) {
        checked = now();
        latest = commitNow();
      }
      return !!(commit && latest && latest !== commit);
    },
  };
}
