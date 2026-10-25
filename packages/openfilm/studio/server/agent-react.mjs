// @ts-check
/**
 * The conversation agent's small ReAct loop.
 *
 * The model may answer, call one controlled tool, see the result, and decide again. A tool is never
 * invented here: every name maps to the same functions MCP and the rough-cut executor use. The loop
 * returns a compact run record so both chat panels can show what was actually changed without
 * exposing prompts or provider internals.
 */
import { randomBytes } from 'node:crypto';
import { agentReady, callAgent, parseJsonReply } from './agent-runtime.mjs';
import { HttpError } from './http.mjs';
import {
  editCaptionsTool, editStoryboardTool, editTimelineTool, fillStoryboardTool, handoffStoryboardTool,
  listProjectFilesTool, matchStoryboardTool, qcTool, readCaptionsTool, readProjectTool, readStoryboardTool,
  readTimelineTool, searchMaterialsTool, undoTimelineTool, validateStoryboardTool,
} from './agent-tools.mjs';
import { generateAudio, importAudio, listAudio, listVoices, readAudio, searchAll } from './audio.mjs';
import { loudness, probe, waveform } from './derived.mjs';
import { listWorkspace, readWorkspaceFile, roleWorkspaceRel, runWorkspaceCode, writeWorkspaceFile } from './agent-workspace.mjs';

const MAX_ROUNDS = 6;
const MAX_TOOL_RESULT = 48_000;

/** @typedef {'storyboard' | 'edit' | 'audio'} ReactScope */
/** @typedef {{ name: string, description: string, scopes: ReactScope[], input: Record<string, unknown> }} ReactTool */
/** @typedef {{ status: 'done' | 'needs_input' | 'budget' | 'error', reply: string, runId: string, toolCalls: Array<Record<string, unknown>>, changed: Record<string, unknown>, applied: boolean, issues: string[], question?: string, questionOptions?: string[], rev?: string | number, intent?: 'edit' | 'match' | 'none', preview_request?: unknown }} ReactResult */

