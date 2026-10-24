/**
 * A small in-memory request log for the developer's floating API window. It records only local API
 * traffic (method, path, status, duration); keys and request bodies never enter it. The ring is
 * bounded, so leaving the window closed costs nothing.
 */
const MAX = 1000;
/** @typedef {{ id: number, at: number, method: string, path: string, status: number, ms: number }} ApiLogEntry */
/** @type {ApiLogEntry[]} */
const entries = [];
let next = 1;

/** @param {{ method?: string, path?: string, status?: number, ms?: number }} input */
export function recordApi(input) {
  const path = String(input.path || '');
  if (!path.startsWith('/api/') || path === '/api/health' || path === '/api/api-logs') return;
  entries.push({
    id: next++,
    at: Date.now(),
    method: String(input.method || 'GET').toUpperCase().slice(0, 12),
    path: path.slice(0, 800),
    status: Math.round(Number(input.status) || 0),
    ms: Math.max(0, Math.round(Number(input.ms) || 0)),
  });
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
}

/** Newest first. */
export function listApi(/** @type {number} */ limit = 300) {
  return entries.slice(-Math.max(1, Math.min(MAX, limit))).reverse();
}

export function clearApi() {
  entries.length = 0;
}
