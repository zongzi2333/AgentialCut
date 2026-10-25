// @ts-check
/**
 * OpenFilm's small, generic MCP endpoint.
 *
 * It is deliberately stateless and HTTP-only: one project-scoped URL, JSON-RPC in and out, tools
 * implemented by `agent-tools.mjs`. It gives an ACP agent the same controlled surface as Studio's
 * own conversation agent. It does not expose rendering, exporting, TTS or music; those are the
 * person's actions or are not implemented yet.
 */
import { readJson } from './http.mjs';
import { readStoryboard } from './storyboard.mjs';
import {
  MCP_TOOL_DEFINITIONS,
  editStoryboardTool,
  editTimelineTool,
  fillStoryboardTool,
  handoffStoryboardTool,
  listProjectFilesTool,
  matchStoryboardTool,
  qcTool,
  readProjectTool,
  readStoryboardTool,
  readTimelineTool,
  searchMaterialsTool,
  undoTimelineTool,
  validateStoryboardTool,
} from './agent-tools.mjs';
import { listWorkspace, readWorkspaceFile, runWorkspaceCode, writeWorkspaceFile } from './agent-workspace.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const STORYBOARD_TOOL_NAMES = new Set([
  'read_storyboard', 'edit_storyboard', 'match_storyboard', 'fill_storyboard',
  'handoff_storyboard', 'validate_storyboard',
]);

function result(/** @type {unknown} */ id, /** @type {unknown} */ value) {
  return { jsonrpc: '2.0', id, result: value };
}

function failure(/** @type {unknown} */ id, /** @type {number} */ code, /** @type {string} */ message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function callTool(/** @type {string} */ name, /** @type {any} */ args, /** @type {any} */ context) {
  switch (name) {
    case 'read_project': return readProjectTool(context.project, { editStage: context.editStage });
    case 'read_storyboard': return readStoryboardTool(context.project);
    case 'read_timeline': return readTimelineTool(context.project);
    case 'list_project_files': return listProjectFilesTool(context.project);
    case 'match_storyboard': return matchStoryboardTool(context.project, context.semanticIndex, args);
    case 'fill_storyboard': return fillStoryboardTool(context.project, args);
    case 'handoff_storyboard': return handoffStoryboardTool(context.project);
    case 'validate_storyboard': return validateStoryboardTool(context.project);
    case 'workspace_list': return listWorkspace(context.project, 'shared', args.path ?? '.');
    case 'workspace_read': return readWorkspaceFile(context.project, 'shared', args.path);
    case 'workspace_write': return writeWorkspaceFile(context.project, 'shared', args.path, args.content);
    case 'run_code': return runWorkspaceCode(context.project, 'shared', { language: args.language, code: args.code, timeoutMs: args.timeoutMs });
    case 'edit_storyboard': return editStoryboardTool(context.project, args);
    case 'edit_timeline': return editTimelineTool(context.project, args);
    case 'undo_timeline': return undoTimelineTool(context.project);
    case 'search_materials': return searchMaterialsTool(context.project, context.semanticIndex, args);
    case 'qc': return qcTool(context.project);
    case 'preview': return {
      ok: true,
      note: 'Studio updates its own preview from the project files. No MP4 is rendered and no export is started.',
    };
    default: throw new Error(`unknown tool: ${name}`);
  }
}

/** @param {any} message @param {any} context */
async function handleMessage(message, context) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    return failure(message?.id ?? null, -32600, 'invalid JSON-RPC request');
  }
  const id = message.id;
  const hasId = Object.hasOwn(message, 'id');
  const method = String(message.method ?? '');
  const params = message.params && typeof message.params === 'object' ? message.params : {};

  if (method === 'initialize') {
    return hasId ? result(id, {
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'openfilm', version: '1.0.0' },
      instructions: 'Use these tools to read and edit this OpenFilm project. Do not edit film.html, storyboard.json or other project files directly. Do not render or export; the person does that in Studio. TTS and music are not available.',
    }) : undefined;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return undefined;
  if (method === 'ping') return hasId ? result(id, {}) : undefined;
  if (method === 'tools/list') return hasId ? result(id, { tools: context.tools }) : undefined;
  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    if (!context.toolNames.has(name)) return hasId ? failure(id, -32602, `unknown tool: ${name}`) : undefined;
    try {
      const value = await callTool(name, params.arguments && typeof params.arguments === 'object' ? params.arguments : {}, context);
      return hasId ? result(id, {
        content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        isError: false,
      }) : undefined;
    } catch (error) {
      return hasId ? result(id, {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }) : undefined;
    }
  }
  if (method === 'resources/list') return hasId ? result(id, { resources: [] }) : undefined;
  if (method === 'prompts/list') return hasId ? result(id, { prompts: [] }) : undefined;
  return hasId ? failure(id, -32601, `method not found: ${method}`) : undefined;
}

/** @param {import('./http.mjs').Req} req @param {import('./http.mjs').Res} res @param {{ project: any, semanticIndex: any }} context */
export async function handleMcpRequest(req, res, context) {
  const body = await readJson(req, 24 << 20);
  let editStage = false;
  try { editStage = Boolean(readStoryboard(context.project).handedOffAt); } catch { /* no storyboard */ }
  const tools = MCP_TOOL_DEFINITIONS.filter((tool) => !editStage || !STORYBOARD_TOOL_NAMES.has(tool.name));
  const toolNames = new Set(tools.map((tool) => tool.name));
  const scoped = { ...context, editStage, tools, toolNames };
  const batch = Array.isArray(body);
  const messages = batch ? body : [body];
  const answers = [];
  for (const message of messages) {
    const answer = await handleMessage(message, scoped);
    if (answer !== undefined) answers.push(answer);
  }
  if (!answers.length) {
    res.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end();
    return;
  }
  const payload = batch ? answers : answers[0];
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}
