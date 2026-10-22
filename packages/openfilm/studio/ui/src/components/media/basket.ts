/**
 * The media library's basket: shots set aside from the grid, to be used together later.
 *
 * It is a staging list, not an edit in itself: nothing is written to film.html until "Add to timeline" appends the
 * shots it holds. Kept per project in this browser for now (`localStorage`); the contract below is what a project file
 * would hold once the basket is saved with the film.
 */
import type { WorkspaceResourceKind } from '@/lib/workspace-resources';

export interface BasketItem {
  /** Project-relative path (`assets/a.mp4`): what a clip will name. */
  path: string;
  name: string;
  kind: WorkspaceResourceKind;
  /** The part of the file, in ms. The whole file while the library has no shot search. */
  startMs: number;
  endMs: number;
}

const keyOf = (projectId: string) => `openfilm.media.basket.${projectId}`;
const kindOf = (value: unknown): value is WorkspaceResourceKind =>
  value === 'video' || value === 'image' || value === 'audio' || value === 'mg' || value === 'other';

const itemOf = (raw: unknown): BasketItem | null => {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.path !== 'string' || typeof item.name !== 'string' || !kindOf(item.kind)) return null;
  const startMs = Number(item.startMs);
  const endMs = Number(item.endMs);
  return {
    path: item.path,
    name: item.name,
    kind: item.kind,
    startMs: Number.isFinite(startMs) && startMs >= 0 ? startMs : 0,
    endMs: Number.isFinite(endMs) && endMs >= 0 ? endMs : 0,
  };
};

export function loadBasket(projectId: string): BasketItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(keyOf(projectId)) ?? '[]');
    return Array.isArray(raw) ? raw.map(itemOf).filter((x): x is BasketItem => x !== null) : [];
  } catch {
    return [];
  }
}

export function saveBasket(projectId: string, items: readonly BasketItem[]): void {
  try {
    localStorage.setItem(keyOf(projectId), JSON.stringify(items));
  } catch {
    /* private mode: the basket lasts this visit */
  }
}

/** One item per path and range: adding the same shot twice does nothing. */
export const sameBasketItem = (a: BasketItem, b: Pick<BasketItem, 'path' | 'startMs' | 'endMs'>) =>
  a.path === b.path && a.startMs === b.startMs && a.endMs === b.endMs;
