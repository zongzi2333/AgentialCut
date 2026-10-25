import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeState } from './agent-cards.mjs';

const card = (id, role, extra = {}) => ({ id, name: id, role, enabled: true, systemPrompt: '', ...extra });

test('old work slots migrate to the one agent pipeline and the v2 prompts replace saved text', () => {
  const state = normalizeState({
    revision: 3,
    agents: [
      card('s', 'storyboard'),
      card('d', 'director', { cardId: 'provider', modelId: 'model', systemPrompt: 'old custom director prompt' }),
      card('q', 'query'),
      card('v', 'verify'),
      card('c', 'continuity'),
    ],
  });
  assert.deepEqual(state.agents.filter((agent) => agent.role !== 'audio').map((agent) => agent.role), ['storyboard', 'conversation', 'material', 'qc', 'edit']);
  assert.equal(state.agents.find((agent) => agent.role === 'audio')?.enabled, false);
  assert.match(state.agents[1].systemPrompt, /## 任务/);
  assert.match(state.agents[1].systemPrompt, /## 要求/);
  assert.match(state.agents[1].systemPrompt, /## 交付/);
  assert.equal(state.agents[1].cardId, 'provider');
  assert.equal(state.agents[1].modelId, 'model');
  assert.equal(state.promptVersion, 2);
});

test('after the v2 save, a person’s edited prompt is kept, and only one card owns a slot', () => {
  const state = normalizeState({
    promptVersion: 2,
    agents: [
      card('a', 'conversation', { systemPrompt: 'my own prompt' }),
      card('b', 'conversation'),
      card('c', 'conversation'),
    ],
  });
  const owners = state.agents.filter((agent) => agent.role === 'conversation');
  assert.equal(owners.filter((agent) => agent.enabled).length, 1);
  assert.equal(owners[0].systemPrompt, 'my own prompt');
  assert.equal(owners[1].enabled, false);
});

test('the reserved audio role has a task/requirements/delivery prompt', () => {
  const state = normalizeState({ promptVersion: 2, agents: [card('a', 'audio')] });
  assert.equal(state.agents[0].role, 'audio');
  assert.match(state.agents[0].systemPrompt, /音频字幕 Agent/);
});
