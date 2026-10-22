// @ts-check
/**
 * Runtime for provider cards and agent cards: the HTTP side of the unified settings.
 *
 * Cards describe protocols; agents describe prompts and sampling. This module turns both into one
 * call without leaking keys to the page. Built-in media adapters are still resolved by the existing
 * `get.mjs`; this module owns chat, vision, embeddings, and the OpenAI-compatible custom paths.
 */
import { HttpError } from './http.mjs';
import { cardConnection } from './provider-cards.mjs';
import { agentFor, agentTarget } from './agent-cards.mjs';
import { findSkill, skillText } from '../../src/skills.mjs';

/** @typedef {import('./provider-cards.mjs').ProviderCard} ProviderCard */
/** @typedef {import('./provider-cards.mjs').Connection} Connection */
/** @typedef {import('./provider-cards.mjs').CardModel} CardModel */

/** A message in the chat shape used by the rest of the server. */
/** @typedef {{ role: 'system' | 'user' | 'assistant'; content: string | Array<Record<string, unknown>> }} ChatMessage */

/** The key for a connection: its own, or the environment variable it names. */
/** @returns {string} */
export function connectionKey(/** @type {Connection} */ connection) {
  if (connection.key) return connection.key;
  if (connection.keyEnv) return process.env[connection.keyEnv] ?? '';
  return '';
}

function endpoint(/** @type {string} */ base, /** @type {string} */ path) {
  const clean = String(base || '').replace(/\/+$/, '');
  if (!clean) throw new HttpError(409, '这个提供商还没有填写 Base URL');
  if (clean.endsWith(path)) return clean;
  return `${clean}${path}`;
}

function headersFor(/** @type {Connection} */ connection, /** @type {string} */ key, /** @type {string} */ contentType = 'application/json') {
  /** @type {Record<string, string>} */
  const headers = { 'content-type': contentType, ...(connection.headers ?? {}) };
  if (key && connection.auth === 'bearer') headers.authorization = `Bearer ${key}`;
  else if (key && connection.auth === 'api-key') headers[connection.authHeader || 'x-api-key'] = key;
  return headers;
}

function safeMessage(/** @type {string} */ service, /** @type {string} */ key, /** @type {string} */ body) {
  return body.split(key).join('???').slice(0, 600);
}

