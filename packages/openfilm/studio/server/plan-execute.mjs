// @ts-check
/**
 * The Plan-Execute runner for the rough cut.
 *
 * A plan is produced once (a planner model when configured, otherwise the deterministic fallback),
 * validated by `pipeline-plan.mjs`, and then executed by the orchestrator below. The planner never
 * writes a document; every write still goes through the same storyboard/film functions as the UI
 * and MCP. Completed steps are never replayed by a replan, and a failed step cannot be reported as
 * a completed run.
 */
import { HttpError } from './http.mjs';
import { agentReady, callAgent, parseJsonReply } from './agent-runtime.mjs';
import { applyOperations, readStoryboard, saveStoryboard } from './storyboard.mjs';
import { fillStoryboardTool, handoffStoryboardTool, matchStoryboardTool, qcReport } from './agent-tools.mjs';
import { readPrefs } from './prefs.mjs';
import { readRun, writeRun, writeUndo } from './pipeline.mjs';
import {
  PLAN_ACTIONS, beginPlanStep, defaultPlan, failPlanStep, finishPlanStep, goalOf, normalizeInput,
  normalizePlan, planIsComplete, planPrompt, readyPlanSteps, skipPlanStep,
} from './pipeline-plan.mjs';

/**
 * @typedef {{
 *   buildStoryboard: (raw: unknown, brief: Record<string, unknown>) => any,
 *   reviewShot: (project: any, shot: any, semanticIndex: any) => Promise<boolean>,
 * }} PlanHooks
 */

const now = () => Date.now();
const messageOf = (/** @type {unknown} */ error) => error instanceof Error ? error.message : String(error);

/** A compact storyboard state for the planner; the whole document stays out of the plan prompt. */
function boardFact(/** @type {any} */ doc) {
  return {
    revision: Number(doc?.revision) || null,
    shots: Array.isArray(doc?.shots) ? doc.shots.length : 0,
    selected: Array.isArray(doc?.shots) ? doc.shots.filter((/** @type {any} */ shot) => shot.match?.selectedId).length : 0,
    gaps: Array.isArray(doc?.shots) ? doc.shots.filter((/** @type {any} */ shot) => !shot.match?.selectedId || shot.match?.state === 'gap').length : 0,
    handedOffAt: doc?.handedOffAt ?? null,
  };
}

/** The material agent's query words. A failure falls back to the shot's own visual intent. */
export function materialQueryPlanner(/** @type {any} */ project) {
  return async (/** @type {any} */ shot, /** @type {string} */ fallback) => {
    const reply = await callAgent('material', [{
      role: 'user',
      content: `SHOT:\n${JSON.stringify({ title: shot.title, narration: shot.narration, visualIntent: shot.visualIntent, must: shot.must, avoid: shot.avoid, targetMs: shot.targetMs })}\n\nReturn only JSON: {"queries":["Chinese visual search query"]}.`,
    }], { project });
    const parsed = parseJsonReply(reply);
    const queries = Array.isArray(parsed?.queries)
      ? parsed.queries.filter((/** @type {unknown} */ item) => typeof item === 'string' && item.trim()).slice(0, 3)
      : typeof parsed?.query === 'string' && parsed.query.trim() ? [parsed.query] : [];
    return queries.length ? [...new Set([...queries, fallback])].join(' ').slice(0, 1200) : fallback;
  };
}

/** Ask the planner for a plan; a malformed or unavailable planner falls back to the deterministic plan. */
async function preparePlan(/** @type {any} */ project, /** @type {any} */ input, /** @type {any} */ run) {
  const doc = readStoryboard(project);
  const fallback = defaultPlan(goalOf(input), input, { includeHandoff: input.handoff === true });
  fallback.input = normalizeInput(input);
  if (!agentReady('planner')) return fallback;
  try {
    const reply = await callAgent('planner', [{
      role: 'user',
      content: planPrompt({
        goal: goalOf(input),
        input: normalizeInput(input),
        storyboard: boardFact(doc),
        capabilities: {
          storyboard: agentReady('storyboard'),
          material: agentReady('material'),
          edit: agentReady('edit'),
          qc: agentReady('qc'),
          handoff: true,
        },
        fallback,
      }),
    }], { project });
    const planned = normalizePlan(parseJsonReply(reply), {
      input,
      storyboardEmpty: doc.shots.length === 0,
      source: 'model',
    });
    if (planned) {
      /* A planner describes new work, never pre-completed work. */
      for (const step of planned.steps) {
        step.state = 'idle';
        step.attempts = 0;
        delete step.detail;
        delete step.startedAt;
        delete step.finishedAt;
      }
      planned.state = 'idle';
      delete planned.error;
      return planned;
    }
    run.issues.push('规划 Agent 返回了无效计划，使用默认五阶段计划。');
  } catch (error) {
    run.issues.push(`规划 Agent 失败，使用默认计划：${messageOf(error)}`);
  }
  return fallback;
}