/** @type {ReactTool[]} */
const TOOLS = [
  { name: 'read_project', description: 'Read the project summary and current phase.', scopes: ['storyboard', 'edit'], input: {} },
  { name: 'read_storyboard', description: 'Read the storyboard, shots, candidates and match states.', scopes: ['storyboard'], input: {} },
  { name: 'read_timeline', description: 'Read tracks, clip ids, trims, positions and the timeline revision.', scopes: ['storyboard', 'edit'], input: {} },
  { name: 'list_project_files', description: 'List project media, pages and folders usable by edit_timeline.', scopes: ['storyboard', 'edit'], input: {} },
  { name: 'search_materials', description: 'Search the project material index. Query is Chinese visual text; topK is 1–40.', scopes: ['storyboard', 'edit'], input: { query: 'string', topK: 'number?' } },
  { name: 'qc', description: 'Run deterministic QC and return issues; never edits.', scopes: ['storyboard', 'edit'], input: {} },
  { name: 'preview', description: 'Ask Studio to update the preview. It does not render or export.', scopes: ['storyboard', 'edit'], input: {} },
  { name: 'validate_storyboard', description: 'Validate the storyboard before handoff; returns issues.', scopes: ['storyboard'], input: {} },
  { name: 'edit_storyboard', description: 'Apply storyboard operations by real shot/candidate id. Writes the storyboard unless validation fails.', scopes: ['storyboard'], input: { operations: 'array', baseRevision: 'number?' } },
  { name: 'match_storyboard', description: 'Search and select candidates for all shots or named shotIds.', scopes: ['storyboard'], input: { shotIds: 'string[]?', topK: 'number?' } },
  { name: 'fill_storyboard', description: 'Generate one missing shot with the configured video service.', scopes: ['storyboard'], input: { shotId: 'string', prompt: 'string?', duration: 'number?' } },
  { name: 'handoff_storyboard', description: 'Replace the native timeline with matched shots and mark the board handed off.', scopes: ['storyboard'], input: {} },
  { name: 'edit_timeline', description: 'Apply native timeline ops (set, move, insert, remove, split, props, fields, stage, track, reorder).', scopes: ['edit', 'audio'], input: { ops: 'array', base: 'string?' } },
  { name: 'undo_timeline', description: 'Undo the last agent timeline edit.', scopes: ['edit', 'audio'], input: {} },
  { name: 'read_audio', description: 'Read the current mix: audio tracks, clips, volume, fades, placement and sound roles.', scopes: ['audio'], input: {} },
  { name: 'list_audio', description: 'List the project’s local voice/music/SFX assets, optionally filtered by role and query.', scopes: ['audio'], input: { role: 'voice|music|sfx|all?', q: 'string?', facts: 'boolean?' } },
  { name: 'search_audio', description: 'Search local audio and, when configured, Freesound/Jamendo. q, role and source are optional.', scopes: ['audio'], input: { q: 'string?', role: 'voice|music|sfx|all?', source: 'all|local|freesound|jamendo?', limit: 'number?' } },
  { name: 'list_voices', description: 'List TTS voices available from the configured voice provider.', scopes: ['audio'], input: { provider: 'string?', q: 'string?' } },
  { name: 'generate_audio', description: 'Generate voice (TTS), music or SFX with the configured provider. Returns the new asset; placement is a separate edit_timeline call.', scopes: ['audio'], input: { kind: 'voice|music|sfx', text: 'string?', voice: 'string?', prompt: 'string?', sec: 'number?', model: 'string?' } },
  { name: 'import_audio', description: 'Import an allowed remote audio file into the project library; this does not place it.', scopes: ['audio'], input: { url: 'string', role: 'voice|music|sfx?', name: 'string?' } },
  { name: 'probe_audio', description: 'Read duration, codec and stream facts for one project audio file.', scopes: ['audio'], input: { path: 'string' } },
  { name: 'analyze_audio', description: 'Read loudness and waveform for one project audio file, optionally a time range.', scopes: ['audio'], input: { path: 'string', from: 'number?', to: 'number?' } },
  { name: 'read_captions', description: 'Read subtitle cues, source language and current subtitle style.', scopes: ['audio'], input: {} },
  { name: 'edit_captions', description: 'Edit a subtitle line, style, translate captions, or transcribe speech into captions.', scopes: ['audio'], input: { action: 'line|style|translate|transcribe', src: 'string?', line: 'number?', text: 'string?', language: 'string?', part: 'number?', style: 'object?' } },
  { name: 'workspace_list', description: 'List files in this agent’s project workspace. Paths are relative to the role workspace.', scopes: ['storyboard', 'edit', 'audio'], input: { path: 'string?' } },
  { name: 'workspace_read', description: 'Read a UTF-8 text file from this agent’s project workspace.', scopes: ['storyboard', 'edit', 'audio'], input: { path: 'string' } },
  { name: 'workspace_write', description: 'Write a UTF-8 text file into this agent’s project workspace; parent folders are created inside it.', scopes: ['storyboard', 'edit', 'audio'], input: { path: 'string', content: 'string' } },
  { name: 'run_code', description: 'Run a small Node.js or Python program with the role workspace as cwd. No shell, 10s default timeout, 64KB output cap; use it for local calculations, parsing or prototypes.', scopes: ['storyboard', 'edit', 'audio'], input: { language: 'node|python', code: 'string', timeoutMs: 'number?' } },
  { name: 'ask_user', description: 'Ask one necessary question and stop this round; do not use it for approval.', scopes: ['storyboard', 'edit', 'audio'], input: { question: 'string', options: 'string[]?' } },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));
const WRITE_TOOLS = new Set(['edit_storyboard', 'match_storyboard', 'fill_storyboard', 'handoff_storyboard', 'edit_timeline', 'undo_timeline', 'generate_audio', 'import_audio', 'edit_captions']);

