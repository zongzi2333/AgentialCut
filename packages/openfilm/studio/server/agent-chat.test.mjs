import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAgentChat, clearAgentChat, readAgentChat } from './agent-chat.mjs';

const project = () => ({ id: 'p', name: 'P', path: mkdtempSync(join(tmpdir(), 'openfilm-chat-')) });

test('browser conversations are remembered per scope, without legacy gate refusals', async () => {
  const p = project();
  await appendAgentChat(p, 'storyboard', { role: 'user', text: '删除全部分镜' });
  await appendAgentChat(p, 'storyboard', { role: 'agent', text: '这属于必须回分镜审批门的改动，不能直接执行。' });
  await appendAgentChat(p, 'edit', { role: 'user', text: '只改时间线' });

  const storyboard = await readAgentChat(p, 'storyboard');
  const edit = await readAgentChat(p, 'edit');
  assert.deepEqual(storyboard.map((m) => [m.role, m.text]), [['user', '删除全部分镜']]);
  assert.deepEqual(edit.map((m) => [m.role, m.text]), [['user', '只改时间线']]);

  await clearAgentChat(p, 'edit');
  assert.deepEqual(await readAgentChat(p, 'edit'), []);
  assert.equal((await readAgentChat(p, 'storyboard')).length, 1);
});
