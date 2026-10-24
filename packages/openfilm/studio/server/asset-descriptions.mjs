// @ts-check
/**
 * Material descriptions: one short, human-readable sentence (or two) about what an image/video
 * actually contains. They are deliberately lazy: empty until a person presses "生成描述" in the
 * library or an agent needs the material. Once saved they stay until the person explicitly asks
 * for a regeneration.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { studioHome } from './projects.mjs';
import { writeAtomic } from './atomic.mjs';

/** @typedef {{ desc: string, updatedAt: number, by: string, model?: string }} AssetDescription */
/** @typedef {{ assets: Record<string, AssetDescription> }} DescriptionState */

const FILE = () => join(studioHome(), 'asset-descriptions.json');
/** One key per library and asset; a project's own paths stay relative to that project. */
export const descriptionKey = (/** @type {string} */ libraryId, /** @type {string} */ path) => `${libraryId}\u0000${String(path).replace(/\\/g, '/')}`;

/** @type {DescriptionState | null} */
let cache = null;

function state() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(FILE(), 'utf8'));
    cache = { assets: raw && typeof raw.assets === 'object' && !Array.isArray(raw.assets) ? raw.assets : {} };
  } catch {
    cache = { assets: {} };
  }
  return cache;
}

/** @param {string} libraryId @param {string} path */
export async function getDescription(libraryId, path) {
  const entry = state().assets[descriptionKey(libraryId, path)];
  return entry && typeof entry.desc === 'string' ? entry : null;
}

/** All saved descriptions of one project/library, by the asset path the UI knows. */
export async function descriptionsFor(/** @type {string} */ libraryId) {
  const prefix = `${libraryId}\u0000`;
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, entry] of Object.entries(state().assets)) {
    if (!key.startsWith(prefix) || !entry?.desc) continue;
    out[key.slice(prefix.length)] = entry.desc;
  }
  return out;
}

/** @param {string} libraryId @param {string} path @param {string} desc @param {{ by?: string, model?: string }} [meta] */
export async function saveDescription(libraryId, path, desc, meta = {}) {
  const clean = String(desc ?? '').trim().slice(0, 2000);
  if (!clean) throw new Error('a description is empty');
  const next = state();
  next.assets[descriptionKey(libraryId, path)] = {
    desc: clean,
    updatedAt: Date.now(),
    by: meta.by ?? 'user',
    ...(meta.model ? { model: meta.model } : {}),
  };
  await writeAtomic(FILE(), `${JSON.stringify(next, null, 2)}\n`);
  return clean;
}

export function descriptionsFile() {
  return existsSync(FILE()) ? FILE() : null;
}
