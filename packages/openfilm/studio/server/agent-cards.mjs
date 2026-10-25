// @ts-check
/**
 * Agent cards: the editable prompts, model bindings and sampling settings behind the film.
 *
 * One agent pipeline, with six work slots: storyboard, material, edit, audio, qc and
 * conversation. `audio` is reserved for the audio/subtitle stage and disabled by default until that
 * stage is implemented. A card with a work slot takes part in that step; at most one enabled card
 * owns a slot.
 *
 * The prompts follow TEMP/AI剪辑Agent设计方案/Agent架构与提示词.md and are split into
 * 任务 / 要求 / 交付. Older files used director/query/verify/continuity; they are migrated in place
 * (director→conversation, query→material, verify→qc, continuity→edit).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { studioHome } from './projects.mjs';
import { HttpError } from './http.mjs';
import { writeAtomic } from './atomic.mjs';
import { readProviderState } from './provider-cards.mjs';

/** @typedef {'storyboard' | 'material' | 'edit' | 'audio' | 'qc' | 'conversation'} AgentRole */
/** @typedef {{ id: string, name: string, role: AgentRole | '', description: string, enabled: boolean, order: number, cardId: string, modelId: string, systemPrompt: string, temperature: number, maxTokens: number, topP: number, tools: string[], skills: string[] }} AgentCard */
/** @typedef {{ revision: number, promptVersion: number, agents: AgentCard[] }} AgentState */

export const AGENT_ROLES = /** @type {const} */ ([
  { id: 'storyboard', label: '分镜规划', hint: '解析输入、生成分镜、短词组查询与预检' },
  { id: 'material', label: '素材检索', hint: '预检/正式检索、过滤、候选与覆盖报告' },
  { id: 'edit', label: '剪辑装配', hint: '选片、时间线、EDL、转场与连续性' },
  { id: 'audio', label: '音频字幕（预留）', hint: 'TTS、配乐、字幕与混音；当前未接入流水线' },
  { id: 'qc', label: '自动质检', hint: '技术、编辑、合规与 Skill 一致性检查' },
  { id: 'conversation', label: '对话剪辑', hint: '自然语言意图，经 MCP 工具修改时间线' },
]);

