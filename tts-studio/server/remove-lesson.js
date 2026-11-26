import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_NAME } from './video.js';
import { RENDER_EXTS } from './versions.js';

/** Removing a lesson, and everything of a profile's: the library's delete route and deleting a profile share this. */
export function createLessonRemover({ store, runner, lessons, versions, getConfig }) {
  /**
   * Take a lesson out of the library with its files. `project` also removes the folder a lesson was
   * written into: its script, scenes, notes and attached files. Only for lessons, whose folder this
   * server made; a project you wrote by hand is never touched. Skipped while another library item
   * (of anyone) was built from the same folder.
   */
  function removeLesson(row, { project = false } = {}) {
    if (!runner.cancel(row.id)) lessons?.cancel(row.id);
    store.remove(row.id);
    const settings = JSON.parse(row.settings_json);
    let projectRemoved = false;
    if (project && settings.lesson && PROJECT_NAME.test(String(settings.project))) {
      if (!store.countBySource(row.source_name)) {
        fs.rmSync(path.join(getConfig().videoDir, 'projects', settings.project), { recursive: true, force: true });
        projectRemoved = true;
      }
    }
    versions?.removeRenders(row.id);
    const files = [store.audioPath(row.id), `${store.audioPath(row.id)}.tmp`, ...RENDER_EXTS.map((e) => store.videoPath(row.id, e))];
    for (const f of files) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* no file to remove */
      }
    }
    return projectRemoved;
  }

  /** Everything a profile made: its lessons, their projects and files. */
  async function removeProfileLessons(profileId) {
    for (const row of store.rowsOf(profileId)) removeLesson(row, { project: true });
  }

  return { removeLesson, removeProfileLessons };
}