/** The contract sent with the request; the agent card's prompt still provides its role and house style. */
function contract(/** @type {ReactScope} */ scope, /** @type {string[]} */ selected, /** @type {string} */ workspace) {
  const tools = TOOLS.filter((tool) => tool.scopes.includes(scope)).map((tool) => (
    `- ${tool.name}: ${tool.description}${Object.keys(tool.input).length ? ` input=${JSON.stringify(tool.input)}` : ''}`
  )).join('\n');
  return [
    `You are changing ${scope === 'edit' ? 'the timeline' : scope === 'audio' ? 'the film’s audio and timeline' : 'the storyboard'}. Use one tool at a time; after each result decide again.`,
    `Available tools:\n${tools}`,
    `Selected ids: ${JSON.stringify(selected)}`,
    `Project workspace: ${workspace}`,
    'Workspace code may use OPENFILM_PROJECT and OPENFILM_WORKSPACE. It is for scratch work and prototypes; do not use it to bypass the document tools or to render/export.',
    'Return only JSON. To call a tool: {"reply":"short Chinese note","tool":"tool_name","arguments":{},"intent":"edit|match|none"}.',
    'To finish: {"reply":"short Chinese answer","tool":null,"intent":"edit|match|none","preview_request":null}.',
    'Never claim a change unless a tool result says it was saved. Never call a tool outside this list. Never render, export, generate audio, or edit project files directly.',
    'If a tool fails, explain the exact blocker or retry with corrected arguments; do not pretend success.',
  ].join('\n\n');
}

/** A tool result the model can consume, bounded for the context. */
/** @returns {{ role: 'user', content: string }} */
function observation(/** @type {string} */ name, /** @type {unknown} */ result) {
  const value = result && typeof result === 'object' ? result : { value: result };
  return {
    role: 'user',
    content: `TOOL RESULT ${name}:\n${JSON.stringify(value).slice(0, MAX_TOOL_RESULT)}\n\nContinue. When the work is complete, return the final JSON without a tool.`,
  };
}

/** Keep the UI's parameter display small and free of full media documents. */
function summarizeArgs(/** @type {string} */ name, /** @type {Record<string, any>} */ args) {
  if (Array.isArray(args.operations)) return { operations: args.operations.length, ...(args.baseRevision != null ? { baseRevision: args.baseRevision } : {}) };
  if (Array.isArray(args.ops)) return { ops: args.ops.length, ...(args.base ? { base: args.base } : {}) };
  if (Array.isArray(args.shotIds)) return { shotIds: args.shotIds.length, ...(args.topK != null ? { topK: args.topK } : {}) };
  if (name === 'search_materials') return { query: String(args.query ?? '').slice(0, 120), ...(args.topK != null ? { topK: args.topK } : {}) };
  if (name === 'fill_storyboard') return { shotId: String(args.shotId ?? ''), ...(args.duration != null ? { duration: args.duration } : {}) };
  if (name === 'ask_user') return { question: String(args.question ?? '').slice(0, 200) };
  return {};
}

function resultSummary(/** @type {unknown} */ value) {
  if (!value || typeof value !== 'object') return String(value ?? '').slice(0, 300);
  if ('error' in value) return String(value.error).slice(0, 300);
  if ('storyboard' in value) {
    const doc = /** @type {any} */ (value).storyboard;
    return doc ? `分镜 · ${doc.shots?.length ?? 0} 镜 · revision ${doc.revision}` : '分镜';
  }
  if ('timeline' in value) {
    const timeline = /** @type {any} */ (value).timeline;
    return timeline ? `时间线已更新 · ${timeline.clips?.length ?? 0} 个片段 · ${timeline.rev ?? ''}` : '时间线已更新';
  }
  if ('issues' in value) {
    const issues = /** @type {any} */ (value).issues;
    return Array.isArray(issues) && issues.length ? `${issues.length} 个问题` : '检查通过';
  }
  if ('note' in value) return String(/** @type {any} */ (value).note).slice(0, 300);
  return JSON.stringify(value).slice(0, 300);
}

