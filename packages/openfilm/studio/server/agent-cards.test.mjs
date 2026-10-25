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
  assert.deepEqual(state.agents.filter((agent) => agent.role !== 'audio').map((agent) => agent.role), ['planner', 'storyboard', 'conversation', 'material', 'qc', 'edit']);
  assert.equal(state.agents.find((agent) => agent.role === 'audio')?.enabled, true);
  const conversation = state.agents.find((agent) => agent.role === 'conversation');
  assert.ok(conversation);
  assert.match(conversation.systemPrompt, /## 任务/);
  assert.match(conversation.systemPrompt, /## 要求/);
  assert.match(conversation.systemPrompt, /## 交付/);
  assert.equal(conversation.cardId, 'provider');
  assert.equal(conversation.modelId, 'model');
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

test('the audio role has a task/requirements/delivery prompt', () => {
  const state = normalizeState({ promptVersion: 2, agents: [card('a', 'audio')] });
  const audio = state.agents.find((agent) => agent.role === 'audio');
  assert.equal(audio?.role, 'audio');
  assert.match(audio?.systemPrompt ?? '', /音频字幕 Agent/);
});

test('the old reserved audio card is renamed and enabled', () => {
  const state = normalizeState({ promptVersion: 2, agents: [{ ...card('a', 'audio'), name: '音频字幕（预留）', description: '暂未接入', enabled: false }] });
  const audio = state.agents.find((agent) => agent.role === 'audio');
  assert.equal(audio?.name, '音频字幕');
  assert.equal(audio?.enabled, true);
  assert.doesNotMatch(audio?.description ?? '', /预留|暂未接入/);
});

test('older states gain a planner card without replacing custom prompts', () => {
  const state = normalizeState({ promptVersion: 2, agents: [card('a', 'storyboard', { systemPrompt: 'my board prompt' })] });
  const planner = state.agents.find((agent) => agent.role === 'planner');
  assert.ok(planner);
  assert.match(planner.systemPrompt, /计划编排 Agent/);
  assert.equal(state.agents.find((agent) => agent.role === 'storyboard')?.systemPrompt, 'my board prompt');
});