/** Replan only the remaining work; completed writes are copied back by id and never repeated. */
async function replan(/** @type {any} */ project, /** @type {any} */ input, /** @type {any} */ run, /** @type {any} */ failedStep) {
  const plan = run.plan;
  if (!plan || plan.replans >= 2 || !agentReady('planner')) return false;
  try {
    const doc = readStoryboard(project);
    const reply = await callAgent('planner', [{
      role: 'user',
      content: [
        planPrompt({
          goal: `${plan.goal}\nThe run failed at step "${failedStep.label}" (${failedStep.id}): ${plan.error ?? ''}`,
          input: normalizeInput(input),
          storyboard: boardFact(doc),
          capabilities: {
            storyboard: agentReady('storyboard'),
            material: agentReady('material'),
            edit: agentReady('edit'),
            qc: agentReady('qc'),
            handoff: true,
          },
          fallback: defaultPlan(plan.goal, input),
        }),
        'Return a remaining plan only. Do not repeat steps that are already done: ' + plan.steps.filter((/** @type {any} */ step) => step.state === 'done').map((/** @type {any} */ step) => step.id).join(', '),
      ].join('\n\n'),
    }], { project });
    const proposed = normalizePlan(parseJsonReply(reply), {
      input,
      storyboardEmpty: doc.shots.length === 0,
      source: 'retry',
    });
    if (!proposed) return false;
    /* A model must not silently repeat a successful write under a different id. */
    const completedWrites = new Set(plan.steps
      .filter((/** @type {any} */ item) => (item.state === 'done' || item.state === 'skipped') && /** @type {any} */ (PLAN_ACTIONS)[item.action]?.write)
      .map((/** @type {any} */ item) => item.action));
    for (const step of proposed.steps) {
      const previous = plan.steps.find((/** @type {any} */ item) => item.id === step.id);
      const repeatedWrite = /** @type {any} */ (PLAN_ACTIONS)[step.action]?.write && completedWrites.has(step.action)
        && !(previous?.state === 'done' || previous?.state === 'skipped');
      if (repeatedWrite) return false;
      if (previous?.state === 'done' || previous?.state === 'skipped') {
        step.state = previous.state;
        step.finishedAt = previous.finishedAt;
        step.detail = previous.detail ?? '重规划保留已完成步骤';
      }
    }
    proposed.replans = plan.replans + 1;
    proposed.planner = 'model';
    proposed.source = 'retry';
    run.plan = proposed;
    run.state = 'running';
    run.error = '';
    run.issues.push(`第 ${proposed.replans} 次重规划：${failedStep.label} 失败后继续。`);
    return true;
  } catch (error) {
    run.issues.push(`重规划失败：${messageOf(error)}`);
    return false;
  }
}

