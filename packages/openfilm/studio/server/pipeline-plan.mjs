// @ts-check
/**
 * Plan-Execute's plan document.
 *
 * A plan is intentionally small and explicit: steps name an action, the agent role that owns it,
 * their dependencies and an acceptance detail. The model may propose a plan, but this module is
 * the authority: it rejects unknown actions, cycles, writes after handoff, and a plan with no
 * storyboard step when the board is empty. The rough-cut runner executes this document; the old
 * five-step list remains a view of it for pages written before plans existed.
 */
import { randomBytes } from 'node:crypto';

/** @typedef {'storyboard' | 'material' | 'edit' | 'audio' | 'qc'} PlanRole */
/** @typedef {'idle' | 'running' | 'done' | 'skipped' | 'error'} PlanStepState */
/** @typedef {PlanStepState | 'cancelled'} PlanState */
/**
 * @typedef {{
 *   id: string,
 *   role: PlanRole,
 *   action: string,
 *   label: string,
 *   dependsOn: string[],
 *   state: PlanStepState,
 *   attempts: number,
 *   detail?: string,
 *   startedAt?: number,
 *   finishedAt?: number,
 *   input?: Record<string, unknown>,
 * }} PlanStep
 */
/**
 * @typedef {{
 *   version: 1,
 *   id: string,
 *   goal: string,
 *   source: 'default' | 'model' | 'retry',
 *   planner: 'model' | 'fallback',
 *   state: PlanState,
 *   replans: number,
 *   createdAt: number,
 *   updatedAt: number,
 *   steps: PlanStep[],
 *   input: { text: string, prompt: string, brief: Record<string, unknown>, handoff?: boolean },
 *   error?: string,
 * }} AgentPlan
 */

/** The actions the runner knows. A model cannot invent a tool by naming it in a plan. */
export const PLAN_ACTIONS = /** @type {const} */ ({
  generate_storyboard: { role: 'storyboard', label: '生成/转换分镜', write: true },
  plan_queries: { role: 'material', label: '素材检索', write: false },
  match_storyboard: { role: 'material', label: '匹配素材', write: true },
  fill_storyboard: { role: 'storyboard', label: '补齐镜头', write: true },
  review_storyboard: { role: 'qc', label: '自动质检', write: true },
  validate_storyboard: { role: 'qc', label: '结构校验', write: false },
  continuity: { role: 'edit', label: '剪辑连续性', write: true },
  handoff_storyboard: { role: 'edit', label: '交接时间线', write: true },
});

const ROLES = new Set(['storyboard', 'material', 'edit', 'audio', 'qc']);
const STATES = new Set(['idle', 'running', 'done', 'skipped', 'error']);
const PLAN_STATES = new Set([...STATES, 'cancelled']);
const MAX_STEPS = 12;
const MAX_REPLANS = 2;
const now = () => Date.now();
const clean = (/** @type {unknown} */ value, /** @type {number} */ max) => String(value ?? '').replace(/\0/g, '').trim().slice(0, max);

/** A plan id, stable for the life of one run. */
export function planId() {
  return `plan_${randomBytes(6).toString('hex')}`;
}

/** The deterministic plan used when no planner model is configured, or as the planner's fallback. */
export function defaultPlan(
  /** @type {string} */ goal,
  /** @type {{ text?: unknown, prompt?: unknown, brief?: unknown, handoff?: unknown }} */ input = {},
  /** @type {{ includeHandoff?: boolean }} */ options = {},
) {
  const includeHandoff = options.includeHandoff === true || input.handoff === true;
  /** @type {PlanStep[]} */
  const steps = [
    step('generate', 'storyboard', 'generate_storyboard', []),
    step('query', 'material', 'plan_queries', ['generate']),
    step('match', 'material', 'match_storyboard', ['query']),
    step('verify', 'qc', 'review_storyboard', ['match']),
    step('continuity', 'edit', 'continuity', ['verify']),
    ...(includeHandoff ? [step('handoff', 'edit', 'handoff_storyboard', ['continuity'])] : []),
  ];
  return /** @type {AgentPlan} */ ({
    version: 1,
    id: planId(),
    goal: clean(goal, 500) || '生成分镜与粗剪',
    source: 'default',
    planner: 'fallback',
    state: 'idle',
    replans: 0,
    createdAt: now(),
    updatedAt: now(),
    steps,
    input: normalizeInput(input),
  });
}

/** @returns {PlanStep} */
function step(/** @type {string} */ id, /** @type {PlanRole} */ role, /** @type {string} */ action, /** @type {string[]} */ dependsOn) {
  const meta = PLAN_ACTIONS[/** @type {keyof typeof PLAN_ACTIONS} */ (action)];
  return {
    id,
    role,
    action,
    label: meta.label,
    dependsOn,
    state: 'idle',
    attempts: 0,
  };
}

/** Keep the user's request with the plan so a failed run can be retried without asking again. */
export function normalizeInput(/** @type {{ text?: unknown, prompt?: unknown, brief?: unknown, handoff?: unknown }} */ input = {}) {
  return {
    text: clean(input.text, 120_000),
    prompt: clean(input.prompt, 4_000),
    brief: input.brief && typeof input.brief === 'object' && !Array.isArray(input.brief)
      ? /** @type {Record<string, unknown>} */ ({ ...input.brief })
      : {},
    ...(input.handoff === true ? { handoff: true } : {}),
  };
}

