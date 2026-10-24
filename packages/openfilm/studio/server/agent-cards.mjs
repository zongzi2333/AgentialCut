// @ts-check
/**
 * Agent cards: the editable prompts, model bindings and sampling settings behind the storyboard work.
 *
 * Every card has the same shape. Five cards start as the default work slots (storyboard, director,
 * query planning, visual review, continuity/assembly); a person's own card is not a different kind of
 * object. A card with a work slot takes part in that step; at most one enabled card owns a slot, so a
 * custom card can replace a default without creating an ambiguous pipeline. Deleting a default is
 * allowed; the step then reports that it has no agent instead of silently using a deleted prompt.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { studioHome } from './projects.mjs';
import { HttpError } from './http.mjs';
import { writeAtomic } from './atomic.mjs';
import { readProviderState } from './provider-cards.mjs';

/** @typedef {'storyboard' | 'director' | 'query' | 'verify' | 'continuity'} AgentRole */
/** @typedef {{ id: string, name: string, role: AgentRole | '', description: string, enabled: boolean, order: number, cardId: string, modelId: string, systemPrompt: string, temperature: number, maxTokens: number, topP: number, tools: string[], skills: string[] }} AgentCard */
/** @typedef {{ revision: number, agents: AgentCard[] }} AgentState */