/** Execute one plan step. The switch is the complete action allow-list for the runner. */
async function executeStep(
  /** @type {any} */ project,
  /** @type {any} */ input,
  /** @type {any} */ semanticIndex,
  /** @type {any} */ run,
  /** @type {any} */ step,
  /** @type {PlanHooks} */ hooks,
) {
  switch (step.action) {
    case 'generate_storyboard': {
      if (!agentReady('storyboard')) throw new HttpError(409, '没有可用的分镜 Agent，请先在设置中绑定分镜智能体的模型。');
      const current = readStoryboard(project);
      const existing = current.shots.length
        ? JSON.stringify({ title: current.title, brief: current.brief, scenes: current.scenes, shots: current.shots }).slice(0, 120_000)
        : '';
      const result = await callAgent('storyboard', [{
        role: 'user',
        content: [
          input.text ? `SCRIPT:\n${input.text}` : '',
          input.prompt ? `IDEA:\n${input.prompt}` : '',
          existing ? `EXISTING STORYBOARD (convert, repair or rewrite it into a shootable storyboard; keep its facts and any explicitly locked shots):\n${existing}` : '',
          `BRIEF:\n${JSON.stringify(input.brief ?? {})}`,
          'Return only JSON matching the storyboard contract. Give each shot a deliberately different targetMs (1-12s) according to its dramatic importance, action and line length; do not give every shot the same length. The sum should match the brief duration.',
        ].filter(Boolean).join('\n\n'),
      }], { project });
      const next = hooks.buildStoryboard(parseJsonReply(result), input.brief ?? {});
      const saved = await saveStoryboard(project, next, current.revision);
      run.storyboardRevision = saved.revision;
      return `${saved.shots.length} 个镜头`;
    }

    case 'plan_queries': {
      if (!agentReady('material')) return { skip: '未启用素材检索 Agent，匹配阶段使用画面语义' };
      return '查询由素材匹配 Agent 生成';
    }

    case 'match_storyboard': {
      const query = agentReady('material') ? materialQueryPlanner(project) : null;
      const saved = await matchStoryboardTool(project, semanticIndex, { topK: readPrefs().storyboard.candidateCount }, query);
      const doc = saved.storyboard ?? saved;
      run.storyboardRevision = doc.revision;
      return `${doc.shots.filter((/** @type {any} */ shot) => shot.match?.selectedId).length}/${doc.shots.length} 个镜头有候选`;
    }

    case 'fill_storyboard': {
      const doc = readStoryboard(project);
      const gaps = Array.isArray(step.input?.shotIds)
        ? step.input.shotIds.map(String)
        : doc.shots.filter((/** @type {any} */ shot) => !shot.match?.selectedId || shot.match?.state === 'gap').map((/** @type {any} */ shot) => shot.id);
      const targets = gaps.filter((/** @type {string} */ id) => doc.shots.some((/** @type {any} */ shot) => shot.id === id && !shot.locked)).slice(0, 3);
      if (!targets.length) return { skip: '没有可补齐的缺口镜头' };
      const made = [];
      for (const shotId of targets) {
        const shot = doc.shots.find((/** @type {any} */ item) => item.id === shotId);
        // eslint-disable-next-line no-await-in-loop
        const result = await fillStoryboardTool(project, {
          shotId,
          prompt: [shot?.visualIntent, shot?.title].filter(Boolean).join('，'),
          duration: Math.max(4, Math.min(30, Math.round((Number(shot?.targetMs) || 5000) / 1000))),
        });
        made.push(result.path);
      }
      run.storyboardRevision = readStoryboard(project).revision;
      return `补齐 ${made.length} 个镜头`;
    }

    case 'review_storyboard': {
      if (!agentReady('qc')) return { skip: '未启用自动质检 Agent，保留检索置信度' };
      const doc = readStoryboard(project);
      let reviewed = 0;
      for (const shot of doc.shots) {
        if (shot.locked || !shot.match?.candidates?.length) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          if (await hooks.reviewShot(project, shot, semanticIndex)) reviewed += 1;
        } catch (error) {
          run.issues.push(`“${shot.title}”审核失败：${messageOf(error)}`);
        }
      }
      if (reviewed) {
        const saved = await saveStoryboard(project, doc, doc.revision);
        run.storyboardRevision = saved.revision;
      }
      return reviewed ? `审核 ${reviewed} 个镜头` : '没有可审核的候选';
    }

    case 'validate_storyboard': {
      const report = qcReport(project);
      run.issues.push(...report.issues);
      return report.ok ? '结构校验通过' : `${report.issues.length} 个问题`;
    }

    case 'continuity': {
      if (!agentReady('edit')) return { skip: '未启用剪辑装配 Agent' };
      const before = readStoryboard(project);
      const reply = await callAgent('edit', [{
        role: 'user',
        content: `STORYBOARD:\n${JSON.stringify({
          title: before.title,
          brief: before.brief,
          shots: before.shots.map((/** @type {any} */ shot) => ({
            id: shot.id,
            title: shot.title,
            narration: shot.narration,
            visualIntent: shot.visualIntent,
            targetMs: shot.targetMs,
            selectedId: shot.match.selectedId,
            confidence: shot.match.confidence,
          })),
        })}.\n\nReturn only JSON: {"issues":["..."],"operations":[]}. Allowed operations: setTargetDuration {durationMs}, updateShot {shotId,patch}, reorderShots {shotIds}. Never touch a locked shot or invent media. Only propose changes that make the sequence more coherent.`,
      }], { project });
      const parsed = parseJsonReply(reply);
      run.issues.push(...(Array.isArray(parsed?.issues) ? parsed.issues.map(String).slice(0, 80) : []));
      const operations = Array.isArray(parsed?.operations) ? parsed.operations : [];
      const operationName = (/** @type {any} */ operation) => String(operation?.type ?? operation?.op ?? operation?.operation ?? operation?.action ?? '');
      const safe = operations.filter((/** @type {any} */ operation) => {
        if (!operation || typeof operation !== 'object') return false;
        const name = operationName(operation);
        if (name === 'reorderShots' || name === 'setTargetDuration') return true;
        if (name === 'updateShot') {
          const keys = Object.keys(operation.patch ?? {});
          return keys.length > 0 && keys.every((key) => key === 'targetMs' || key === 'title');
        }
        return false;
      });
      if (safe.length) {
        const after = applyOperations(before, safe);
        await writeUndo(project, before);
        const saved = await saveStoryboard(project, after, before.revision);
        run.storyboardRevision = saved.revision;
        run.applied.push(...safe.map(operationName));
      }
      return `${run.issues.length} 个问题 · ${safe.length} 个安全修改`;
    }

    case 'handoff_storyboard': {
      const result = await handoffStoryboardTool(project);
      run.storyboardRevision = result.storyboard.revision;
      return `${result.clips.length} 个镜头进入时间线${result.gaps.length ? `，${result.gaps.length} 个缺口` : ''}`;
    }

    default:
      throw new HttpError(400, `计划里有未知步骤：${step.action}`);
  }
}