async function fetchJson(/** @type {string} */ service, /** @type {string} */ url, /** @type {RequestInit} */ init, /** @type {string} */ key, /** @type {number} */ timeoutMs = 120_000) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch (error) {
    if (/** @type {Error} */ (error).name === 'TimeoutError') throw new HttpError(504, `${service} 调用超时`);
    throw new HttpError(502, `${service} 连接失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const body = await response.text().catch(() => '');
  if (!response.ok) throw new HttpError(502, `${service} 返回 ${response.status}${body ? `：${safeMessage(service, key, body)}` : ''}`);
  try { return JSON.parse(body); } catch { throw new HttpError(502, `${service} 返回的不是 JSON`); }
}

/** One model call through its card's protocol. */
export async function callCard(/** @type {ProviderCard} */ card, /** @type {Connection} */ connection, /** @type {CardModel} */ model, /** @type {ChatMessage[]} */ messages, /** @type {{ systemPrompt?: string, temperature?: number, maxTokens?: number, topP?: number, signal?: AbortSignal }} */ options = {}) {
  const key = connectionKey(connection);
  if (connection.auth !== 'none' && !key) throw new HttpError(409, `“${card.name}”还没有设置 API Key`);
  const system = (options.systemPrompt ?? '').trim();
  const normalized = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const timeout = 120_000;
  const temperature = options.temperature ?? 0.2;
  const maxTokens = Math.max(64, Math.min(200_000, Math.round(options.maxTokens ?? 3000)));
  const topP = options.topP ?? 0.9;
  const service = card.name || card.vendorId;
  if (card.protocol === 'anthropic-messages') {
    const url = endpoint(connection.baseUrl, '/messages');
    const body = await fetchJson(service, url, {
      method: 'POST',
      headers: { ...headersFor(connection, key), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model.remoteName || model.id, max_tokens: maxTokens, temperature, top_p: topP, ...(system ? { system } : {}), messages: messages.filter((message) => message.role !== 'system') }),
    }, key, timeout);
    const content = Array.isArray(body?.content) ? body.content.map((/** @type {any} */ part) => part?.text ?? '').join('') : body?.content;
    if (typeof content !== 'string' || !content.trim()) throw new HttpError(502, '模型没有返回内容');
    return content;
  }
  if (card.protocol === 'gemini-generate') {
    const url = `${endpoint(connection.baseUrl, '')}/models/${encodeURIComponent(model.remoteName || model.id)}:generateContent?key=${encodeURIComponent(key)}`;
    const body = await fetchJson(service, url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: messages.filter((message) => message.role !== 'system').map((message) => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: typeof message.content === 'string' ? message.content : JSON.stringify(message.content) }] })),
        generationConfig: { temperature, maxOutputTokens: maxTokens, topP },
      }),
    }, key, timeout);
    const content = body?.candidates?.[0]?.content?.parts?.map((/** @type {any} */ part) => part?.text ?? '').join('');
    if (typeof content !== 'string' || !content.trim()) throw new HttpError(502, '模型没有返回内容');
    return content;
  }
  if (card.protocol === 'openai-responses') {
    const url = endpoint(connection.baseUrl, '/responses');
    const body = await fetchJson(service, url, {
      method: 'POST',
      headers: headersFor(connection, key),
      body: JSON.stringify({ model: model.remoteName || model.id, input: normalized, temperature, max_output_tokens: maxTokens, ...(card.category === 'web-search' ? { tools: [{ type: 'web_search_preview' }] } : {}) }),
    }, key, timeout);
    const content = body?.output_text ?? body?.output?.flatMap((/** @type {any} */ item) => item?.content ?? []).map((/** @type {any} */ part) => part?.text ?? '').join('');
    if (typeof content !== 'string' || !content.trim()) throw new HttpError(502, '模型没有返回内容');
    return content;
  }
  /* OpenAI Chat Completions; aliases and local OpenAI-compatible servers use this too. */
  const path = card.protocol === 'openai-chat' || card.protocol === 'openai-chat-search' || !card.protocol ? '/chat/completions' : `/${card.protocol}`;
  const url = endpoint(connection.baseUrl, path);
  const body = await fetchJson(service, url, {
    method: 'POST',
    headers: headersFor(connection, key),
    body: JSON.stringify({
      model: model.remoteName || model.id,
      messages: normalized,
      temperature,
      max_tokens: maxTokens,
      top_p: topP,
      stream: false,
      ...(card.options?.extraBody && typeof card.options.extraBody === 'object' ? card.options.extraBody : {}),
      ...(card.protocol === 'openai-chat-search' ? { enable_search: true } : {}),
    }),
  }, key, timeout);
  const content = body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.text ?? body?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new HttpError(502, '模型没有返回内容');
  return content;
}

/** A short test against a card's current (possibly unsaved) connection/model. */
export async function testConnection(/** @type {{ protocol?: string, category?: string, models?: CardModel[], modelId?: string, baseUrl?: string, key?: string, auth?: 'bearer' | 'api-key' | 'none', authHeader?: string, headers?: Record<string, string> }} */ input) {
  if (input.protocol === 'local-clip') return { ok: true, elapsedMs: 0, detail: '由本地索引 sidecar 提供' };
  const baseUrl = String(input.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) throw new HttpError(400, 'Base URL 不能为空');
  const key = String(input.key || '');
  const connection = /** @type {Connection} */ ({ id: 'test', vendorId: 'test', name: 'Provider', scope: 'cloud', baseUrl, auth: input.auth ?? 'bearer', authHeader: input.authHeader ?? 'x-api-key', key, headers: input.headers });
  const model = input.models?.find((item) => item.id === input.modelId) ?? input.models?.[0];
  const started = Date.now();
  if (input.category === 'embedding') {
    const url = endpoint(baseUrl, '/embeddings');
    const body = await fetchJson('Embedding', url, { method: 'POST', headers: headersFor(connection, key), body: JSON.stringify({ model: model?.remoteName || model?.id || 'default', input: 'ping' }) }, key, 30_000);
    const vector = body?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || !vector.length) throw new HttpError(502, 'Embedding 服务没有返回向量');
    return { ok: true, elapsedMs: Date.now() - started, detail: `${vector.length} 维` };
  }
  if (input.category === 'llm' || input.category === 'vl' || !input.category || input.category === 'web-search') {
    const content = await callCard(/** @type {ProviderCard} */ ({
      id: 'test', vendorId: 'test', name: 'Provider', category: input.category === 'vl' ? 'vl' : 'llm', scope: 'cloud',
      protocol: input.protocol || 'openai-chat', connectionId: 'test', models: [], defaultModelId: '', enabled: true, order: 0,
    }), connection, model ?? { id: 'default', name: 'Default' }, [{ role: 'user', content: 'Reply with exactly: OK' }], { temperature: 0, maxTokens: 32, topP: 1 });
    return { ok: true, elapsedMs: Date.now() - started, detail: content.trim().slice(0, 80) };
  }
  /* Media endpoints without a standard cheap probe: check that the address answers at all. */
  const response = await fetch(`${baseUrl}/models`, { headers: headersFor(connection, key), signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!response) throw new HttpError(502, '地址无法连接');
  return { ok: response.status < 500, elapsedMs: Date.now() - started, detail: `HTTP ${response.status}` };
}

/** Whether a work slot has an enabled agent with a bound model. */
export function agentReady(/** @type {string} */ role) {
  const agent = agentFor(/** @type {any} */ (role));
  return Boolean(agent && agentTarget(agent));
}

/** The system prompt for a role, or null. */
export function agentPrompt(/** @type {string} */ role) {
  return agentFor(/** @type {any} */ (role))?.systemPrompt ?? null;
}

/** A call through the enabled agent for one work slot. `project` lets mounted project skills resolve. */
export async function callAgent(
  /** @type {string} */ role,
  /** @type {ChatMessage[]} */ messages,
  /** @type {{ project?: { path: string } | null }} */ context = {},
) {
  const agent = agentFor(/** @type {any} */ (role));
  if (!agent) throw new HttpError(409, '这一步没有启用的智能体');
  const target = agentTarget(agent);
  if (!target) throw new HttpError(409, `智能体“${agent.name}”还没有绑定可用的模型`);
  const connection = cardConnection(target.card, target.state);
  if (!connection) throw new HttpError(409, '智能体绑定的提供商连接不存在');
  /* Mounted skills are read here, once, and appended to this agent's system prompt. A skill that
     was deleted after being mounted is skipped rather than failing the whole run. */
  let systemPrompt = agent.systemPrompt;
  const mounted = [];
  for (const name of agent.skills) {
    const skill = findSkill(name, { project: context.project?.path ?? null });
    if (!skill) continue;
    try { mounted.push(skillText(skill)); } catch { /* the file moved: leave it out */ }
  }
  if (mounted.length) {
    systemPrompt = `${systemPrompt}\n\n<agent_skills>\nThese skills are mounted on you. Read and follow them when they fit the work.\n${mounted.join('\n\n')}\n</agent_skills>`;
  }
  return callCard(target.card, connection, target.model, messages, {
    systemPrompt,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens,
    topP: agent.topP,
  });
}

/** Parse JSON from a model reply, including a fenced code block. */
export function parseJsonReply(/** @type {string} */ content) {
  const value = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(value); } catch { /* try the first object */ }
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(value.slice(start, end + 1)); } catch { /* not JSON */ }
  }
  throw new HttpError(502, '模型返回的内容不是有效的分镜 JSON');
}

export function storyboardSchemaHint() {
  return '{"title":"string","brief":{"durationMs":30000,"aspect":"16:9","tone":"string","notes":"string"},"scenes":[{"title":"string","shots":[{"title":"string","narration":"string","visualIntent":"string","must":["string"],"avoid":["string"],"targetMs":4000}]}]}';
}