export const AGENT_ROLES = /** @type {const} */ ([
  { id: 'storyboard', label: '分镜规划', hint: '把脚本/想法拆成镜头卡' },
  { id: 'director', label: '导演对话', hint: '把自然语言变成受控修改提案' },
  { id: 'query', label: '检索规划', hint: '为每个镜头生成检索词和硬条件' },
  { id: 'verify', label: '画面审核', hint: '用视觉模型判断候选画面是否合适' },
  { id: 'continuity', label: '连续性 / 装配', hint: '检查重复、节奏、景别与粗剪顺序' },
]);
const ROLE_IDS = new Set(AGENT_ROLES.map((role) => role.id));
const FILE = () => join(studioHome(), 'agent-cards.json');
const id = (/** @type {string} */ prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;
const text = (/** @type {unknown} */ value, /** @type {number} */ max) => String(value ?? '').trim().slice(0, max);
/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
const number = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const DEFAULT_PROMPTS = /** @type {Record<AgentRole, string>} */ ({
  storyboard: `你是 OpenFilm 的分镜规划 Agent。把输入的脚本、简报或一句话拆成可拍摄、可匹配素材的分镜。
只返回 JSON，字段为 title、brief、scenes、shots。每个 shot 要有 title、narration、visualIntent、must、avoid、targetMs。
保持原文事实和顺序，不编造台词；画面要求要具体，写清景别、环境、动作和不能出现的内容。没有素材依据时不要假装已经匹配。`,
  director: `你是 OpenFilm 的导演 Agent。用户已经授权你直接修改分镜，系统会用撤销兜底，所以不要只给提案，也不要把“要不要改”问回给用户。
只返回 JSON：{"reply":"简短中文说明","operations":[],"intent":"edit|match|none"}。每条操作都必须有 type。允许的操作：
setTargetDuration {durationMs}；distributeDurations {durationMs?}（按内容自行分配长短镜头）；setShotDuration {shotId,targetMs}；
updateShot {shotId,patch}；deleteShot {shotId}；duplicateShot {shotId}；reorderShots {shotIds}；moveShot {shotId,index}；
addShot {sceneId?,index?,shot}；addScene {title}；updateScene {sceneId,title}；setMatch {shotId,candidateId}；clearMatch {shotId}；
rematchShots {shotIds?}；setBrief {brief}。
用户说“你决定时长/调整节奏/减少重复/保持开头”等要求时，直接根据内容生成完整 operations，不要要求用户再指定秒数或镜头。
不得修改锁定镜头，不得编造素材路径；确实无法执行的要求才在 reply 里说明。`,
  query: `你是 OpenFilm 的检索规划 Agent。为每个镜头生成 1-3 条适合视觉语义检索的中文查询，并提取必须满足、必须避免、时长范围、景别和运镜条件。
查询要具体到画面，不要只复述旁白。只返回可解析的 JSON。`,
  verify: `你是 OpenFilm 的画面审核 Agent。根据镜头的画面意图、必须/避免条件和候选视频的关键帧，判断候选是否适合。
只返回 JSON：{"candidates":[{"index":1,"verdict":"pass | uncertain | fail","confidence":0,"reason":"简短理由","desc":"一到两句中文，描述这个候选画面实际能看到的内容"}]}。
desc 只写画面里真实可见的主体、环境、动作、景别和氛围，不要编造；不要因为分数高就通过，也不要伪造你没有看到的画面。`,
  continuity: `你是 OpenFilm 的连续性与装配 Agent。检查相邻镜头的景别、运镜、人物方向、重复素材、节奏和目标时长。
只提出可执行的调整建议，不伪造素材，不修改锁定镜头。输出简洁的 JSON 或逐条问题清单。`,
});

const DEFAULTS = /** @type {AgentCard[]} */ ([
  { id: 'agent_storyboard', name: '分镜规划', role: 'storyboard', description: '脚本/一句话 → 分镜卡', enabled: true, order: 0, cardId: '', modelId: '', systemPrompt: DEFAULT_PROMPTS.storyboard, temperature: 0.45, maxTokens: 6000, topP: 0.95, tools: [], skills: [] },
  { id: 'agent_director', name: '导演对话', role: 'director', description: '对话 → 修改提案', enabled: true, order: 1, cardId: '', modelId: '', systemPrompt: DEFAULT_PROMPTS.director, temperature: 0.2, maxTokens: 2500, topP: 0.9, tools: [], skills: [] },
  { id: 'agent_query', name: '检索规划', role: 'query', description: '镜头 → 检索计划', enabled: true, order: 2, cardId: '', modelId: '', systemPrompt: DEFAULT_PROMPTS.query, temperature: 0.2, maxTokens: 2000, topP: 0.9, tools: ['web-search'], skills: [] },
  { id: 'agent_verify', name: '画面审核', role: 'verify', description: '候选画面 → 置信度与理由', enabled: true, order: 3, cardId: '', modelId: '', systemPrompt: DEFAULT_PROMPTS.verify, temperature: 0, maxTokens: 1200, topP: 1, tools: [], skills: [] },
  { id: 'agent_continuity', name: '连续性 / 装配', role: 'continuity', description: '全片节奏与粗剪顺序', enabled: true, order: 4, cardId: '', modelId: '', systemPrompt: DEFAULT_PROMPTS.continuity, temperature: 0.1, maxTokens: 2500, topP: 0.9, tools: [], skills: [] },
]);

export function defaultPrompts() { return { ...DEFAULT_PROMPTS }; }

/** Read the cards; a missing file starts with the five defaults and, when possible, their old model bindings. */
export function readAgentState() {
  if (!existsSync(FILE())) return migrate();
  try { return normalizeState(JSON.parse(readFileSync(FILE(), 'utf8'))); }
  catch { throw new HttpError(500, 'The agent cards file is not valid JSON. Nothing was overwritten.'); }
}

export function normalizeState(/** @type {unknown} */ input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? /** @type {Record<string, any>} */ (input) : {};
  const seenRoles = new Set();
  const agents = /** @type {AgentCard[]} */ ((Array.isArray(raw.agents) ? raw.agents : []).slice(0, 80).map((item, index) => {
    if (!item || typeof item !== 'object') return null;
    const role = ROLE_IDS.has(item.role) ? /** @type {AgentRole} */ (item.role) : '';
    let enabled = item.enabled !== false;
    /* one active owner per work slot: a second enabled card is kept but paused, never ambiguous */
    if (role) {
      if (seenRoles.has(role)) enabled = false;
      else if (enabled) seenRoles.add(role);
    }
    return /** @type {AgentCard} */ ({
      id: text(item.id, 80) || id('agent'),
      name: text(item.name, 120) || 'Agent',
      role,
      description: text(item.description, 300),
      enabled,
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
      cardId: text(item.cardId, 80),
      modelId: text(item.modelId, 200),
      systemPrompt: (() => {
        const asked = text(item.systemPrompt, 30_000);
        /* the old default told the director to propose, not edit: people who never changed it get
           the direct-edit default, while a custom prompt is kept untouched */
        if (role === 'director' && (!asked || /不直接修改项目|受控编辑提案/.test(asked))) return DEFAULT_PROMPTS.director;
        if (role === 'verify' && (!asked || (asked.includes('你是 OpenFilm 的画面审核 Agent') && !asked.includes('desc')))) return DEFAULT_PROMPTS.verify;
        return asked || (role ? DEFAULT_PROMPTS[role] : '');
      })(),
      temperature: number(item.temperature, 0.2, 0, 2),
      maxTokens: Math.round(number(item.maxTokens, 3000, 64, 200_000)),
      topP: number(item.topP, 0.9, 0.01, 1),
      tools: Array.isArray(item.tools) ? item.tools.map((/** @type {unknown} */ tool) => text(tool, 60)).filter(Boolean).slice(0, 12) : [],
      skills: Array.isArray(item.skills) ? [...new Set(item.skills.map((/** @type {unknown} */ skill) => text(skill, 80)).filter((/** @type {string} */ skill) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(skill)))].slice(0, 40) : [],
    });
  }).filter(Boolean));
  agents.sort((a, b) => a.order - b.order).forEach((agent, index) => { agent.order = index; });
  return /** @type {AgentState} */ ({ revision: Number(raw.revision) || 0, agents });
}

export async function saveAgentState(/** @type {unknown} */ input) {
  const previous = readAgentState();
  const next = normalizeState({ ...(input && typeof input === 'object' ? input : {}), revision: previous.revision + 1 });
  await mkdir(studioHome(), { recursive: true, mode: 0o700 });
  await writeAtomic(FILE(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

/** The enabled card for a work slot. null: the person deleted or paused it; the caller says so. */
export function agentFor(/** @type {AgentRole} */ role, /** @type {AgentState} */ state = readAgentState()) {
  return state.agents.find((agent) => agent.role === role && agent.enabled) ?? null;
}

/** Resolve the provider card/model an agent points at. */
export function agentTarget(/** @type {AgentCard} */ agent) {
  const state = readProviderState();
  const card = state.cards.find((item) => item.id === agent.cardId);
  if (!card) return null;
  const model = card.models.find((item) => item.id === agent.modelId) ?? card.models[0];
  if (!model) return null;
  return { state, card, model };
}

/** The first enabled card for a capability, used as the default a new agent card binds to. */
export function defaultTarget(/** @type {'llm' | 'vl'} */ category) {
  const state = readProviderState();
  const card = state.cards.find((item) => cardEnabled(item, category)) ?? null;
  if (!card) return null;
  return { cardId: card.id, modelId: card.models[0]?.id ?? '' };
}

function cardEnabled(/** @type {any} */ card, /** @type {string} */ category) {
  return card.enabled && card.category === category;
}

/** First-run migration: keep the old storyboard/director/verify model bindings when their model still exists. */
function migrate() {
  const providerState = readProviderState();
  /** @type {any} */
  let old = {};
  try { old = JSON.parse(readFileSync(join(studioHome(), 'ai-agents.json'), 'utf8')); } catch { /* none */ }
  const oldModelCard = (/** @type {unknown} */ modelId) => {
    if (typeof modelId !== 'string' || !modelId) return null;
    const card = providerState.cards.find((item) => item.models.some((model) => model.id === modelId));
    const model = card?.models.find((item) => item.id === modelId);
    return card && model ? { cardId: card.id, modelId: model.id } : null;
  };
  const agents = DEFAULTS.map((agent) => {
    const legacy = agent.role === 'storyboard' ? old?.agents?.storyboard : agent.role === 'director' || agent.role === 'query' ? old?.agents?.director : agent.role === 'verify' ? old?.agents?.verify : '';
    const found = oldModelCard(legacy);
    return found ? { ...agent, ...found } : { ...agent };
  });
  const state = { revision: 1, agents };
  try { writeAtomic(FILE(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); } catch { /* first save can retry */ }
  return state;
}
