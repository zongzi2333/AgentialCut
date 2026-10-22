// @ts-check
/**
 * The unified provider cards: one card is one vendor's one capability (LLM, VL, embedding, TTS,
 * image, video, web search, ...). Cards own models and default choices; connections own the endpoint
 * and key, and several cards of one vendor share a connection unless a card overrides it.
 *
 * The cards are a configuration layer over two kinds of runtime:
 *   - built-in adapters (`builtin:elevenlabs`, `builtin:fal`, ...), which keep the existing media
 *     providers working;
 *   - OpenAI-compatible / native HTTP adapters for custom AI and media endpoints.
 *
 * Existing `providers.json` and `ai-agents.json` are imported once into `provider-cards.json`.
 * The source files are left untouched, and a migration snapshot is written for rollback.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { studioHome } from './projects.mjs';
import { writeAtomic } from './atomic.mjs';
import { HttpError } from './http.mjs';
import { changeSettings } from './keys.mjs';
import { listProviders } from './providers/index.mjs';

/** @typedef {'llm' | 'vl' | 'embedding' | 'rerank' | 'asr' | 'tts' | 'image' | 'video' | 'image-search' | 'web-search' | 'web-fetch' | 'music' | 'sfx'} Category */
/** @typedef {'cloud' | 'local'} Scope */
/** @typedef {{ id: string, name: string, remoteName?: string, dimension?: number, vision?: boolean, context?: number, maxOutput?: number }} CardModel */
/** @typedef {{ id: string, vendorId: string, name: string, scope: Scope, baseUrl: string, auth: 'bearer' | 'api-key' | 'none', authHeader?: string, key: string, keyEnv?: string, headers?: Record<string, string>, hasKey?: boolean, last4?: string }} Connection */
/** @typedef {{ id: string, catalogId?: string, vendorId: string, name: string, category: Category, scope: Scope, protocol: string, connectionId: string, connectionOverride?: Partial<Connection>, models: CardModel[], defaultModelId: string, options?: Record<string, unknown>, enabled: boolean, order: number, builtin?: { providerId: string, verb: string }, docsUrl?: string }} ProviderCard */
/** @typedef {{ revision: number, connections: Connection[], cards: ProviderCard[], defaults: Record<string, string> }} ProviderState */

