import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { conversationReact } from './agent-react.mjs';

const project = () => ({ id: 'react_test', name: 'React Test', path: mkdtempSync(join(tmpdir(), 'openfilm-react-')) });

test('a conversation calls a controlled tool, sees its result, and then answers', async () => {
  const p = project();
  let turn = 0;
  const result = await conversationReact(p, {
    text: '读一下项目',
    scope: 'storyboard',
    selectedIds: [],
    runAgent: async () => {
      turn += 1;
      return turn === 1
        ? JSON.stringify({ reply: '先读项目', tool: 'read_project', arguments: {}, intent: 'none' })
        : JSON.stringify({ reply: '项目已读取。', tool: null, intent: 'none' });
    },
  }, { search: async () => ({ hits: [], meta: null }) });

  assert.equal(result.status, 'done');
  assert.equal(result.reply, '项目已读取。');
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, 'read_project');
  assert.equal(result.toolCalls[0].status, 'done');
  assert.equal(result.applied, false);
});

test('an unavailable tool is refused instead of being executed', async () => {
  const p = project();
  let turn = 0;
  const result = await conversationReact(p, {
    text: '改时间线',
    scope: 'storyboard',
    runAgent: async () => {
      turn += 1;
      return turn === 1
        ? JSON.stringify({ reply: '', tool: 'edit_timeline', arguments: { ops: [] } })
        : JSON.stringify({ reply: '不能在这个阶段修改时间线。', tool: null });
    },
  }, { search: async () => ({ hits: [], meta: null }) });

  assert.equal(result.status, 'done');
  assert.equal(result.applied, false);
  assert.ok(result.issues.some((issue) => issue.includes('不允许的工具')));
  assert.equal(result.toolCalls.length, 0);
});

test('the audio scope reads the mix but cannot use storyboard tools', async () => {
  const p = project();
  let turn = 0;
  const result = await conversationReact(p, {
    text: '看一下当前混音',
    scope: 'audio',
    runAgent: async () => {
      turn += 1;
      return turn === 1
        ? JSON.stringify({ reply: '读取混音', tool: 'read_audio', arguments: {} })
        : JSON.stringify({ reply: '当前没有音频片段。', tool: null });
    },
  }, { search: async () => ({ hits: [], meta: null }) });

  assert.equal(result.status, 'done');
  assert.equal(result.toolCalls[0].name, 'read_audio');
  assert.equal(result.applied, false);
});

test('the audio scope can read captions without exposing storyboard tools', async () => {
  const p = project();
  let turn = 0;
  const result = await conversationReact(p, {
    text: '看看字幕',
    scope: 'audio',
    runAgent: async () => {
      turn += 1;
      return turn === 1
        ? JSON.stringify({ reply: '读取字幕', tool: 'read_captions', arguments: {} })
        : JSON.stringify({ reply: '当前没有字幕。', tool: null });
    },
  }, { search: async () => ({ hits: [], meta: null }) });
  assert.equal(result.status, 'done');
  assert.equal(result.toolCalls[0].name, 'read_captions');
});

test('ask_user stops the round and returns options for the panel', async () => {
  const p = project();
  const result = await conversationReact(p, {
    text: '帮我选',
    scope: 'storyboard',
    runAgent: async () => JSON.stringify({
      reply: '需要确定方向。',
      tool: 'ask_user',
      arguments: { question: '要保留哪个风格？', options: ['纪实', '广告'] },
    }),
  }, { search: async () => ({ hits: [], meta: null }) });

  assert.equal(result.status, 'needs_input');
  assert.equal(result.question, '要保留哪个风格？');
  assert.deepEqual(result.questionOptions, ['纪实', '广告']);
  assert.equal(result.toolCalls.length, 1);
});
