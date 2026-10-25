// @ts-check
/**
 * The single conversation agent's runtime.
 *
 * Both Studio's storyboard pane and its edit-stage pane call this module. They share the same
 * conversation agent and tool validation, but have separate contracts and contexts: the storyboard
 * turn returns operations for the review/apply boundary; the edit turn is timeline-only and has no
 * storyboard context after handoff. Timeline operations are applied through the validated film tool.
 */
import { agentReady, callAgent, parseJsonReply } from './agent-runtime.mjs';
import { HttpError } from './http.mjs';
import { editTimelineTool, filmSummary } from './agent-tools.mjs';

/** The contract appended to every storyboard conversation turn. */
export const STORYBOARD_CONTRACT = `Return only JSON: {"reply":"short Chinese answer","operations":[],"intent":"edit|match|none"}.
- operations are storyboard changes: setTargetDuration, distributeDurations, setShotDuration, updateShot, deleteShot, duplicateShot, reorderShots, moveShot, addShot, addScene, updateScene, setMatch, clearMatch, rematchShots, lockShots, setBrief.
Never touch a locked shot or invent a media path. Do not edit the timeline; the storyboard is the only document for this turn. Put a clear executable edit in this answer when the request is clear; otherwise explain the blocker in reply.`;

/** The contract for the edit stage: timeline only, no storyboard relation. */
export const EDIT_CONTRACT = `Return only JSON: {"reply":"short Chinese answer","filmOps":[],"intent":"edit|none","preview_request":null}.
- filmOps are timeline changes: set {clip,field,value}, move {clip,at,track?}, insert {clip:{src,...},at,track?}, remove {clip}, props {edits:[{clip,prop,value}]}, fields {clip,fields}, split {clip,at}, stage {w,h}, track {track,field,value}, reorder {from,to}.
- Use 「clip」 with the clip id (not 「clipId」), and 「at」 in seconds.
- The project context contains current tracks, clips, stage and project files; use clip ids and existing asset paths.
- This is the edit stage after the storyboard was handed off. Do not read or modify the storyboard, and do not return storyboard operations.
- Never touch a locked track or clip. Never render, export, generate TTS or generate music; those are the person's actions.
- Put a clear executable edit in this answer when the request is clear; otherwise explain the blocker in reply.`;

/** A compact context for the storyboard conversation, with candidate descriptions when known. */
export function storyboardContext(
  /** @type {any} */ doc,
  /** @type {readonly string[]} */ selected,
  /** @type {Record<string, string>} */ descriptions,
) {
  return {
    title: doc.title,
    durationMs: doc.brief.durationMs,
    shots: doc.shots.map((/** @type {any} */ shot) => ({
      id: shot.id,
      index: shot.order + 1,
      title: shot.title,
      narration: shot.narration,
      visualIntent: shot.visualIntent,
      targetMs: shot.targetMs,
      state: shot.match.state,
      locked: shot.locked,
      candidates: shot.match.candidates.slice(0, 6).map((/** @type {any} */ candidate) => ({
        id: candidate.id,
        name: candidate.name,
        score: candidate.score,
        startMs: candidate.startMs,
        endMs: candidate.endMs,
        ...(descriptions[candidate.path] ? { desc: descriptions[candidate.path] } : {}),
      })),
    })),
    scenes: doc.scenes.map((/** @type {any} */ scene) => ({ id: scene.id, title: scene.title })),
    selected,
  };
}

/** A compact context for the edit conversation. It has no storyboard reference after handoff. */
export function editContext(/** @type {any} */ film, /** @type {readonly string[]} */ selectedClipIds = [], /** @type {any} */ listing = null) {
  const summary = filmSummary(film);
  return {
    timeline: summary,
    selectedClipIds,
    ...(listing ? {
      project: {
        files: (Array.isArray(listing.files) ? listing.files : []).slice(0, 240).map((/** @type {any} */ file) => ({ path: file.path, kind: file.kind, size: file.size })),
        pages: (Array.isArray(listing.pages) ? listing.pages : []).slice(0, 120).map((/** @type {any} */ page) => ({ path: page.path, size: page.size })),
        folders: (Array.isArray(listing.folders) ? listing.folders : []).slice(0, 80),
      },
    } : {}),
  };
}

/**
 * One conversation turn. Returns the parsed contract; malformed JSON becomes a plain reply with no
 * operations, which is safer than guessing an edit.
 */
export async function conversationTurn(
  /** @type {any} */ project,
  /** @type {{ text: string, scope: 'storyboard' | 'edit', context: unknown, history?: Array<{ role: 'user' | 'agent', text: string }> }} */ input,
) {
  if (!agentReady('conversation')) throw new HttpError(409, '没有可用的对话剪辑 Agent，请先在设置中绑定模型。');
  const scope = input.scope === 'edit' ? 'edit' : 'storyboard';
  const task = scope === 'edit'
    ? 'You are changing the timeline. Use the project context below and return filmOps by clip id. Do not consult or modify the storyboard.'
    : 'You are changing the storyboard. Use read context below and return storyboard operations by shot/candidate id.';
  const contract = scope === 'edit' ? EDIT_CONTRACT : STORYBOARD_CONTRACT;
  const history = /** @type {Array<{ role: 'user' | 'assistant', content: string }>} */ ((Array.isArray(input.history) ? input.history : [])
    .filter((message) => message && (message.role === 'user' || message.role === 'agent') && typeof message.text === 'string' && message.text.trim())
    .slice(-12)
    .map((message) => ({ role: message.role === 'agent' ? 'assistant' : 'user', content: message.text.slice(0, 8_000) })));
  const reply = await callAgent('conversation', [
    ...history,
    {
      role: 'user',
      content: `${task}\n\nCONTEXT:\n${JSON.stringify(input.context).slice(0, 180_000)}\n\nREQUEST:\n${input.text.slice(0, 120_000)}\n\n${contract}`,
    },
  ], { project });

  let parsed;
  try { parsed = parseJsonReply(reply); }
  catch {
    return {
      reply: reply.trim().slice(0, 20_000),
      operations: /** @type {Array<Record<string, unknown>>} */ ([]),
      filmOps: /** @type {Array<Record<string, unknown>>} */ ([]),
      intent: undefined,
      parsed: false,
    };
  }
  const operations = Array.isArray(parsed?.operations)
    ? parsed.operations.filter((/** @type {unknown} */ item) => item && typeof item === 'object').slice(0, 80)
    : [];
  const filmOps = Array.isArray(parsed?.filmOps)
    ? parsed.filmOps.filter((/** @type {unknown} */ item) => item && typeof item === 'object').slice(0, 80)
    : [];
  return {
    reply: typeof parsed?.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim().slice(0, 20_000) : '已完成。',
    operations: /** @type {Array<Record<string, unknown>>} */ (operations),
    filmOps: /** @type {Array<Record<string, unknown>>} */ (filmOps),
    intent: parsed?.intent === 'edit' || parsed?.intent === 'match' || parsed?.intent === 'none' ? parsed.intent : undefined,
    preview_request: parsed?.preview_request ?? null,
    parsed: true,
  };
}

/** Apply the timeline half of a conversation turn. Empty filmOps means the turn only answered. */
export async function applyFilmOps(/** @type {any} */ project, /** @type {Array<Record<string, unknown>>} */ filmOps) {
  if (!filmOps.length) return null;
  return editTimelineTool(project, { ops: filmOps });
}