/** A short human goal without sending the whole script to the page. */
export function goalOf(/** @type {{ text?: unknown, prompt?: unknown }} */ input) {
  const text = clean(input.prompt, 500) || clean(input.text, 500).split(/\r?\n/).find(Boolean) || '';
  return text || '生成分镜与粗剪';
}

/**
 * Validate a model plan. Returns null rather than throwing: an invalid plan falls back to the
 * deterministic one, while a valid plan still goes through the same action whitelist as execution.
 * @param {unknown} raw
 * @param {{ input?: { text?: unknown, prompt?: unknown, brief?: unknown, handoff?: unknown }, storyboardEmpty?: boolean, source?: AgentPlan['source'] }} [options]
 * @returns {AgentPlan | null}
 */
export function normalizePlan(raw, options = {}) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, any>} */ (raw) : {};
  const rawSteps = Array.isArray(value.steps) ? value.steps : [];
  if (!rawSteps.length || rawSteps.length > MAX_STEPS) return null;

  /** @type {PlanStep[]} */
  const steps = [];
  const seen = new Set();
  for (const item of rawSteps) {
    if (!item || typeof item !== 'object') return null;
    const action = clean(item.action, 80);
    const meta = PLAN_ACTIONS[/** @type {keyof typeof PLAN_ACTIONS} */ (action)];
    if (!meta) return null;
    const role = ROLES.has(String(item.role)) ? /** @type {PlanRole} */ (String(item.role)) : meta.role;
    if (role !== meta.role) return null;
    const id = clean(item.id, 80) || `step_${steps.length + 1}`;
    if (seen.has(id)) return null;
    seen.add(id);
    const dependsOn = Array.isArray(item.dependsOn)
      ? [...new Set(item.dependsOn.map((/** @type {unknown} */ value) => clean(value, 80)).filter(Boolean))]
      : [];
    if (dependsOn.includes(id)) return null;
    steps.push({
      id,
      role,
      action,
      label: clean(item.label, 120) || meta.label,
      dependsOn,
      state: STATES.has(String(item.state)) ? /** @type {PlanStepState} */ (String(item.state)) : 'idle',
      attempts: Math.max(0, Math.min(9, Math.round(Number(item.attempts) || 0))),
      ...(typeof item.detail === 'string' ? { detail: clean(item.detail, 1000) } : {}),
      ...(Number.isFinite(Number(item.startedAt)) ? { startedAt: Number(item.startedAt) } : {}),
      ...(Number.isFinite(Number(item.finishedAt)) ? { finishedAt: Number(item.finishedAt) } : {}),
      ...(item.input && typeof item.input === 'object' && !Array.isArray(item.input) ? { input: item.input } : {}),
    });
  }

  /* Dependencies must point at steps in this plan, and the graph must be acyclic. */
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    if (!step.dependsOn.every((id) => byId.has(id))) return null;
  }
  if (hasCycle(steps)) return null;

  /* At most one of each action that changes the same document. */
  for (const action of ['generate_storyboard', 'match_storyboard', 'continuity', 'handoff_storyboard']) {
    if (steps.filter((step) => step.action === action).length > 1) return null;
  }
  const handoff = steps.find((step) => step.action === 'handoff_storyboard');
  if (handoff && steps.at(-1)?.id !== handoff.id) return null;
  const emptyStoryboard = options.storyboardEmpty === true;
  if (emptyStoryboard && !steps.some((step) => step.action === 'generate_storyboard')) return null;

  return /** @type {AgentPlan} */ ({
    version: 1,
    id: clean(value.id, 100) || planId(),
    goal: clean(value.goal, 500) || goalOf(options.input ?? {}),
    source: options.source ?? (value.source === 'retry' ? 'retry' : value.source === 'default' ? 'default' : 'model'),
    planner: value.planner === 'fallback' ? 'fallback' : 'model',
    state: PLAN_STATES.has(String(value.state)) ? /** @type {PlanState} */ (String(value.state)) : 'idle',
    replans: Math.max(0, Math.min(MAX_REPLANS, Math.round(Number(value.replans) || 0))),
    createdAt: Number.isFinite(Number(value.createdAt)) ? Number(value.createdAt) : now(),
    updatedAt: now(),
    steps,
    input: normalizeInput(options.input ?? value.input ?? {}),
    ...(typeof value.error === 'string' ? { error: clean(value.error, 2000) } : {}),
  });
}

/** @param {PlanStep[]} steps */
function hasCycle(steps) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  /** @type {Map<string, 0 | 1 | 2>} */
  const color = new Map();
  const visit = (/** @type {string} */ id) => {
    const state = color.get(id) ?? 0;
    if (state === 1) return true;
    if (state === 2) return false;
    color.set(id, 1);
    for (const next of byId.get(id)?.dependsOn ?? []) if (visit(next)) return true;
    color.set(id, 2);
    return false;
  };
  return steps.some((step) => visit(step.id));
}

