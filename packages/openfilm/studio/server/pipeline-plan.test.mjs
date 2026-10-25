import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPlan, normalizePlan, readyPlanSteps } from './pipeline-plan.mjs';

test('the default plan preserves the five rough-cut stage ids and can append handoff', () => {
  const plan = defaultPlan('30 秒粗剪', { prompt: '30 秒粗剪', handoff: true });
  assert.deepEqual(plan.steps.map((step) => step.id), ['generate', 'query', 'match', 'verify', 'continuity', 'handoff']);
  assert.equal(plan.steps.at(-1).action, 'handoff_storyboard');
  assert.equal(plan.steps[0].role, 'storyboard');
});

test('a model plan is normalized, but unknown actions and cycles are rejected', () => {
  const valid = normalizePlan({
    goal: '整理分镜',
    steps: [
      { id: 'g', role: 'storyboard', action: 'generate_storyboard', dependsOn: [] },
      { id: 'm', role: 'material', action: 'match_storyboard', dependsOn: ['g'] },
      { id: 'q', role: 'qc', action: 'review_storyboard', dependsOn: ['m'] },
    ],
  }, { input: { prompt: '整理分镜' }, storyboardEmpty: true });
  assert.ok(valid);
  assert.deepEqual(valid.steps.map((step) => step.id), ['g', 'm', 'q']);

  assert.equal(normalizePlan({
    steps: [{ id: 'x', role: 'edit', action: 'render', dependsOn: [] }],
  }, { input: {}, storyboardEmpty: true }), null);

  assert.equal(normalizePlan({
    steps: [
      { id: 'a', role: 'storyboard', action: 'generate_storyboard', dependsOn: ['b'] },
      { id: 'b', role: 'material', action: 'match_storyboard', dependsOn: ['a'] },
    ],
  }, { input: {}, storyboardEmpty: true }), null);
});

test('an empty storyboard cannot be planned without generate, and readiness follows dependencies', () => {
  assert.equal(normalizePlan({
    steps: [{ id: 'm', role: 'material', action: 'match_storyboard', dependsOn: [] }],
  }, { input: {}, storyboardEmpty: true }), null);

  const plan = defaultPlan('计划', { prompt: '计划' });
  assert.deepEqual(readyPlanSteps(plan).map((step) => step.id), ['generate']);
  plan.steps[0].state = 'done';
  assert.deepEqual(readyPlanSteps(plan).map((step) => step.id), ['query']);
  plan.steps[1].state = 'skipped';
  assert.deepEqual(readyPlanSteps(plan).map((step) => step.id), ['match']);
});