/** Run a prepared plan to completion, cancellation or a recorded failure. */
export async function runPlan(
  /** @type {any} */ project,
  /** @type {any} */ input,
  /** @type {any} */ semanticIndex,
  /** @type {any} */ run,
  /** @type {PlanHooks} */ hooks,
) {
  const check = async () => {
    const latest = readRun(project);
    if (latest.cancelRequested) run.cancelRequested = true;
    return run.cancelRequested === true;
  };
  const mark = async () => { await writeRun(project, run); };

  try {
    run.state = 'running';
    run.startedAt ||= now();
    run.finishedAt = null;
    run.error = '';
    run.issues ||= [];
    run.applied ||= [];

    if (!run.plan) {
      run.plan = await preparePlan(project, input, run);
      run.plan.state = 'idle';
      await mark();
    } else if (run.plan.state !== 'running') {
      run.plan.state = 'running';
      await mark();
    }

    while (true) {
      if (await check()) throw new Error('cancelled');
      const ready = readyPlanSteps(run.plan);
      if (!ready.length) break;
      const step = ready[0];
      beginPlanStep(run.plan, step.id);
      await mark();
      try {
        const detail = await executeStep(project, input, semanticIndex, run, step, hooks);
        if (detail && typeof detail === 'object' && 'skip' in detail) skipPlanStep(run.plan, step.id, String(detail.skip));
        else finishPlanStep(run.plan, step.id, typeof detail === 'string' ? detail : '');
        await mark();
      } catch (error) {
        if (run.cancelRequested || (error instanceof Error && error.message === 'cancelled')) throw error;
        failPlanStep(run.plan, step.id, messageOf(error));
        run.error = messageOf(error);
        await mark();
        if (run.plan.replans < 2 && await replan(project, input, run, step)) {
          await mark();
          continue;
        }
        run.state = 'error';
        run.finishedAt = now();
        await mark();
        return run;
      }
    }

    if (!planIsComplete(run.plan)) {
      throw new Error('计划还有未完成步骤，但依赖条件无法满足');
    }
    run.plan.state = 'done';
    run.plan.error = '';
    run.state = 'done';
    run.finishedAt = now();
    await mark();
    return run;
  } catch (error) {
    if (run.cancelRequested || (error instanceof Error && error.message === 'cancelled')) {
      run.state = 'cancelled';
      run.finishedAt = now();
      if (run.plan) for (const step of run.plan.steps) if (step.state === 'running') skipPlanStep(run.plan, step.id, '已取消');
      if (run.plan) run.plan.state = 'cancelled';
    } else {
      run.state = 'error';
      run.finishedAt = now();
      run.error = messageOf(error);
      if (run.plan) {
        const running = run.plan.steps.find((/** @type {any} */ step) => step.state === 'running');
        if (running) failPlanStep(run.plan, running.id, run.error);
      }
    }
    await mark().catch(() => {});
    return run;
  }
}

/** Retry a run from its persisted plan/input without asking for the script again. */
export async function retryPlan(/** @type {any} */ project, /** @type {any} */ run, /** @type {PlanHooks} */ hooks, /** @type {any} */ semanticIndex) {
  if (!run.plan) throw new HttpError(409, '这次运行没有可重试的计划');
  const input = normalizeInput(run.plan.input ?? {});
  for (const step of run.plan.steps) {
    if (step.state === 'error' || step.state === 'running' || step.state === 'skipped') {
      step.state = 'idle';
      step.detail = '';
      step.startedAt = undefined;
      step.finishedAt = undefined;
    }
  }
  run.plan.state = 'idle';
  run.plan.error = '';
  run.state = 'running';
  run.finishedAt = null;
  run.error = '';
  run.cancelRequested = false;
  return runPlan(project, input, semanticIndex, run, hooks);
}
