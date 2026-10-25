/**
 * The rough-cut pipeline's small persisted state. It is deliberately separate from the storyboard:
 * the storyboard is the document people edit, while this is the run they can watch, cancel, retry or
 * undo. A failed run never leaves a half-written storyboard without a record of the step that failed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { normalizePlan } from './pipeline-plan.mjs';

export const PIPELINE_STEPS = [
  { id: 'generate', label: '生成/转换分镜' },
  { id: 'query', label: '素材检索' },
  { id: 'match', label: '匹配素材' },
  { id: 'verify', label: '自动质检' },
  { id: 'continuity', label: '剪辑连续性' },
];

const FILE_NAME = 'roughcut-run.json';

/** @typedef {'idle' | 'running' | 'done' | 'error' | 'cancelled'} RunState */
/** @typedef {{ id: string, label: string, state: 'idle' | 'running' | 'done' | 'skipped' | 'error', detail?: string, startedAt?: number, finishedAt?: number }} PipelineStep */
/** @typedef {import('./pipeline-plan.mjs').AgentPlan} AgentPlan */
/** @typedef {{ id: string, state: RunState, step: string, steps: PipelineStep[], plan: AgentPlan | null, startedAt: number | null, updatedAt: number, finishedAt: number | null, error: string, cancelRequested: boolean, storyboardRevision: number | null, applied: string[], issues: string[] }} PipelineRun */

const now = () => Date.now();

/** @returns {PipelineRun} */
export function emptyRun() {
  return {
    id: '',
    state: 'idle',
    step: '',
    steps: PIPELINE_STEPS.map((step) => ({ ...step, state: 'idle' })),
    plan: null,
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

/** The storyboard just before the edit agent's safe edits, for its one-click undo. */
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
  const plan = raw.plan && typeof raw.plan === 'object'
    ? normalizePlan(raw.plan, {
      input: raw.plan.input && typeof raw.plan.input === 'object' ? raw.plan.input : {},
      source: raw.plan.source === 'retry' ? 'retry' : raw.plan.source === 'default' ? 'default' : 'model',
    })
    : null;
  if (plan) {
    for (const item of plan.steps) {
      const existing = byId.get(item.id);
      if (existing) {
        existing.state = item.state;
        if (item.detail) existing.detail = item.detail;
        if (Number.isFinite(item.startedAt)) existing.startedAt = item.startedAt;
        if (Number.isFinite(item.finishedAt)) existing.finishedAt = item.finishedAt;
      } else {
        byId.set(item.id, {
          id: item.id,
          label: item.label,
          state: item.state,
          ...(item.detail ? { detail: item.detail } : {}),
          ...(Number.isFinite(item.startedAt) ? { startedAt: item.startedAt } : {}),
          ...(Number.isFinite(item.finishedAt) ? { finishedAt: item.finishedAt } : {}),
        });
      }
    }
  }
  return /** @type {PipelineRun} */ ({
    ...base,
    id: typeof raw.id === 'string' ? raw.id : '',
    state: ['idle', 'running', 'done', 'error', 'cancelled'].includes(raw.state) ? raw.state : 'idle',
    step: typeof raw.step === 'string' ? raw.step : '',
    steps: [...byId.values()],
    plan,
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

/** Keep the old page-facing step list in step with the plan. */
export function syncRunPlan(/** @type {PipelineRun} */ run) {
  if (!run.plan) return run;
  run.steps = run.plan.steps.map((step) => ({
    id: step.id,
    label: step.label,
    state: step.state,
    ...(step.detail ? { detail: step.detail } : {}),
    ...(Number.isFinite(step.startedAt) ? { startedAt: step.startedAt } : {}),
    ...(Number.isFinite(step.finishedAt) ? { finishedAt: step.finishedAt } : {}),
  }));
  run.step = run.plan.steps.find((step) => step.state === 'running')?.id ?? '';
  return run;
}

export async function writeRun(/** @type {{ path: string }} */ project, /** @type {PipelineRun} */ run) {
  await mkdir(join(project.path, '.film'), { recursive: true });
  syncRunPlan(run);
  run.updatedAt = now();
  await writeAtomic(runFile(project), `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
  return run;
}

export async function patchRun(/** @type {{ path: string }} */ project, /** @type {(run: PipelineRun) => void} */ change) {
  const run = readRun(project);
  change(run);
  return writeRun(project, run);
}

/** The page's view: keep the user's script out of the polling response while the run file keeps it for retry. */
export function publicRun(/** @type {PipelineRun} */ run) {
  if (!run.plan) return run;
  const { input: _input, ...plan } = run.plan;
  return { ...run, plan };
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