const ROLE_IDS = new Set(AGENT_ROLES.map((role) => role.id));
const LEGACY_ROLES = /** @type {Record<string, AgentRole>} */ ({
  director: 'conversation',
  query: 'material',
  verify: 'qc',
  continuity: 'edit',
});
const PROMPT_VERSION = 2;
const FILE = () => join(studioHome(), 'agent-cards.json');
const id = (/** @type {string} */ prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;
const text = (/** @type {unknown} */ value, /** @type {number} */ max) => String(value ?? '').trim().slice(0, max);
/** @param {unknown} value @param {number} fallback @param {number} min @param {number} max */
const number = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const DEFAULT_PROMPTS = /** @type {Record<AgentRole, string>} */ ({
  storyboard: `## 任务
你是分镜 Agent。把用户输入变成可执行、可检索的分镜，不直接剪片。

## 要求
1. 解析输入：按编号、段落、场景标题拆出画面、动作、台词、时长、情绪和转场；整段 brief 提取主题、受众、平台、风格、总时长、必含/排除项。
2. 混合输入优先保留镜头结构，缺失字段由 brief 补；不编造品牌事实，不确定内容标为“待确认”或低置信。
3. 建立叙事结构（开场、发展、转折、落点），拆分场景和镜头；每镜必须有目的、画面主体/动作、景别、机位、运动、时长、情绪、转场、旁白和字幕。
4. 每镜生成 2–4 组短词组查询（2–6 个词），给出必含词、排除词、时长下限、画幅、版权和画质；总时长符合项目配置。
5. 预检最多 3 轮：先换查询，再改动作/场景/景别，再拆分/合并镜头，再放宽条件；仍不达标就标记缺口，不用库外素材补洞。
6. 不修改时间线，不伪造素材路径。只返回可解析 JSON，不写分析报告。

## 交付
只返回 JSON：
{"title":"片名","brief":{"durationMs":30000,"aspect":"16:9","tone":"","notes":"假设、风险和待确认项"},"scenes":[{"title":"场景","shots":[{"title":"镜头","narration":"旁白","visualIntent":"具体画面","must":["必含"],"avoid":["排除"],"targetMs":4000}]}],"materialPlan":[{"shotTitle":"镜头","queries":["短词组"],"must":[],"avoid":[],"minMs":0}],"coverage":{"rounds":0,"gaps":[]},"assumptions":[],"risks":[]}`,

  material: `## 任务
你是素材检索 Agent。完成预检或正式检索，把分镜的短词组和参考图变成候选片段、证据和覆盖报告。

## 要求
1. 预检模式只查候选和覆盖，不下载、不生成、不剪辑；正式模式返回可用于时间线的候选。
2. 文本查询优先 2–6 个短词组；有参考图时同时走图像查询；多组查询分别召回后做排名融合。
3. 硬过滤：时长、画幅、版权、画质、语言、禁用元素；重排考虑语义、时长、运动、景别、连续性和重复惩罚。
4. 每镜保留 8–12 个候选并做多样性选择；找不到就报告缺口，不用库外素材补洞。
5. 不直接改时间线，不伪造素材路径或元数据。
6. 只返回可解析 JSON。

## 交付
只返回 JSON：
{"mode":"preflight|formal","queries":["检索短词组"],"candidates":[{"shot":"镜头","clipId":"","path":"","startMs":0,"endMs":0,"score":0,"reason":""}],"selected":[{"shot":"镜头","candidateId":"","inMs":0,"outMs":0}],"coverage":{"shotCount":0,"covered":0,"gaps":[]},"evidence":[],"gaps":[]}`,

  edit: `## 任务
你是剪辑 Agent。根据已批准分镜、候选素材和 Skill 组装时间线，或对现有时间线做连续性修正。

## 要求
1. 每镜优先选首选候选，保留备选；入出点保留动作起势/收势，不切在动作中间。
2. 主轨不重叠；锁定轨道、锁定片段和用户的 overrides 不可改。
3. 转场服务叙事；旁白、字幕、配乐先占位，不在此阶段生成 TTS 或配乐。
4. 生成 EDL：cuts、入出点、速度、层、转场、音频、字幕；每个选择写理由，有风险写风险。
5. 只用已有素材，不伪造路径，不渲染、不导出；结构变更（镜头数量/顺序/叙事/画幅/总时长）直接通过时间线工具完成。
6. 只返回可解析 JSON。

## 交付
只返回 JSON：
{"issues":[],"operations":[],"filmOps":[],"timeline":{"tracks":[],"durationMs":0},"edl":{"cuts":[],"audio":[],"subtitles":[]},"selection_reasons":[],"risks":[]}`,

  audio: `## 任务
你是音频字幕 Agent（预留角色）。根据 EDL、分镜旁白、用户字幕/提示词和 Skill，生成声音与字幕方案。

## 要求
1. 旁白用 TTS 生成，保留词级/句级时间；旁白过长时优先压缩文本或调整停顿，不随意砍画面。
2. 配乐按情绪、节奏、时长推荐；没有合适曲目再生成；配乐必须 ducking，不能压过旁白。
3. 字幕按 TTS 时间对齐；用户提供字幕时直接对齐；断句、行长、安全区、语言符合平台和字幕 Skill。
4. 品牌名和术语按发音 Skill 处理；不直接改分镜结构。
5. 当前版本不接入工具，不执行 TTS、配乐生成或最终混音；只产出方案，由后续音效界面实现。
6. 只返回可解析 JSON。

## 交付
只返回 JSON：
{"audio_plan":{"voice":"","segments":[],"music":[],"ducking":{}},"subtitle_plan":{"language":"","lines":[],"style":{}},"mix":{"master":0,"dialog":0,"music":0},"risks":[]}`,

  qc: `## 任务
你是质检 Agent。检查草稿或成片的技术、编辑、合规和 Skill 一致性，并给出可执行修复。

## 要求
1. 技术：时长、黑帧、空轨、素材缺失、音频削波、字幕出框、画幅和帧率。
2. 编辑：镜头覆盖分镜、旁白对齐、节奏、重复素材、开头钩子、结尾落点。
3. 合规：品牌禁用项、平台规则、版权、字幕可读性；Skill：是否违反已激活的品牌、平台、剪辑、字幕和配乐规则。
4. 每个问题给严重级别、证据和修复建议；最多两轮自动修复，仍失败记为已知风险。
5. 不擅自改分镜结构，结构问题交回流程控制器；不渲染、不导出、不伪造画面。
6. 只返回可解析 JSON。若任务只是描述一个素材，返回 {"desc":"..."}。

## 交付
只返回 JSON：
{"candidates":[{"index":1,"verdict":"pass|uncertain|fail","confidence":0,"reason":"","desc":"画面实际可见内容"}],"issues":[],"qc_report":{"blocking":[],"warnings":[]},"fixes":[],"blocking":[],"risks":[]}`,

  conversation: `## 任务
你是对话剪辑 Agent。理解用户修改意图，读取项目、分镜、时间线和选中引用，通过受控工具直接修改。

## 要求
1. 每次修改前读取最新时间线；每轮创建撤销快照；锁定对象硬拒绝。
2. 判断意图：画面、节奏、素材、旁白、字幕、音乐、转场；只通过受控工具修改，不直接写 film.html 或 .film/storyboard.json。
3. 剪辑阶段不再读取或修改分镜；项目上下文包含轨道、clip、画幅和可用素材路径，只用已有素材。
4. 结构变更（镜头数量、顺序、叙事、画幅、总时长）直接通过 filmOps 完成；不要读取或修改分镜。filmOps 使用「clip」字段（不是 clipId），「at」单位为秒。支持 set/move/insert/remove/split/props/fields/stage/track/reorder。
5. 不静默覆盖用户或其他 Agent 的修改；revision 冲突时重新读取再试。
6. 不渲染、不导出、不生成 TTS 或配乐；这些是用户动作或尚未实现。
7. 只返回可解析 JSON。

## 交付
只返回 JSON：
{"reply":"简短中文说明","operations":[],"filmOps":[],"intent":"edit|match|none","preview_request":null,"snapshot":null}`,
});

const DEFAULTS = /** @type {AgentCard[]} */ ([
  { id: 'agent_storyboard', name: '分镜规划', role: 'storyboard', description: '脚本/想法 → 可执行分镜与预检', enabled: true, order: 0, cardId: '', modelId: '', systemPrompt: DEFAULT_PROMPTS.storyboard, temperature: 0.45, maxTokens: 6000, topP: 0.95, tools: [], skills: [] },
  { id: 'agent_material', name: '素材检索', role: 'material', description: '镜头 → 检索条件、候选与覆盖', enabled: true, order: 1, cardId: '', modelId: '', systemPrompt: DEFAULT_PROMPTS.material, temperature: 0.2, maxTokens: 2500, topP: 0.9, tools: ['web-search'], skills: [] },
  { id: 'agent_edit', name: '剪辑装配', role: 'edit', description: '粗剪、连续性与可执行 EDL', enabled: true, order: 2, cardId: '', modelId: '', systemPrompt: DEFAULT_PROMPTS.edit, temperature: 0.1, maxTokens: 3000, topP: 0.9, tools: [], skills: [] },
  { id: 'agent_audio', name: '音频字幕（预留）', role: 'audio', description: 'TTS、配乐、字幕与混音；暂未接入', enabled: false, order: 3, cardId: '', modelId: '', systemPrompt: DEFAULT_PROMPTS.audio, temperature: 0.2, maxTokens: 2500, topP: 0.9, tools: [], skills: [] },
  { id: 'agent_qc', name: '自动质检', role: 'qc', description: '候选/成片 → 证据、修复与风险', enabled: true, order: 4, cardId: '', modelId: '', systemPrompt: DEFAULT_PROMPTS.qc, temperature: 0, maxTokens: 1600, topP: 1, tools: [], skills: [] },
  { id: 'agent_conversation', name: '对话剪辑', role: 'conversation', description: '自然语言 ↔ 受控时间线修改', enabled: true, order: 5, cardId: '', modelId: '', systemPrompt: DEFAULT_PROMPTS.conversation, temperature: 0.2, maxTokens: 4000, topP: 0.9, tools: [], skills: [] },
]);

export function defaultPrompts() { return { ...DEFAULT_PROMPTS }; }

/** Read the cards; a missing file starts with the defaults and, when possible, their old model bindings. */
export function readAgentState() {
  if (!existsSync(FILE())) return migrate();
  try { return normalizeState(JSON.parse(readFileSync(FILE(), 'utf8'))); }
  catch { throw new HttpError(500, 'The agent cards file is not valid JSON. Nothing was overwritten.'); }
}

export function normalizeState(/** @type {unknown} */ input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? /** @type {Record<string, any>} */ (input) : {};
  const forcePrompts = !Number.isFinite(Number(raw.promptVersion)) || Number(raw.promptVersion) < PROMPT_VERSION;
  const seenRoles = new Set();
  const agents = /** @type {AgentCard[]} */ ((Array.isArray(raw.agents) ? raw.agents : []).slice(0, 80).map((item, index) => {
    if (!item || typeof item !== 'object') return null;
    const askedRole = text(item.role, 60);
    const role = ROLE_IDS.has(/** @type {any} */ (askedRole)) ? /** @type {AgentRole} */ (askedRole) : LEGACY_ROLES[askedRole] ?? '';
    let enabled = item.enabled !== false;
    /* one active owner per work slot: a second enabled card is kept but paused, never ambiguous */
    if (role) {
      if (seenRoles.has(role)) enabled = false;
      else if (enabled) seenRoles.add(role);
    }
    const askedPrompt = text(item.systemPrompt, 30_000);
    return /** @type {AgentCard} */ ({
      id: text(item.id, 80) || id('agent'),
      name: text(item.name, 120) || 'Agent',
      role,
      description: text(item.description, 300),
      enabled,
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
      cardId: text(item.cardId, 80),
      modelId: text(item.modelId, 200),
      /* v2 is a one-time forced prompt migration; after the UI saves this version, later edits stay. */
      systemPrompt: role && (forcePrompts || !askedPrompt) ? DEFAULT_PROMPTS[role] : askedPrompt,
      temperature: number(item.temperature, 0.2, 0, 2),
      maxTokens: Math.round(number(item.maxTokens, 3000, 64, 200_000)),
      topP: number(item.topP, 0.9, 0.01, 1),
      tools: Array.isArray(item.tools) ? item.tools.map((/** @type {unknown} */ tool) => text(tool, 60)).filter(Boolean).slice(0, 12) : [],
      skills: Array.isArray(item.skills) ? [...new Set(item.skills.map((/** @type {unknown} */ skill) => text(skill, 80)).filter((/** @type {string} */ skill) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(skill)))].slice(0, 40) : [],
    });
  }).filter(Boolean));
  /* v2 also introduces the reserved audio/subtitle slot: disabled, no pipeline use, but visible in
     Settings so its task/requirements/delivery prompt can be reviewed. */
  if (forcePrompts && !agents.some((agent) => agent.role === 'audio')) {
    const audio = DEFAULTS.find((agent) => agent.role === 'audio');
    if (audio) agents.push({ ...audio });
  }
  agents.sort((a, b) => a.order - b.order).forEach((agent, index) => { agent.order = index; });
  return /** @type {AgentState} */ ({ revision: Number(raw.revision) || 0, promptVersion: PROMPT_VERSION, agents });
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

/** First-run migration: keep the old storyboard/director/query/verify/continuity bindings when their model still exists. */
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
  const legacyKey = /** @type {Record<AgentRole, string>} */ ({
    storyboard: 'storyboard',
    material: 'query',
    edit: 'continuity',
    audio: 'audio',
    qc: 'verify',
    conversation: 'director',
  });
  const agents = DEFAULTS.map((agent) => {
    const found = oldModelCard(old?.agents?.[legacyKey[/** @type {AgentRole} */ (agent.role)]]);
    return found ? { ...agent, ...found } : { ...agent };
  });
  const state = { revision: 1, promptVersion: PROMPT_VERSION, agents };
  try { writeAtomic(FILE(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); } catch { /* first save can retry */ }
  return state;
}
