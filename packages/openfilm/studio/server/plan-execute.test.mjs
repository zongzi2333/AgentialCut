import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeStoryboard, saveStoryboard } from './storyboard.mjs';
import { normalizePlan } from './pipeline-plan.mjs';
import { emptyRun } from './pipeline.mjs';
import { runPlan } from './plan-execute.mjs';

const project = () => ({ id: 'plan_test', name: 'Plan Test', path: mkdtempSync(join(tmpdir(), 'openfilm-plan-')) });

test('the executor runs ready steps in dependency order and records skipped work', async () => {
  const p = project();
  const doc = normalizeStoryboard({
    title: 'Plan',
    brief: { durationMs: 10_000, aspect: '16:9', tone: '', notes: '' },
    scenes: [{ title: 'Scene' }],
    shots: [{ title: 'Shot', narration: '', visualIntent: 'a red kite', must: [], avoid: [], targetMs: 5000 }],
    source: 'manual',
  }, p);
  await saveStoryboard(p, doc, doc.revision);
  const plan = normalizePlan({
    goal: '检查分镜',
    steps: [
      { id: 'query', role: 'material', action: 'plan_queries', dependsOn: [] },
      { id: 'validate', role: 'qc', action: 'validate_storyboard', dependsOn: ['query'] },
    ],
  }, { input: { prompt: '检查分镜' }, storyboardEmpty: false });
  assert.ok(plan);
  const run = emptyRun();
  run.id = 'run_test';
  run.state = 'running';
  run.plan = plan;

  const finished = await runPlan(p, { prompt: '检查分镜' }, { search: async () => ({ hits: [] }) }, run, {
    buildStoryboard: () => { throw new Error('not used'); },
    reviewShot: async () => false,
  });
  assert.equal(finished.state, 'done');
  assert.equal(finished.plan?.steps.find((step) => step.id === 'query')?.state, 'skipped');
  assert.equal(finished.plan?.steps.find((step) => step.id === 'validate')?.state, 'done');
  assert.equal(finished.plan?.state, 'done');
});
