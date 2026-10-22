/**
 * The rough-cut pipeline's small persisted state. It is deliberately separate from the storyboard:
 * the storyboard is the document people edit, while this is the run they can watch, cancel, retry or
 * undo. A failed run never leaves a half-written storyboard without a record of the step that failed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './atomic.mjs';

export const PIPELINE_STEPS = [
  { id: 'generate', label: '生成/转换分镜' },
  { id: 'query', label: '检索规划' },
  { id: 'match', label: '匹配素材' },
  { id: 'verify', label: '画面审核' },
  { id: 'continuity', label: '连续性检查' },
];

const FILE_NAME = 'roughcut-run.json';

/** @typedef {'idle' | 'running' | 'done' | 'error' | 'cancelled'} RunState */
/** @typedef {{ id: string, label: string, state: 'idle' | 'running' | 'done' | 'skipped' | 'error', detail?: string, startedAt?: number, finishedAt?: number }} PipelineStep */
/** @typedef {{ id: string, state: RunState, step: string, steps: PipelineStep[], startedAt: number | null, updatedAt: number, finishedAt: number | null, error: string, cancelRequested: boolean, storyboardRevision: number | null, applied: string[], issues: string[] }} PipelineRun */

const now = () => Date.now();

/** @returns {PipelineRun} */
export function emptyRun() {
  return {
    id: '',
    state: 'idle',
    step: '',
    steps: PIPELINE_STEPS.map((step) => ({ ...step, state: 'idle' })),
    startedAt: null,
    updatedAt: 0,
    finishedAt: null,
    error: '',
    cancelRequested: false,
    storyboardRevision: null,
    applied: [],
    issues: [],
  };
}

export function runFile(/** @type {{ path: string }} */ project) {
  return join(project.path, '.film', FILE_NAME);
}

/** The storyboard just before the continuity agent's safe edits, for its one-click undo. */
export function undoFile(/** @type {{ path: string }} */ project) {
  return join(project.path, '.film', 'roughcut-undo.json');
}

export async function writeUndo(/** @type {{ path: string }} */ project, /** @type {unknown} */ storyboard) {
  await mkdir(join(project.path, '.film'), { recursive: true });
  await writeAtomic(undoFile(project), `${JSON.stringify(storyboard, null, 2)}\n`, { mode: 0o600 });
}

export function readUndo(/** @type {{ path: string }} */ project) {
  try { return JSON.parse(readFileSync(undoFile(project), 'utf8')); } catch { return null; }
}

export async function clearUndo(/** @type {{ path: string }} */ project) {
  const { rm } = await import('node:fs/promises');
  await rm(undoFile(project), { force: true }).catch(() => {});
}

/** @returns {PipelineRun} */
export function readRun(/** @type {{ path: string }} */ project) {
  const path = runFile(project);
  if (!existsSync(path)) return emptyRun();
  try {
    return normalizeRun(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return emptyRun();
  }
}

function normalizeRun(/** @type {unknown} */ value) {
  const raw = value && typeof value === 'object' ? /** @type {Record<string, any>} */ (value) : {};
  const base = emptyRun();
  const byId = new Map(PIPELINE_STEPS.map((step) => [step.id, { ...step, state: 'idle' }]));
  for (const item of Array.isArray(raw.steps) ? raw.steps : []) {
    const step = byId.get(String(item?.id));
    if (!step) continue;
    step.state = ['idle', 'running', 'done', 'skipped', 'error'].includes(item.state) ? item.state : 'idle';
    if (typeof item.detail === 'string') step.detail = item.detail.slice(0, 1000);
    if (Number.isFinite(Number(item.startedAt))) step.startedAt = Number(item.startedAt);
    if (Number.isFinite(Number(item.finishedAt))) step.finishedAt = Number(item.finishedAt);
  }
  return /** @type {PipelineRun} */ ({
    ...base,
    id: typeof raw.id === 'string' ? raw.id : '',
    state: ['idle', 'running', 'done', 'error', 'cancelled'].includes(raw.state) ? raw.state : 'idle',
    step: typeof raw.step === 'string' ? raw.step : '',
    steps: [...byId.values()],
    startedAt: Number.isFinite(Number(raw.startedAt)) ? Number(raw.startedAt) : null,
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0,
    finishedAt: Number.isFinite(Number(raw.finishedAt)) ? Number(raw.finishedAt) : null,
    error: typeof raw.error === 'string' ? raw.error.slice(0, 2000) : '',
    cancelRequested: raw.cancelRequested === true,
    storyboardRevision: Number.isFinite(Number(raw.storyboardRevision)) ? Number(raw.storyboardRevision) : null,
    applied: Array.isArray(raw.applied) ? raw.applied.map(String).slice(0, 40) : [],
    issues: Array.isArray(raw.issues) ? raw.issues.map(String).slice(0, 80) : [],
  });
}

export async function writeRun(/** @type {{ path: string }} */ project, /** @type {PipelineRun} */ run) {
  await mkdir(join(project.path, '.film'), { recursive: true });
  run.updatedAt = now();
  await writeAtomic(runFile(project), `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
  return run;
}

export async function patchRun(/** @type {{ path: string }} */ project, /** @type {(run: PipelineRun) => void} */ change) {
  const run = readRun(project);
  change(run);
  return writeRun(project, run);
}

export function step(/** @type {PipelineRun} */ run, /** @type {string} */ id) {
  return run.steps.find((item) => item.id === id);
}

export function beginStep(/** @type {PipelineRun} */ run, /** @type {string} */ id) {
  const item = step(run, id);
  if (!item) return null;
  item.state = 'running';
  item.startedAt = now();
  delete item.finishedAt;
  run.step = id;
  return item;
}

export function finishStep(/** @type {PipelineRun} */ run, /** @type {string} */ id, detail = '') {
  const item = step(run, id);
  if (!item) return;
  item.state = 'done';
  item.finishedAt = now();
  if (detail) item.detail = detail.slice(0, 1000);
}

export function skipStep(/** @type {PipelineRun} */ run, /** @type {string} */ id, detail = '') {
  const item = step(run, id);
  if (!item) return;
  item.state = 'skipped';
  item.finishedAt = now();
  if (detail) item.detail = detail.slice(0, 1000);
}

export function failStep(/** @type {PipelineRun} */ run, /** @type {string} */ id, /** @type {string} */ error) {
  const item = step(run, id);
  if (!item) return;
  item.state = 'error';
  item.finishedAt = now();
  item.detail = error.slice(0, 1000);
  run.error = error.slice(0, 2000);
}

export function isCancelled(/** @type {PipelineRun} */ run) {
  return run.cancelRequested === true;
}
