// @ts-check
/**
 * The developer's model-call log: what Studio asked a model, when, which agent/provider/model, how
 * long it took, what came back and how many tokens it used. HTTP endpoint noise is deliberately not
 * kept here; this is the model traffic a prompt or binding bug is debugged from.
 */
const MAX = 300;
/** @typedef {{ id: number, at: number, role: string, agent: string, provider: string, model: string, protocol: string, status: 'running' | 'ok' | 'error', ms: number, request: { system: string, messages: { role: string, content: string }[] }, reply: string, usage: { input?: number, output?: number, total?: number } | null, error: string }} ModelLog */
/** @type {ModelLog[]} */
const entries = [];
let next = 1;

const clip = (/** @type {unknown} */ value, /** @type {number} */ max) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return String(text ?? '').slice(0, max);
};

/** @param {{ role?: unknown, agent?: unknown, provider?: unknown, model?: unknown, protocol?: unknown, system?: unknown, messages?: unknown }} input */
export function beginModelCall(input) {
  const messages = Array.isArray(input.messages)
    ? input.messages.slice(-30).map((message) => {
      const row = message && typeof message === 'object' ? /** @type {Record<string, unknown>} */ (message) : {};
      return { role: clip(row.role ?? '', 20), content: clip(row.content ?? '', 30_000) };
    })
    : [];
  /** @type {ModelLog} */
  const entry = {
    id: next++,
    at: Date.now(),
    role: clip(input.role ?? '', 60) || 'model',
    agent: clip(input.agent ?? '', 120),
    provider: clip(input.provider ?? '', 120),
    model: clip(input.model ?? '', 200),
    protocol: clip(input.protocol ?? '', 80),
    status: 'running',
    ms: 0,
    request: { system: clip(input.system ?? '', 30_000), messages },
    reply: '',
    usage: null,
    error: '',
  };
  entries.push(entry);
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
  return entry.id;
}

/** @param {number} id @param {{ reply?: unknown, usage?: { input?: number, output?: number, total?: number } | null }} result */
export function finishModelCall(id, result = {}) {
  const entry = entries.find((item) => item.id === id);
  if (!entry) return;
  entry.status = 'ok';
  entry.ms = Math.max(0, Date.now() - entry.at);
  entry.reply = clip(result.reply ?? '', 30_000);
  entry.usage = result.usage ?? null;
}

/** @param {number} id @param {unknown} error */
export function failModelCall(id, error) {
  const entry = entries.find((item) => item.id === id);
  if (!entry) return;
  entry.status = 'error';
  entry.ms = Math.max(0, Date.now() - entry.at);
  entry.error = clip(error instanceof Error ? error.message : error, 4000);
}

/** Newest first. */
export function listModelCalls(/** @type {number} */ limit = 200) {
  return entries.slice(-Math.max(1, Math.min(MAX, limit))).reverse();
}

export function clearModelCalls() {
  entries.length = 0;
}