/** The JSON contract shown to the planner. The action whitelist is deliberately explicit. */
export function planSchemaHint() {
  return `{
  "goal": "short Chinese goal",
  "steps": [
    {
      "id": "generate",
      "role": "storyboard",
      "action": "generate_storyboard",
      "label": "生成/转换分镜",
      "dependsOn": [],
      "input": {}
    }
  ]
}`;
}

/** Build the planner prompt from a compact project context, never the whole document. */
export function planPrompt(
  /** @type {{
   *   goal: string,
   *   input: { text: string, prompt: string, brief: Record<string, unknown>, handoff?: boolean },
   *   storyboard: { shots: number, selected: number, gaps: number, revision: number | null, handedOffAt: number | null },
   *   capabilities: Record<string, boolean>,
   *   fallback: AgentPlan,
   * }} */
  context,
) {
  const actions = Object.entries(PLAN_ACTIONS).map(([id, meta]) => `- ${id}: role=${meta.role}; ${meta.label}${meta.write ? '; writes a document' : '; read-only'}`).join('\n');
  return [
    `GOAL:\n${context.goal}`,
    `INPUT:\n${JSON.stringify({ prompt: context.input.prompt, brief: context.input.brief, text: context.input.text.slice(0, 20_000) })}`,
    `STORYBOARD:\n${JSON.stringify(context.storyboard)}`,
    `AVAILABLE AGENTS:\n${JSON.stringify(context.capabilities)}`,
    `ACTIONS:\n${actions}`,
    `DEFAULT PLAN (use it when unsure):\n${JSON.stringify(context.fallback.steps.map((step) => ({ id: step.id, role: step.role, action: step.action, dependsOn: step.dependsOn })))}`,
    `Return only JSON matching: ${planSchemaHint()}.`,
    'Rules: keep steps <= 8; dependencies must name earlier steps; only one generate/match/continuity/handoff step; never add render, export, publish, code execution or arbitrary network tools; include generate_storyboard when the storyboard is empty; put handoff_storyboard last and only when the goal asks to enter the timeline/rough cut; keep the five default ids when possible.',
  ].join('\n\n');
}

/** Mark a plan step running and keep the legacy pipeline view in sync. */
export function beginPlanStep(/** @type {AgentPlan} */ plan, /** @type {string} */ id) {
  const step = plan.steps.find((item) => item.id === id);
  if (!step) return null;
  step.state = 'running';
  step.attempts += 1;
  step.startedAt = now();
  delete step.finishedAt;
  plan.state = 'running';
  plan.updatedAt = now();
  return step;
}

/** @param {AgentPlan} plan @param {string} id @param {string} [detail] */
export function finishPlanStep(plan, id, detail = '') {
  const step = plan.steps.find((item) => item.id === id);
  if (!step) return;
  step.state = 'done';
  step.finishedAt = now();
  if (detail) step.detail = detail.slice(0, 1000);
  plan.updatedAt = now();
}

/** @param {AgentPlan} plan @param {string} id @param {string} detail */
export function skipPlanStep(plan, id, detail = '') {
  const step = plan.steps.find((item) => item.id === id);
  if (!step) return;
  step.state = 'skipped';
  step.finishedAt = now();
  if (detail) step.detail = detail.slice(0, 1000);
  plan.updatedAt = now();
}

/** @param {AgentPlan} plan @param {string} id @param {string} error */
export function failPlanStep(plan, id, error) {
  const step = plan.steps.find((item) => item.id === id);
  if (!step) return;
  step.state = 'error';
  step.finishedAt = now();
  step.detail = error.slice(0, 1000);
  plan.state = 'error';
  plan.error = error.slice(0, 2000);
  plan.updatedAt = now();
}

/** Ready steps in plan order. A failed/skipped dependency blocks its dependants. */
export function readyPlanSteps(/** @type {AgentPlan} */ plan) {
  const done = new Set(plan.steps.filter((step) => step.state === 'done' || step.state === 'skipped').map((step) => step.id));
  return plan.steps.filter((step) => step.state === 'idle' && step.dependsOn.every((id) => done.has(id)));
}

/** @param {AgentPlan} plan */
export function planIsComplete(/** @type {AgentPlan} */ plan) {
  return plan.steps.every((step) => step.state === 'done' || step.state === 'skipped');
}

/** A compact view for the run file and the page. */
export function planSummary(/** @type {AgentPlan} */ plan) {
  return {
    version: plan.version,
    id: plan.id,
    goal: plan.goal,
    source: plan.source,
    planner: plan.planner,
    state: plan.state,
    replans: plan.replans,
    steps: plan.steps.map((step) => ({
      id: step.id,
      role: step.role,
      action: step.action,
      label: step.label,
      dependsOn: [...step.dependsOn],
      state: step.state,
      attempts: step.attempts,
      ...(step.detail ? { detail: step.detail } : {}),
      ...(Number.isFinite(step.startedAt) ? { startedAt: step.startedAt } : {}),
      ...(Number.isFinite(step.finishedAt) ? { finishedAt: step.finishedAt } : {}),
    })),
  };
}