/** Execute one allowed tool. This switch is the permissions boundary. */
async function executeTool(
  /** @type {ReactTool} */ tool,
  /** @type {Record<string, any>} */ args,
  /** @type {{ project: any, semanticIndex: any, scope: ReactScope, role: string, signal?: AbortSignal }} */ context,
) {
  switch (tool.name) {
    case 'read_project': return readProjectTool(context.project, { editStage: context.scope === 'edit' });
    case 'read_storyboard': return readStoryboardTool(context.project);
    case 'read_timeline': return readTimelineTool(context.project);
    case 'list_project_files': return listProjectFilesTool(context.project);
    case 'search_materials': return searchMaterialsTool(context.project, context.semanticIndex, args);
    case 'qc': return qcTool(context.project);
    case 'preview': return { ok: true, note: 'Studio updates its own preview from the project documents; no render or export was started.' };
    case 'validate_storyboard': return validateStoryboardTool(context.project);
    case 'edit_storyboard': return editStoryboardTool(context.project, args);
    case 'match_storyboard': return matchStoryboardTool(context.project, context.semanticIndex, args);
    case 'fill_storyboard': return fillStoryboardTool(context.project, args);
    case 'handoff_storyboard': return handoffStoryboardTool(context.project);
    case 'edit_timeline': return editTimelineTool(context.project, args);
    case 'undo_timeline': return undoTimelineTool(context.project);
    case 'read_audio': return readAudio(context.project.path);
    case 'list_audio': return listAudio(context.project.path, {
      role: args.role === 'voice' || args.role === 'music' || args.role === 'sfx' ? args.role : 'all',
      q: typeof args.q === 'string' ? args.q : '',
      facts: args.facts !== false,
      folderUrl: '',
    });
    case 'search_audio': return searchAll(context.project.path, args, '');
    case 'list_voices': return listVoices(context.project.path, args);
    case 'generate_audio': return generateAudio(context.project.path, args, { folderUrl: '' });
    case 'import_audio': return importAudio(context.project.path, args, { folderUrl: '' });
    case 'probe_audio': return probe(context.project.path, String(args.path ?? ''));
    case 'analyze_audio': {
      const path = String(args.path ?? '');
      const [level, wave] = await Promise.all([
        loudness(context.project.path, path, Number(args.from) || 0, args.to == null ? undefined : Number(args.to)),
        waveform(context.project.path, path),
      ]);
      return { path, loudness: level, waveform: wave };
    }
    case 'read_captions': return readCaptionsTool(context.project);
    case 'edit_captions': return editCaptionsTool(context.project, args);
    case 'workspace_list': return listWorkspace(context.project, context.role, args.path ?? '.');
    case 'workspace_read': return readWorkspaceFile(context.project, context.role, args.path);
    case 'workspace_write': return writeWorkspaceFile(context.project, context.role, args.path, args.content);
    case 'run_code': return runWorkspaceCode(context.project, context.role, {
      language: args.language,
      code: args.code,
      timeoutMs: args.timeoutMs,
      signal: context.signal,
    });
    case 'ask_user': {
      const question = String(args.question ?? '').trim().slice(0, 2000);
      if (!question) throw new HttpError(400, 'ask_user needs a question');
      return { question, ...(Array.isArray(args.options) ? { options: args.options.map(String).slice(0, 8) } : {}) };
    }
    default: throw new HttpError(400, `unknown tool: ${tool.name}`);
  }
}

