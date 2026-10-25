// @ts-check
/**
 * The browser conversation's memory: one small document per project, split by scope.
 *
 * It is deliberately separate from `.film/chat/` (the desktop agents' own conversation logs):
 * Studio's storyboard and edit panes both read and append here, so switching steps or closing a
 * pane does not lose what was said. The model receives only the last few messages; the panel gets
 * the stored text.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './atomic.mjs';

const FILE = 'agent-chat.json';
const MAX_MESSAGES = 80;
const MAX_TEXT = 20_000;
/** Older builds answered with approval-gate refusals; they are not part of this conversation any more. */
const LEGACY_GATE = /审批门|分镜审批|必须回.*审批|不能直接执行|需要回到.*审批/;
/** @typedef {'storyboard' | 'edit'} ChatScope */
/** @typedef {{ id: string, role: 'user' | 'agent', text: string, at: number }} ChatMessage */

const fileOf = (/** @type {{ path: string }} */ project) => join(project.path, '.film', FILE);

/** Keep only what the UI can render and the model can read. */
function normalizeMessages(/** @type {unknown} */ value) {
  const messages = (Array.isArray(value) ? value : []).flatMap((item) => {
    const raw = item && typeof item === 'object' ? /** @type {Record<string, any>} */ (item) : {};
    const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, MAX_TEXT) : '';
    if (!text) return [];
    if (raw.role === 'agent' && LEGACY_GATE.test(text)) return [];
    return [{
      id: typeof raw.id === 'string' && raw.id ? raw.id : `chat_${randomBytes(6).toString('hex')}`,
      role: /** @type {'user' | 'agent'} */ (raw.role === 'agent' ? 'agent' : 'user'),
      text,
      at: Number.isFinite(Number(raw.at)) ? Number(raw.at) : Date.now(),
    }];
  }).slice(-MAX_MESSAGES);
  /* Re-asking the same thing after a gate refusal should read as one request in the model context. */
  return messages.filter((message, index) => {
    const before = messages[index - 1];
    return !(message.role === 'user' && before?.role === 'user' && before.text === message.text);
  });
}

async function readAll(/** @type {{ path: string }} */ project) {
  try {
    const raw = JSON.parse(await readFile(fileOf(project), 'utf8'));
    return {
      version: 1,
      storyboard: normalizeMessages(raw?.storyboard),
      edit: normalizeMessages(raw?.edit),
    };
  } catch {
    return { version: 1, storyboard: [], edit: [] };
  }
}

/** @param {{ path: string }} project @param {ChatScope} scope @returns {Promise<ChatMessage[]>} */
export async function readAgentChat(project, scope) {
  const all = await readAll(project);
  return scope === 'edit' ? all.edit : all.storyboard;
}

/** Append one message, keeping the file bounded. */
export async function appendAgentChat(/** @type {{ path: string }} */ project, /** @type {ChatScope} */ scope, /** @type {{ role: 'user' | 'agent', text: string }} */ message) {
  const all = await readAll(project);
  const list = scope === 'edit' ? all.edit : all.storyboard;
  const normalized = normalizeMessages([...list, { ...message, id: `chat_${randomBytes(6).toString('hex')}`, at: Date.now() }]);
  const next = {
    version: 1,
    storyboard: scope === 'edit' ? all.storyboard : normalized,
    edit: scope === 'edit' ? normalized : all.edit,
  };
  await mkdir(join(project.path, '.film'), { recursive: true });
  await writeAtomic(fileOf(project), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return normalized.at(-1) ?? null;
}

/** Clear one scope, leaving the other as it is. */
export async function clearAgentChat(/** @type {{ path: string }} */ project, /** @type {ChatScope} */ scope) {
  const all = await readAll(project);
  const next = {
    version: 1,
    storyboard: scope === 'edit' ? all.storyboard : [],
    edit: scope === 'edit' ? [] : all.edit,
  };
  await mkdir(join(project.path, '.film'), { recursive: true });
  await writeAtomic(fileOf(project), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}
