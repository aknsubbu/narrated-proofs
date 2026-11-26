import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { EngineError } from './kokoro.js';
import { localOnly } from './local.js';
import { settingsRoutes } from './settings-routes.js';
import { createProfiles } from './profiles.js';
import { attachProfile, connectorScope, profileRoutes, requireProfile } from './profile-routes.js';
import { MAX_CHARS, normalizeTags, routeHelpers } from './route-helpers.js';
import { normalizeSettings, generationRoutes } from './generation-routes.js';
import { healthRoutes } from './health-routes.js';
import { videoProjectRoutes } from './video-project-routes.js';
import { lessonRoutes } from './lesson-routes.js';
import { lessonFilesRoutes } from './lesson-files-routes.js';
import { editRoutes } from './edit-routes.js';
import { createLessonRemover } from './remove-lesson.js';

// Other modules and the tests import these from here.
export { MAX_CHARS, normalizeSettings, normalizeTags };

export function createApp({ getConfig, store, runner, engine, lessons, versions = null, settings = null, secrets = null, mcp = null, profiles = null, code = null, distDir }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(localOnly({ lan: () => getConfig().lan }));
  // A lesson may carry photos and PDFs of notes, so that one route takes a larger body.
  const smallJson = express.json({ limit: '8mb' });
  const lessonJson = express.json({ limit: '48mb' });
  app.use((req, res, next) => (req.path === '/api/lessons' ? lessonJson : smallJson)(req, res, next));

  const api = express.Router();
  profiles ||= createProfiles({ db: store.db, dataDir: store.dataDir, getMax: () => getConfig().maxProfiles || 5 });
  api.use(attachProfile(profiles));
  api.use(connectorScope);

  const helpers = routeHelpers({ store, runner, engine });
  const { removeLesson, removeProfileLessons } = createLessonRemover({ store, runner, lessons, versions, getConfig });

  api.use(healthRoutes({ engine, store, getConfig, code }));

  // Choosing who is watching comes before everything else but this health check.
  const people = profileRoutes({ profiles, hostSpent: (id) => store.stats(id).hostSpentThisMonthUsd, removeProfileData: async (profileId) => {
      await removeProfileLessons(profileId);
      await settings?.purge(profileId); // its settings, history and keys go with it
    },
  });
  api.use(people.open);
  api.use(requireProfile);
  api.use(people.guarded);

  api.use(generationRoutes({ store, runner, engine, getConfig, helpers, removeLesson }));
  api.use(videoProjectRoutes({ store, runner, engine, getConfig }));
  api.use(lessonRoutes({ store, runner, engine, lessons, versions, settings, getConfig, helpers }));
  api.use(lessonFilesRoutes({ store, versions, getConfig, helpers }));
  api.use(editRoutes({ store, runner, lessons, versions, profiles, getConfig, helpers }));

  if (settings) api.use(settingsRoutes({ settings, secrets, getConfig, store, profiles }));

  api.use((req, res) => res.status(404).json({ error: 'Unknown API route' }));
  app.use('/api', api);

  // The MCP connector over HTTP, for Claude Code: claude mcp add --transport http ... /mcp.
  // Behind the same Host and Origin checks as everything else here.
  if (mcp) app.all('/mcp', mcp);

  if (distDir && fs.existsSync(path.join(distDir, 'index.html'))) {
    app.use(express.static(distDir));
    app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(distDir, 'index.html')));
  } else {
    app.get('/', (req, res) =>
      res
        .type('html')
        .send(
          '<h3>Narrated Proofs API is running.</h3><p>The web UI is not built yet. Run <code>npm run build</code>, or use <code>npm run dev</code> and open http://localhost:5173.</p>',
        ),
    );
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err instanceof EngineError ? 503 : 500);
    if (status === 500) console.error(err);
    if (err.retryAfterSec) res.set('Retry-After', String(err.retryAfterSec));
    res.status(status).json({ error: err.message || 'Server error', ...(err.retryAfterSec ? { retryAfterSec: err.retryAfterSec } : {}) });
  });

  return app;
}