export const CATEGORIES = /** @type {const} */ ([
  { id: 'llm', label: 'LLM', cloud: true, local: true },
  { id: 'vl', label: '视觉理解', cloud: true, local: true },
  { id: 'embedding', label: '向量编码', cloud: true, local: true },
  { id: 'rerank', label: '重排', cloud: true, local: true },
  { id: 'asr', label: '语音识别', cloud: true, local: true },
  { id: 'tts', label: '语音合成', cloud: true, local: true },
  { id: 'image', label: '图像生成', cloud: true, local: true },
  { id: 'video', label: '视频生成', cloud: true, local: true },
  { id: 'image-search', label: '图片搜索', cloud: true, local: false },
  { id: 'web-search', label: '网页搜索', cloud: true, local: true },
  { id: 'web-fetch', label: '网页读取', cloud: true, local: true },
  { id: 'music', label: '音乐生成', cloud: true, local: true },
  { id: 'sfx', label: '音效生成', cloud: true, local: true },
]);
const CATEGORY_IDS = new Set(CATEGORIES.map((category) => category.id));
const MAX_CARDS = 200;
const MAX_CONNECTIONS = 120;
const id = (/** @type {string} */ prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;
const text = (/** @type {unknown} */ value, /** @type {number} */ max) => String(value ?? '').trim().slice(0, max);
const now = () => Date.now();
const FILE = () => join(studioHome(), 'provider-cards.json');
const BACKUP = () => join(studioHome(), 'provider-cards.migration.json');

const VENDORS = /** @type {const} */ ([
  {
    id: 'openai', name: 'OpenAI', scope: 'cloud', baseUrl: 'https://api.openai.com/v1', docs: 'https://platform.openai.com/docs',
    categories: {
      llm: { protocol: 'openai-chat', models: [['gpt-4.1', 'GPT-4.1'], ['gpt-4o', 'GPT-4o'], ['gpt-4o-mini', 'GPT-4o mini']] },
      vl: { protocol: 'openai-chat', models: [['gpt-4.1', 'GPT-4.1'], ['gpt-4o', 'GPT-4o']] },
      embedding: { protocol: 'openai-embeddings', models: [['text-embedding-3-large', 'Embedding 3 large', 3072], ['text-embedding-3-small', 'Embedding 3 small', 1536]] },
      image: { protocol: 'openai-images', models: [['gpt-image-1', 'GPT Image 1']] },
      tts: { protocol: 'openai-speech', models: [['gpt-4o-mini-tts', 'GPT-4o mini TTS']] },
      asr: { protocol: 'openai-transcriptions', models: [['whisper-1', 'Whisper 1']] },
      'web-search': { protocol: 'openai-responses', models: [['gpt-4.1', 'GPT-4.1']] },
    },
  },
  {
    id: 'anthropic', name: 'Anthropic', scope: 'cloud', baseUrl: 'https://api.anthropic.com/v1', docs: 'https://docs.anthropic.com',
    categories: {
      llm: { protocol: 'anthropic-messages', models: [['claude-sonnet-4-5', 'Claude Sonnet 4.5'], ['claude-opus-4-1', 'Claude Opus 4.1']] },
      vl: { protocol: 'anthropic-messages', models: [['claude-sonnet-4-5', 'Claude Sonnet 4.5']] },
    },
  },
  {
    id: 'google', name: 'Google Gemini', scope: 'cloud', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', docs: 'https://ai.google.dev',
    categories: {
      llm: { protocol: 'gemini-generate', models: [['gemini-2.5-pro', 'Gemini 2.5 Pro'], ['gemini-2.5-flash', 'Gemini 2.5 Flash']] },
      vl: { protocol: 'gemini-generate', models: [['gemini-2.5-pro', 'Gemini 2.5 Pro']] },
      embedding: { protocol: 'gemini-embeddings', models: [['text-embedding-004', 'Text Embedding 004', 768]] },
      image: { protocol: 'builtin', models: [['imagen-4.0-generate-001', 'Imagen 4']] },
      video: { protocol: 'builtin', models: [['veo-3.1-generate-preview', 'Veo 3.1']] },
      tts: { protocol: 'builtin', models: [['gemini-2.5-flash-preview-tts', 'Gemini TTS']] },
    },
  },
  {
    id: 'deepseek', name: 'DeepSeek', scope: 'cloud', baseUrl: 'https://api.deepseek.com/v1', docs: 'https://api-docs.deepseek.com',
    categories: { llm: { protocol: 'openai-chat', models: [['deepseek-chat', 'DeepSeek Chat'], ['deepseek-reasoner', 'DeepSeek Reasoner']] } },
  },
  {
    id: 'aliyun', name: '阿里云百炼', scope: 'cloud', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', docs: 'https://help.aliyun.com/zh/model-studio/',
    categories: {
      llm: { protocol: 'openai-chat', models: [['qwen3-max', 'Qwen3 Max'], ['qwen-plus', 'Qwen Plus']] },
      vl: { protocol: 'openai-chat', models: [['qwen3-vl-plus', 'Qwen3 VL Plus']] },
      embedding: { protocol: 'openai-embeddings', models: [['text-embedding-v4', 'Text Embedding v4', 1024], ['qwen3-vl-embedding-8b', 'Qwen3 VL Embedding 8B', 4096, true]] },
      image: { protocol: 'builtin', models: [['wan2.2-t2i-flash', 'Wan 2.2 T2I']] },
      video: { protocol: 'builtin', models: [['wan2.2-t2v-plus', 'Wan 2.2 T2V']] },
      asr: { protocol: 'builtin', models: [['qwen3-asr-flash', 'Qwen3 ASR']] },
      tts: { protocol: 'builtin', models: [['qwen3-tts-flash', 'Qwen3 TTS']] },
      'web-search': { protocol: 'openai-chat-search', models: [['qwen3-max', 'Qwen3 Max']] },
    },
  },
  {
    id: 'volcengine', name: '火山引擎方舟', scope: 'cloud', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', docs: 'https://www.volcengine.com/docs/82379',
    categories: {
      llm: { protocol: 'openai-chat', models: [['doubao-seed-1-6', 'Doubao Seed 1.6']] },
      vl: { protocol: 'openai-chat', models: [['doubao-seed-1-6-vision', 'Doubao Vision']] },
      embedding: { protocol: 'openai-embeddings', models: [['doubao-embedding-large-text', 'Doubao Embedding', 2048]] },
      image: { protocol: 'builtin', models: [['doubao-seedream-4-0', 'Seedream 4.0']] },
      video: { protocol: 'builtin', models: [['doubao-seedance-1-0-pro', 'Seedance 1.0 Pro']] },
      asr: { protocol: 'builtin', models: [['doubao-asr', 'Doubao ASR']] },
      tts: { protocol: 'builtin', models: [['doubao-tts', 'Doubao TTS']] },
    },
  },
  {
    id: 'zhipu', name: '智谱 BigModel', scope: 'cloud', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', docs: 'https://open.bigmodel.cn/dev/api',
    categories: {
      llm: { protocol: 'openai-chat', models: [['glm-4.5', 'GLM-4.5'], ['glm-4.5-air', 'GLM-4.5 Air']] },
      vl: { protocol: 'openai-chat', models: [['glm-4.5v', 'GLM-4.5V']] },
      embedding: { protocol: 'openai-embeddings', models: [['embedding-3', 'Embedding 3', 2048]] },
      image: { protocol: 'builtin', models: [['cogview-4', 'CogView 4']] },
      video: { protocol: 'builtin', models: [['cogvideo-x', 'CogVideoX']] },
    },
  },
  {
    id: 'moonshot', name: '月之暗面 Moonshot', scope: 'cloud', baseUrl: 'https://api.moonshot.cn/v1', docs: 'https://platform.moonshot.cn/docs',
    categories: {
      llm: { protocol: 'openai-chat', models: [['kimi-k2', 'Kimi K2'], ['moonshot-v1-128k', 'Moonshot 128K']] },
      vl: { protocol: 'openai-chat', models: [['moonshot-v1-128k-vision-preview', 'Moonshot Vision']] },
    },
  },
  {
    id: 'minimax', name: 'MiniMax', scope: 'cloud', baseUrl: 'https://api.minimax.chat/v1', docs: 'https://platform.minimaxi.com',
    categories: {
      llm: { protocol: 'openai-chat', models: [['MiniMax-M2', 'MiniMax M2']] },
      vl: { protocol: 'openai-chat', models: [['MiniMax-VL-01', 'MiniMax VL']] },
      tts: { protocol: 'builtin', models: [['speech-2.6', 'Speech 2.6']] },
      video: { protocol: 'builtin', models: [['hailuo-2.3', 'Hailuo 2.3']] },
    },
  },
  {
    id: 'hunyuan', name: '腾讯混元', scope: 'cloud', baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1', docs: 'https://cloud.tencent.com/document/product/1729',
    categories: {
      llm: { protocol: 'openai-chat', models: [['hunyuan-turbos', 'Hunyuan TurboS']] },
      vl: { protocol: 'openai-chat', models: [['hunyuan-vision', 'Hunyuan Vision']] },
      embedding: { protocol: 'openai-embeddings', models: [['hunyuan-embedding', 'Hunyuan Embedding', 1024]] },
      image: { protocol: 'builtin', models: [['hunyuan-image', 'Hunyuan Image']] },
      video: { protocol: 'builtin', models: [['hunyuan-video', 'Hunyuan Video']] },
    },
  },
  {
    id: 'siliconflow', name: '硅基流动 SiliconFlow', scope: 'cloud', baseUrl: 'https://api.siliconflow.cn/v1', docs: 'https://docs.siliconflow.cn',
    categories: {
      llm: { protocol: 'openai-chat', models: [['Qwen/Qwen3-235B-A22B', 'Qwen3 235B'], ['deepseek-ai/DeepSeek-V3', 'DeepSeek V3']] },
      vl: { protocol: 'openai-chat', models: [['Qwen/Qwen3-VL-235B-A22B-Instruct', 'Qwen3 VL']] },
      embedding: { protocol: 'openai-embeddings', models: [['BAAI/bge-m3', 'BGE-M3', 1024], ['Qwen/Qwen3-VL-Embedding-8B', 'Qwen3 VL Embedding', 4096, true]] },
      image: { protocol: 'builtin', models: [['Kwai-Kolors/Kolors', 'Kolors']] },
    },
  },
  {
    id: 'openrouter', name: 'OpenRouter', scope: 'cloud', baseUrl: 'https://openrouter.ai/api/v1', docs: 'https://openrouter.ai/docs',
    categories: {
      llm: { protocol: 'openai-chat', models: [['openai/gpt-4.1', 'OpenAI GPT-4.1'], ['anthropic/claude-sonnet-4.5', 'Claude Sonnet 4.5']] },
      vl: { protocol: 'openai-chat', models: [['google/gemini-2.5-pro', 'Gemini 2.5 Pro']] },
      embedding: { protocol: 'openai-embeddings', models: [['openai/text-embedding-3-small', 'Embedding 3 small', 1536]] },
    },
  },
  {
    id: 'groq', name: 'Groq', scope: 'cloud', baseUrl: 'https://api.groq.com/openai/v1', docs: 'https://console.groq.com/docs',
    categories: {
      llm: { protocol: 'openai-chat', models: [['llama-3.3-70b-versatile', 'Llama 3.3 70B']] },
      asr: { protocol: 'openai-transcriptions', models: [['whisper-large-v3', 'Whisper Large v3']] },
    },
  },
  {
    id: 'together', name: 'Together AI', scope: 'cloud', baseUrl: 'https://api.together.xyz/v1', docs: 'https://docs.together.ai',
    categories: {
      llm: { protocol: 'openai-chat', models: [['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Llama 3.3 70B Turbo']] },
      embedding: { protocol: 'openai-embeddings', models: [['BAAI/bge-large-en-v1.5', 'BGE Large', 1024]] },
      image: { protocol: 'openai-images', models: [['black-forest-labs/FLUX.1-schnell', 'FLUX.1 schnell']] },
    },
  },
  {
    id: 'jina', name: 'Jina AI', scope: 'cloud', baseUrl: 'https://api.jina.ai/v1', docs: 'https://jina.ai/embeddings/',
    categories: {
      embedding: { protocol: 'openai-embeddings', models: [['jina-embeddings-v4', 'Jina Embeddings v4', 2048, true], ['jina-clip-v2', 'Jina CLIP v2', 1024, true]] },
      rerank: { protocol: 'jina-rerank', models: [['jina-reranker-v2-base-multilingual', 'Jina Reranker v2']] },
    },
  },
  {
    id: 'cohere', name: 'Cohere', scope: 'cloud', baseUrl: 'https://api.cohere.com/v2', docs: 'https://docs.cohere.com',
    categories: {
      llm: { protocol: 'openai-chat', models: [['command-a-03-2025', 'Command A']] },
      embedding: { protocol: 'cohere-embeddings', models: [['embed-v4.0', 'Embed v4', 1536]] },
      rerank: { protocol: 'cohere-rerank', models: [['rerank-v3.5', 'Rerank v3.5']] },
    },
  },
  {
    id: 'tavily', name: 'Tavily', scope: 'cloud', baseUrl: 'https://api.tavily.com', docs: 'https://docs.tavily.com',
    categories: { 'web-search': { protocol: 'tavily-search', models: [['search', 'Tavily Search']] }, 'web-fetch': { protocol: 'tavily-fetch', models: [['extract', 'Tavily Extract']] } },
  },
  {
    id: 'brave', name: 'Brave Search', scope: 'cloud', baseUrl: 'https://api.search.brave.com/res/v1', docs: 'https://api-dashboard.search.brave.com',
    categories: { 'web-search': { protocol: 'brave-search', models: [['web', 'Brave Web Search']] } },
  },
  {
    id: 'elevenlabs', name: 'ElevenLabs', scope: 'cloud', baseUrl: 'https://api.elevenlabs.io/v1', docs: 'https://elevenlabs.io/docs',
    categories: {
      tts: { protocol: 'builtin', models: [['eleven_multilingual_v2', 'Multilingual v2'], ['eleven_v3', 'Eleven v3']] },
      asr: { protocol: 'builtin', models: [['scribe_v1', 'Scribe v1']] },
      music: { protocol: 'builtin', models: [['music_v1', 'Eleven Music']] },
      sfx: { protocol: 'builtin', models: [['eleven_text_to_sound_v2', 'Sound Effects v2']] },
    },
  },
  {
    id: 'fal', name: 'fal.ai', scope: 'cloud', baseUrl: 'https://fal.run', docs: 'https://fal.ai/models',
    categories: {
      image: { protocol: 'builtin', models: [['fal-ai/flux/dev', 'FLUX dev']] },
      video: { protocol: 'builtin', models: [['fal-ai/kling-video/v2.5', 'Kling 2.5']] },
    },
  },
  {
    id: 'pexels', name: 'Pexels', scope: 'cloud', baseUrl: 'https://api.pexels.com', docs: 'https://www.pexels.com/api/',
    categories: { 'image-search': { protocol: 'builtin', models: [['photos', 'Pexels Photos']] } },
  },
  {
    id: 'pixabay', name: 'Pixabay', scope: 'cloud', baseUrl: 'https://pixabay.com/api', docs: 'https://pixabay.com/api/docs/',
    categories: { 'image-search': { protocol: 'builtin', models: [['images', 'Pixabay Images']] } },
  },
  {
    id: 'azure-speech', name: 'Azure AI Speech', scope: 'cloud', baseUrl: 'https://REGION.tts.speech.microsoft.com', docs: 'https://learn.microsoft.com/azure/ai-services/speech-service/',
    categories: { tts: { protocol: 'builtin', models: [['neural', 'Neural voices']] } },
  },
  {
    id: 'doubao', name: '豆包语音', scope: 'cloud', baseUrl: 'https://openspeech.bytedance.com', docs: 'https://www.volcengine.com/product/doubao',
    categories: { asr: { protocol: 'builtin', models: [['bigmodel', 'Doubao ASR']] } },
  },
  {
    id: 'ollama', name: 'Ollama', scope: 'local', baseUrl: 'http://127.0.0.1:11434/v1', docs: 'https://ollama.com',
    categories: {
      llm: { protocol: 'openai-chat', models: [['qwen3:8b', 'Qwen3 8B'], ['llama3.3', 'Llama 3.3']] },
      vl: { protocol: 'openai-chat', models: [['qwen2.5vl:7b', 'Qwen2.5 VL 7B']] },
      embedding: { protocol: 'openai-embeddings', models: [['bge-m3', 'BGE-M3', 1024], ['qwen3-embedding:8b', 'Qwen3 Embedding 8B', 4096]] },
    },
  },
  {
    id: 'lmstudio', name: 'LM Studio', scope: 'local', baseUrl: 'http://127.0.0.1:1234/v1', docs: 'https://lmstudio.ai/docs',
    categories: {
      llm: { protocol: 'openai-chat', models: [['local-model', 'Local model']] },
      vl: { protocol: 'openai-chat', models: [['local-vision', 'Local vision']] },
      embedding: { protocol: 'openai-embeddings', models: [['local-embedding', 'Local embedding', 1024]] },
    },
  },
  {
    id: 'vllm', name: 'vLLM / SGLang', scope: 'local', baseUrl: 'http://127.0.0.1:8000/v1', docs: 'https://docs.vllm.ai',
    categories: {
      llm: { protocol: 'openai-chat', models: [['local-model', 'Local model']] },
      vl: { protocol: 'openai-chat', models: [['local-vision', 'Local vision']] },
      embedding: { protocol: 'openai-embeddings', models: [['local-embedding', 'Local embedding', 1024], ['qwen3-vl-embedding', 'Qwen3 VL Embedding', 4096, true]] },
    },
  },
  {
    id: 'llamacpp', name: 'llama.cpp', scope: 'local', baseUrl: 'http://127.0.0.1:8080/v1', docs: 'https://github.com/ggml-org/llama.cpp',
    categories: {
      llm: { protocol: 'openai-chat', models: [['local-model', 'Local model']] },
      embedding: { protocol: 'openai-embeddings', models: [['local-embedding', 'Local embedding', 1024]] },
    },
  },
  {
    id: 'xinference', name: 'Xinference', scope: 'local', baseUrl: 'http://127.0.0.1:9997/v1', docs: 'https://inference.readthedocs.io',
    categories: {
      llm: { protocol: 'openai-chat', models: [['local-model', 'Local model']] },
      vl: { protocol: 'openai-chat', models: [['local-vision', 'Local vision']] },
      embedding: { protocol: 'openai-embeddings', models: [['local-embedding', 'Local embedding', 1024]] },
      rerank: { protocol: 'jina-rerank', models: [['local-rerank', 'Local rerank']] },
    },
  },
  {
    id: 'localai', name: 'LocalAI', scope: 'local', baseUrl: 'http://127.0.0.1:8080/v1', docs: 'https://localai.io',
    categories: {
      llm: { protocol: 'openai-chat', models: [['local-model', 'Local model']] },
      embedding: { protocol: 'openai-embeddings', models: [['local-embedding', 'Local embedding', 1024]] },
      tts: { protocol: 'openai-speech', models: [['tts-1', 'TTS 1']] },
      asr: { protocol: 'openai-transcriptions', models: [['whisper-1', 'Whisper 1']] },
    },
  },
  {
    id: 'openfilm-clip', name: 'OpenFilm 本地 CLIP', scope: 'local', baseUrl: '', docs: '',
    categories: {
      embedding: { protocol: 'local-clip', models: [['chinese_clip_vit_base_patch16', 'Chinese CLIP ViT-B/16', 512, true]] },
    },
  },
]);

/** A vendor and capability as one catalog entry. */
function catalogEntries() {
  /** @type {any[]} */
  const out = [];
  for (const vendor of VENDORS) {
    for (const [category, spec] of Object.entries(vendor.categories)) {
      if (!CATEGORY_IDS.has(/** @type {Category} */ (category))) continue;
      const models = /** @type {any[][]} */ (spec.models).map(([modelId, name, dimension, vision]) => ({
        id: modelId,
        name: name ?? modelId,
        ...(dimension ? { dimension } : {}),
        ...(vision ? { vision: true } : {}),
      }));
      const builtin = spec.protocol === 'builtin' ? { providerId: vendor.id, verb: legacyVerb(/** @type {Category} */ (category)) } : undefined;
      out.push({
        id: `${vendor.id}:${category}`,
        vendorId: vendor.id,
        vendorName: vendor.name,
        name: `${vendor.name} · ${CATEGORIES.find((item) => item.id === category)?.label ?? category}`,
        category,
        scope: vendor.scope,
        baseUrl: vendor.baseUrl,
        protocol: spec.protocol,
        models,
        defaultModelId: models[0]?.id ?? '',
        docsUrl: vendor.docs ?? '',
        auth: vendor.scope === 'local' ? 'none' : 'bearer',
        ...(builtin ? { builtin } : {}),
      });
    }
  }
  return out;
}

function legacyVerb(/** @type {Category} */ category) {
  return category === 'image-search' ? 'image-search' : category;
}

export const CATALOG = catalogEntries();

/** The card state as the page sees it: no keys, only whether one is kept. */
export function redactState(/** @type {ProviderState} */ state) {
  return {
    ...state,
    connections: state.connections.map((connection) => {
      const { key, ...rest } = connection;
      return { ...rest, hasKey: Boolean(key), last4: key ? key.slice(-4) : '' };
    }),
    cards: state.cards.map((card) => card.connectionOverride ? (() => {
      const { key, ...rest } = card.connectionOverride;
      return { ...card, connectionOverride: { ...rest, hasKey: Boolean(key), last4: key ? key.slice(-4) : '' } };
    })() : card),
  };
}

/** Read the cards, migrating the old Providers and AI agent settings the first time. */
export function readProviderState() {
  if (!existsSync(FILE())) return migrate();
  try {
    return normalizeState(JSON.parse(readFileSync(FILE(), 'utf8')));
  } catch (error) {
    throw new HttpError(500, `The provider cards file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function normalizeState(/** @type {unknown} */ input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? /** @type {Record<string, any>} */ (input) : {};
  const oldConnections = Array.isArray(raw.connections) ? raw.connections : [];
  const oldCards = Array.isArray(raw.cards) ? raw.cards : [];
  /** @type {Connection[]} */
  const connections = [];
  for (const item of oldConnections.slice(0, MAX_CONNECTIONS)) {
    if (!item || typeof item !== 'object') continue;
    const baseUrl = text(item.baseUrl, 1000).replace(/\/+$/, '');
    const scope = item.scope === 'local' ? 'local' : 'cloud';
    connections.push({
      id: text(item.id, 80) || id('conn'),
      vendorId: text(item.vendorId, 80) || 'custom',
      name: text(item.name, 120) || 'Provider',
      scope,
      baseUrl,
      auth: item.auth === 'api-key' || item.auth === 'none' ? item.auth : 'bearer',
      authHeader: text(item.authHeader, 80) || 'x-api-key',
      key: text(item.key, 4000),
      keyEnv: text(item.keyEnv, 200) || undefined,
      headers: item.headers && typeof item.headers === 'object' ? Object.fromEntries(Object.entries(item.headers).filter(([, value]) => typeof value === 'string')) : undefined,
    });
  }
  const connectionIds = new Set(connections.map((connection) => connection.id));
  /** @type {ProviderCard[]} */
  const cards = [];
  for (const item of oldCards.slice(0, MAX_CARDS)) {
    if (!item || typeof item !== 'object') continue;
    const category = CATEGORY_IDS.has(item.category) ? /** @type {Category} */ (item.category) : 'llm';
    const connectionId = connectionIds.has(text(item.connectionId, 80)) ? text(item.connectionId, 80) : connections[0]?.id;
    if (!connectionId) continue;
    const cardModels = /** @type {CardModel[]} */ ((Array.isArray(item.models) ? item.models : []).map((/** @type {unknown} */ model) => normalizeModel(model)).filter(Boolean));
    if (!cardModels.length) continue;
    const defaultModelId = cardModels.some((/** @type {CardModel} */ model) => model.id === item.defaultModelId) ? String(item.defaultModelId) : cardModels[0].id;
    cards.push({
      id: text(item.id, 80) || id('card'),
      ...(item.catalogId ? { catalogId: text(item.catalogId, 120) } : {}),
      vendorId: text(item.vendorId, 80) || 'custom',
      name: text(item.name, 160) || 'Provider',
      category,
      scope: item.scope === 'local' ? 'local' : 'cloud',
      protocol: text(item.protocol, 80) || 'openai-chat',
      connectionId,
      ...(item.connectionOverride ? { connectionOverride: normalizeOverride(item.connectionOverride) } : {}),
      models: cardModels,
      defaultModelId,
      ...(item.options && typeof item.options === 'object' ? { options: item.options } : {}),
      enabled: item.enabled !== false,
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : cards.length,
      ...(item.builtin && typeof item.builtin === 'object' ? { builtin: { providerId: text(item.builtin.providerId, 80), verb: text(item.builtin.verb, 30) } } : {}),
      ...(item.docsUrl ? { docsUrl: text(item.docsUrl, 1000) } : {}),
    });
  }
  cards.sort((a, b) => a.order - b.order).forEach((card, index) => { card.order = index; });
  /** @type {Record<string, string>} */
  const defaults = {};
  for (const category of CATEGORY_IDS) {
    const chosen = text(raw.defaults?.[category], 80);
    const card = cards.find((item) => item.id === chosen && item.enabled);
    if (card) defaults[category] = card.id;
  }
  return /** @type {ProviderState} */ ({ revision: Number(raw.revision) || 0, connections, cards, defaults });
}

function normalizeModel(/** @type {unknown} */ value) {
  if (!value || typeof value !== 'object') return null;
  const raw = /** @type {Record<string, any>} */ (value);
  const modelId = text(raw.id, 200);
  if (!modelId) return null;
  return {
    id: modelId,
    name: text(raw.name, 160) || modelId,
    ...(Number.isFinite(Number(raw.dimension)) && Number(raw.dimension) > 0 ? { dimension: Number(raw.dimension) } : {}),
    ...(raw.vision ? { vision: true } : {}),
    ...(Number.isFinite(Number(raw.context)) ? { context: Number(raw.context) } : {}),
    ...(Number.isFinite(Number(raw.maxOutput)) ? { maxOutput: Number(raw.maxOutput) } : {}),
  };
}

function normalizeOverride(/** @type {unknown} */ value) {
  const raw = value && typeof value === 'object' ? /** @type {Record<string, any>} */ (value) : {};
  return {
    ...(raw.baseUrl ? { baseUrl: text(raw.baseUrl, 1000).replace(/\/+$/, '') } : {}),
    ...(raw.key ? { key: text(raw.key, 4000) } : {}),
    ...(raw.auth ? { auth: raw.auth } : {}),
    ...(raw.authHeader ? { authHeader: text(raw.authHeader, 80) } : {}),
    ...(raw.headers && typeof raw.headers === 'object' ? { headers: raw.headers } : {}),
  };
}

/** Save from the page. Keys not sent stay as they were; a card's independent connection follows the same rule. */
export async function saveProviderState(/** @type {unknown} */ input) {
  const raw = input && typeof input === 'object' ? /** @type {Record<string, any>} */ (input) : {};
  const previous = readProviderState();
  const oldConnections = new Map(previous.connections.map((connection) => [connection.id, connection]));
  /** @type {Connection[]} */
  const connections = [];
  for (const item of Array.isArray(raw.connections) ? raw.connections : []) {
    if (!item || typeof item !== 'object') continue;
    const connectionId = text(item.id, 80) || id('conn');
    const own = oldConnections.get(connectionId);
    connections.push({
      id: connectionId,
      vendorId: text(item.vendorId, 80) || own?.vendorId || 'custom',
      name: text(item.name, 120) || own?.name || 'Provider',
      scope: item.scope === 'local' ? 'local' : 'cloud',
      baseUrl: text(item.baseUrl, 1000).replace(/\/+$/, ''),
      auth: item.auth === 'api-key' || item.auth === 'none' ? item.auth : 'bearer',
      authHeader: text(item.authHeader, 80) || 'x-api-key',
      key: text(item.key, 4000) || own?.key || '',
      keyEnv: text(item.keyEnv, 200) || own?.keyEnv || undefined,
      headers: item.headers && typeof item.headers === 'object' ? Object.fromEntries(Object.entries(item.headers).filter(([, value]) => typeof value === 'string')) : own?.headers,
    });
  }
  const oldCards = new Map(previous.cards.map((card) => [card.id, card]));
  const cards = (Array.isArray(raw.cards) ? raw.cards : []).map((item) => {
    if (!item || typeof item !== 'object' || !item.connectionOverride) return item;
    const old = oldCards.get(text(item.id, 80));
    return old?.connectionOverride
      ? { ...item, connectionOverride: { ...old.connectionOverride, ...item.connectionOverride, key: text(item.connectionOverride.key, 4000) || old.connectionOverride.key } }
      : item;
  });
  const next = normalizeState({ ...raw, cards, connections, revision: (previous.revision || 0) + 1 });
  if (!next.connections.length && next.cards.length) throw new HttpError(400, 'a provider card needs a connection');
  await mkdir(studioHome(), { recursive: true, mode: 0o700 });
  await writeAtomic(FILE(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

/**
 * Keep the existing media runtime working while cards become the UI's source of truth: built-in
 * cards write their chosen provider/model/key back to `providers.json`. Custom cards are handled by
 * the newer adapters and are not forced into the legacy provider list.
 */
export async function syncLegacyRuntime(/** @type {ProviderState} */ state) {
  /* only the default card for a capability drives the legacy media runtime: two built-in image
     cards must not make the last one win by accident */
  const builtin = /** @type {ProviderCard[]} */ ([...CATEGORY_IDS]
    .map((category) => defaultCard(state, /** @type {Category} */ (category)))
    .filter((card) => Boolean(card?.enabled && card.builtin)));
  if (!builtin.length) return;
  await changeSettings((settings) => {
    for (const card of builtin) {
      const verb = card.builtin?.verb;
      const provider = listProviders().find((item) => item.id === card.builtin?.providerId);
      if (!verb || !provider) continue;
      const connection = cardConnection(card, state);
      if (connection?.key) settings.keys[provider.id] = connection.key;
      settings.use[verb] = provider.id;
      const models = /** @type {{ id: string }[]} */ (/** @type {any} */ (provider.models)?.[verb] ?? []);
      if (models.some((/** @type {{ id: string }} */ model) => model.id === card.defaultModelId)) settings.model[verb] = card.defaultModelId;
    }
  });
}

/** The effective connection of a card (shared or its own override). */
export function cardConnection(/** @type {ProviderCard} */ card, /** @type {ProviderState} */ state) {
  const base = state.connections.find((connection) => connection.id === card.connectionId);
  if (!base) return null;
  return { ...base, ...(card.connectionOverride ?? {}) };
}

/** The first enabled card for a capability, or the category's default card. */
export function defaultCard(/** @type {ProviderState} */ state, /** @type {Category} */ category) {
  const chosen = state.defaults[category];
  return state.cards.find((card) => card.id === chosen && card.enabled)
    ?? state.cards.find((card) => card.category === category && card.enabled)
    ?? null;
}

/** A custom card from the page, plus its catalog defaults. */
export function newCard(/** @type {Record<string, any>} */ input, /** @type {ProviderState} */ state) {
  const entry = CATALOG.find((item) => item.id === input.catalogId);
  const category = CATEGORY_IDS.has(input.category) ? input.category : entry?.category ?? 'llm';
  const scope = input.scope === 'local' || entry?.scope === 'local' ? 'local' : 'cloud';
  const vendorId = text(input.vendorId, 80) || entry?.vendorId || 'custom';
  let connection = state.connections.find((item) => item.vendorId === vendorId && item.scope === scope);
  if (!connection) connection = {
    id: id('conn'), vendorId, name: text(input.vendorName, 120) || entry?.vendorName || 'Custom', scope,
    baseUrl: text(input.baseUrl, 1000) || entry?.baseUrl || '', auth: scope === 'local' ? 'none' : 'bearer', authHeader: 'x-api-key',
    key: text(input.key, 4000), headers: undefined,
  };
  const models = /** @type {CardModel[]} */ (Array.isArray(input.models) && input.models.length
    ? input.models.map((/** @type {unknown} */ model) => normalizeModel(model)).filter(Boolean)
    : (entry?.models ?? []).map((/** @type {any} */ model) => normalizeModel(model)).filter(Boolean));
  if (!models.length) models.push({ id: 'default', name: 'Default' });
  return {
    connection,
    card: /** @type {ProviderCard} */ ({
      id: id('card'),
      ...(entry ? { catalogId: entry.id } : {}),
      vendorId,
      name: text(input.name, 160) || entry?.name || `${connection.name} · ${category}`,
      category,
      scope,
      protocol: text(input.protocol, 80) || entry?.protocol || 'openai-chat',
      connectionId: connection.id,
      models,
      defaultModelId: models[0].id,
      enabled: true,
      order: state.cards.length,
      ...(entry?.builtin ? { builtin: entry.builtin } : {}),
      ...(entry?.docsUrl ? { docsUrl: entry.docsUrl } : {}),
      ...(entry?.baseUrl ? {} : {}),
    }),
  };
}

/** Import the old keys/models once; the old files stay where they are, and a snapshot is kept. */
function migrate() {
  const at = now();
  /** @type {ProviderState} */
  const state = { revision: 1, connections: [], cards: /** @type {ProviderCard[]} */ ([]), defaults: {} };
  const snapshot = { createdAt: at, providers: readJson(join(studioHome(), 'providers.json')), aiAgents: readJson(join(studioHome(), 'ai-agents.json')) };
  const keys = snapshot.providers?.keys ?? {};
  const use = snapshot.providers?.use ?? {};
  const models = snapshot.providers?.model ?? {};
  const addConnection = (/** @type {string} */ vendorId, /** @type {string} */ name, /** @type {string} */ key, /** @type {Scope} */ scope = 'cloud', /** @type {string} */ baseUrl = '') => {
    if (state.connections.some((connection) => connection.vendorId === vendorId && connection.scope === scope)) return;
    state.connections.push({ id: id('conn'), vendorId, name, scope, baseUrl, auth: 'bearer', authHeader: 'x-api-key', key });
  };
  for (const [vendorId, key] of Object.entries(keys)) {
    if (typeof key !== 'string' || !key) continue;
    const entry = CATALOG.find((item) => item.vendorId === vendorId);
    if (!entry) continue;
    addConnection(vendorId, entry.vendorName, key, entry.scope, entry.baseUrl);
  }
  /* the local encoder is part of the baseline: vector stores already use it */
  addConnection('openfilm-clip', 'OpenFilm 本地 CLIP', '', 'local', '');
  for (const entry of CATALOG) {
    if (entry.scope !== 'cloud' && entry.scope !== 'local') continue;
    const connection = state.connections.find((item) => item.vendorId === entry.vendorId && item.scope === entry.scope);
    if (!connection) continue;
    const chosen = use[legacyVerb(entry.category)] === entry.vendorId;
    if (entry.vendorId !== 'openfilm-clip' && !chosen) continue;
    if (state.cards.some((card) => card.category === entry.category && card.vendorId === entry.vendorId)) continue;
    const card = /** @type {ProviderCard} */ ({
      id: id('card'), catalogId: entry.id, vendorId: entry.vendorId, name: entry.name, category: entry.category,
      scope: entry.scope, protocol: entry.protocol, connectionId: connection.id,
      models: /** @type {CardModel[]} */ (entry.models.map((/** @type {any} */ model) => normalizeModel(model)).filter(Boolean)),
      defaultModelId: models[legacyVerb(entry.category)] || entry.defaultModelId,
      enabled: true, order: state.cards.length,
      ...(entry.builtin ? { builtin: entry.builtin } : {}),
      ...(entry.docsUrl ? { docsUrl: entry.docsUrl } : {}),
    });
    if (!card.models.some((/** @type {CardModel} */ model) => model.id === card.defaultModelId)) card.defaultModelId = card.models[0]?.id ?? '';
    if (card.models.length) state.cards.push(card);
    if (chosen || entry.vendorId === 'openfilm-clip') state.defaults[entry.category] = card.id;
  }
  const ai = snapshot.aiAgents;
  for (const provider of Array.isArray(ai?.providers) ? ai.providers : []) {
    if (!provider?.baseUrl) continue;
    const key = typeof provider.key === 'string' ? provider.key : '';
    addConnection(`ai-${text(provider.id, 60)}`, text(provider.name, 120) || 'AI provider', key, 'cloud', provider.baseUrl);
    for (const model of /** @type {any[]} */ (Array.isArray(ai.models) ? ai.models : []).filter((item) => item.providerId === provider.id)) {
      for (const one of /** @type {Category[]} */ (model.vision ? ['vl', 'llm'] : ['llm'])) {
        if (state.cards.some((card) => card.vendorId === `ai-${provider.id}` && card.category === one)) continue;
        const connection = state.connections.find((item) => item.vendorId === `ai-${provider.id}`);
        if (!connection) continue;
        const normalized = normalizeModel({ id: model.model, name: model.name });
        if (!normalized) continue;
        state.cards.push({
          id: id('card'), vendorId: `ai-${provider.id}`, name: `${provider.name} · ${one === 'vl' ? '视觉' : 'LLM'}`, category: one, scope: 'cloud',
          protocol: 'openai-chat', connectionId: connection.id, models: [normalized],
          defaultModelId: normalized.id, enabled: true, order: state.cards.length,
        });
      }
    }
  }
  state.revision = 1;
  try { writeAtomic(BACKUP(), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 }); } catch { /* a failed snapshot must not block first open */ }
  try { writeAtomic(FILE(), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); } catch { /* the page can retry */ }
  return state;
}

function readJson(/** @type {string} */ path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
