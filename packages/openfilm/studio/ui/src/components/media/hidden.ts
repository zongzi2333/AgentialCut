/**
 * The media a person took out of the library's view.
 *
 * These are names, not files: removing a file here hides it from the grid and leaves every byte where it is — the
 * project still owns it, the timeline can still use it, and "Removed" brings it back. Nothing is deleted on disk, so
 * nothing needs a trash, and nothing can be lost by a delete that looked like a move to the Recycle Bin.
 */
const keyOf = (projectId: string) => `openfilm.media.hidden.${projectId}`;

export function loadHidden(projectId: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(keyOf(projectId)) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  } catch {
    return [];
  }
}

export function saveHidden(projectId: string, paths: readonly string[]): void {
  try {
    localStorage.setItem(keyOf(projectId), JSON.stringify([...new Set(paths)]));
  } catch {
    /* private mode: the choice lasts this visit */
  }
}