/** One ReAct turn. No tool loop survives beyond this request; the stored chat keeps the visible words. */
/** @returns {Promise<ReactResult>} */
export async function conversationReact(
  /** @type {any} */ project,
  /** @type {{ text: string, scope: ReactScope, history?: Array<{ role: 'user' | 'agent', text: string }>, selectedIds?: string[], context?: unknown, signal?: AbortSignal, runAgent?: (role: string, messages: Array<{ role: 'user' | 'assistant', content: string }>, context: { project: any, signal?: AbortSignal }) => Promise<string> }} */ input,
  /** @type {any} */ semanticIndex,
) {
  const scope = input.scope === 'audio' ? 'audio' : input.scope === 'edit' ? 'edit' : 'storyboard';
  const role = scope === 'storyboard' ? 'storyboard' : scope === 'audio' ? 'audio' : 'conversation';
  if (!input.runAgent && !agentReady(role)) throw new HttpError(409, `没有可用的${scope === 'storyboard' ? '分镜' : scope === 'audio' ? '音频' : '对话剪辑'} Agent，请先在设置中绑定模型。`);
  const runId = `chat_${randomBytes(6).toString('hex')}`;
  const selected = Array.isArray(input.selectedIds) ? input.selectedIds.map(String).slice(0, 200) : [];
  const history = /** @type {Array<{ role: 'user' | 'assistant', content: string }>} */ ((Array.isArray(input.history) ? input.history : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'agent') && typeof message.text === 'string' && message.text.trim())
    .slice(-12)
    .map((message) => ({ role: message.role === 'agent' ? 'assistant' : 'user', content: message.text.slice(0, 8000) })));
  /** @type {Array<{ role: 'user' | 'assistant', content: string }>} */
  const messages = [
    ...history,
    {
      role: 'user',
      content: `${contract(scope, selected, roleWorkspaceRel(project, role))}\n\nCONTEXT:\n${JSON.stringify(input.context ?? {}).slice(0, 180_000)}\n\nREQUEST:\n${input.text.slice(0, 120_000)}`,
    },
  ];
  /** @type {Array<Record<string, unknown>>} */
  const toolCalls = [];
  const issues = [];
  /** @type {Record<string, unknown>} */
  const changed = {};
  let applied = false;
  let rev;
  let lastReply = '';
  let intent;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (input.signal?.aborted) throw new HttpError(499, '请求已停止');
    const raw = input.runAgent
      ? await input.runAgent(role, messages, { project, ...(input.signal ? { signal: input.signal } : {}) })
      : await callAgent(role, messages, {
        project,
        ...(input.signal ? { signal: input.signal } : {}),
        appendSystem: 'This run uses a controlled ReAct tool loop. Ignore the older one-turn "Return only JSON storyboard/operations/filmOps" delivery format; follow the tool contract in the latest user message.',
      });
    let parsed = null;
    try { parsed = parseJsonReply(raw); } catch { /* a plain final answer */ }
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.reply === 'string' && parsed.reply.trim()) lastReply = parsed.reply.trim().slice(0, 20_000);
      if (parsed.intent === 'edit' || parsed.intent === 'match' || parsed.intent === 'none') intent = parsed.intent;
      const requested = typeof parsed.tool === 'string' ? parsed.tool : '';
      if (requested) {
        const tool = TOOL_BY_NAME.get(requested);
        if (!tool || !tool.scopes.includes(scope)) {
          issues.push(`不允许的工具：${requested}`);
          messages.push({ role: 'assistant', content: JSON.stringify(parsed) });
          messages.push({ role: 'user', content: `TOOL ERROR: ${requested} is not available in this scope. Continue with an allowed tool or explain the blocker.` });
          continue;
        }
        const startedAt = Date.now();
        const args = parsed.arguments && typeof parsed.arguments === 'object' ? parsed.arguments : {};
        let value;
        let error = '';
        try {
          value = await executeTool(tool, args, { project, semanticIndex, scope, role, ...(input.signal ? { signal: input.signal } : {}) });
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
          value = { error };
        }
        const isWrite = WRITE_TOOLS.has(tool.name);
        if (!error && isWrite) applied = true;
        if (!error && value && typeof value === 'object') {
          if (isWrite) {
            if ('storyboard' in value) {
              const doc = /** @type {any} */ (value).storyboard;
              changed.storyboard = true;
              changed.shots = doc?.shots?.length ?? changed.shots;
              changed.revision = doc?.revision ?? changed.revision;
              rev = doc?.revision ?? rev;
            }
            if (Array.isArray(/** @type {any} */ (value).clips)) {
              changed.timeline = true;
              changed.clips = /** @type {any} */ (value).clips.length;
              applied = true;
            }
            if ('timeline' in value) {
              const timeline = /** @type {any} */ (value).timeline;
              changed.timeline = true;
              changed.clips = timeline?.clips?.length ?? changed.clips;
              changed.rev = timeline?.rev ?? changed.rev;
              rev = timeline?.rev ?? rev;
            }
            if ('asset' in value) {
              changed.audio = true;
              changed.assets = 1;
            }
            if (value.action === 'line' || value.action === 'style' || Array.isArray(value.translated) || Array.isArray(value.transcribed)) {
              changed.captions = true;
              if (Array.isArray(value.translated)) changed.captionLines = value.translated.length;
              if (Array.isArray(value.transcribed)) changed.captionLines = value.transcribed.length;
            }
          }
          if (!error && (tool.name === 'workspace_write' || tool.name === 'run_code')) {
            changed.workspace = true;
            if (tool.name === 'workspace_write') changed.workspaceFiles = 1;
          }
          if (!error && tool.name === 'run_code' && Number(value.exitCode) !== 0) {
            issues.push(`run_code 退出码 ${String(value.exitCode)}${value.timedOut ? '（超时）' : ''}`);
          }
          if ('issues' in value && Array.isArray(value.issues)) issues.push(...value.issues.map(String));
          if ('question' in value) {
            const question = String(value.question);
            toolCalls.push({
              id: `call_${round + 1}`, name: tool.name, arguments: summarizeArgs(tool.name, args), status: error ? 'error' : 'done',
              summary: error || '等待用户回答', startedAt, finishedAt: Date.now(), ...(error ? { error } : {}),
            });
            return {
              status: 'needs_input', reply: lastReply || '需要你确认一个信息。', runId, toolCalls,
              changed, applied, issues: [...new Set(issues)], question,
              ...(Array.isArray(value.options) ? { questionOptions: value.options.map(String).slice(0, 8) } : {}),
              ...(rev != null ? { rev } : {}), ...(intent ? { intent } : {}),
            };
          }
        }
        toolCalls.push({
          id: `call_${round + 1}`, name: tool.name, arguments: summarizeArgs(tool.name, args), status: error ? 'error' : 'done',
          summary: error || resultSummary(value), startedAt, finishedAt: Date.now(), ...(error ? { error } : {}),
        });
        if (error) issues.push(`${tool.name}: ${error}`);
        messages.push({ role: 'assistant', content: JSON.stringify(parsed) });
        messages.push(observation(tool.name, error ? { error } : value));
        continue;
      }

      /* Compatibility with the earlier one-turn contract: an edit is still applied through a tool. */
      if (scope === 'storyboard' && Array.isArray(parsed.operations) && parsed.operations.length) {
        const startedAt = Date.now();
        try {
          const value = await editStoryboardTool(project, { operations: parsed.operations, baseRevision: parsed.baseRevision });
          applied = true;
          changed.storyboard = true;
          changed.shots = value.storyboard.shots.length;
          changed.revision = value.storyboard.revision;
          rev = value.storyboard.revision;
          toolCalls.push({ id: 'call_legacy', name: 'edit_storyboard', arguments: { operations: parsed.operations.length }, status: 'done', summary: resultSummary(value), startedAt, finishedAt: Date.now() });
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          issues.push(error);
          toolCalls.push({ id: 'call_legacy', name: 'edit_storyboard', arguments: { operations: parsed.operations.length }, status: 'error', summary: error, startedAt, finishedAt: Date.now(), error });
        }
      }
      if (scope === 'edit' && Array.isArray(parsed.filmOps) && parsed.filmOps.length) {
        const startedAt = Date.now();
        try {
          const value = await editTimelineTool(project, { ops: parsed.filmOps });
          applied = true;
          changed.timeline = true;
          changed.clips = value.timeline.clips.length;
          changed.rev = value.rev;
          rev = value.rev;
          toolCalls.push({ id: 'call_legacy', name: 'edit_timeline', arguments: { ops: parsed.filmOps.length }, status: 'done', summary: resultSummary(value), startedAt, finishedAt: Date.now() });
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          issues.push(error);
          toolCalls.push({ id: 'call_legacy', name: 'edit_timeline', arguments: { ops: parsed.filmOps.length }, status: 'error', summary: error, startedAt, finishedAt: Date.now(), error });
        }
      }
      if (!parsed.tool) {
        return {
          status: 'done', reply: lastReply || '已完成。', runId, toolCalls, changed, applied,
          issues: [...new Set(issues)], ...(rev != null ? { rev } : {}), ...(intent ? { intent } : {}),
          ...(parsed.preview_request != null ? { preview_request: parsed.preview_request } : {}),
        };
      }
      continue;
    }
    lastReply = raw.trim().slice(0, 20_000);
    return { status: 'done', reply: lastReply || '已完成。', runId, toolCalls, changed, applied, issues: [...new Set(issues)], ...(rev != null ? { rev } : {}), ...(intent ? { intent } : {}) };
  }

  return {
    status: 'budget', reply: lastReply || '工具调用达到本轮上限，尚未完成。', runId, toolCalls, changed, applied,
    issues: [...new Set([...issues, '本轮工具调用达到上限'])] , ...(rev != null ? { rev } : {}), ...(intent ? { intent } : {}),
  };
}
