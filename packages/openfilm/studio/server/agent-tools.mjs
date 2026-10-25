// @ts-check
/**
 * The controlled tools both the conversation agent and the MCP server use.
 *
 * Everything here goes through OpenFilm's own documents: storyboard operations use
 * `storyboard.mjs` and timeline operations use `film.mjs`. A tool never touches a project file
 * directly, never renders or exports, and never invents media paths. Keeping the registry here
 * means the browser conversation and an external ACP agent share one implementation and one set of
 * permissions.
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { editProjectFilm, readProjectFilm } from './film.mjs';
import { listFiles } from './files.mjs';
import { writeAtomic } from './atomic.mjs';
import { HttpError } from './http.mjs';
import { applyOperations, readStoryboard, saveStoryboard } from './storyboard.mjs';

const MAX_OPERATIONS = 80;
const undoFile = (/** @type {any} */ project) => join(project.path, '.film', 'agent-undo.json');

/** A small, model-friendly summary of the storyboard's state. */
export function storyboardSummary(/** @type {any} */ doc) {
  return {
    revision: doc.revision,
    title: doc.title,
    brief: doc.brief,
    handedOffAt: doc.handedOffAt,
    scenes: doc.scenes.map((/** @type {any} */ scene) => ({ id: scene.id, title: scene.title, order: scene.order })),
    shots: doc.shots.map((/** @type {any} */ shot) => ({
      id: shot.id,
      sceneId: shot.sceneId,
      order: shot.order,
      title: shot.title,
      narration: shot.narration,
      visualIntent: shot.visualIntent,
      targetMs: shot.targetMs,
      locked: shot.locked,
      state: shot.match.state,
      selectedId: shot.match.selectedId,
      confidence: shot.match.confidence,
      candidates: shot.match.candidates.length,
      ...(shot.match.error ? { error: shot.match.error } : {}),
    })),
  };
}

/** The parts of a film a conversation or tool needs, without the whole film text. */
export function filmSummary(/** @type {any} */ film) {
  const doc = film?.doc ?? null;
  const tracks = Array.isArray(doc?.tracks) ? doc.tracks : [];
  const clips = tracks.flatMap((/** @type {any} */ track, /** @type {number} */ trackIndex) => (
    (Array.isArray(track.clips) ? track.clips : []).map((/** @type {any} */ clip) => {
      const at = Number(clip.at) || 0;
      const time = Array.isArray(clip.time) ? clip.time.map(Number) : [];
      const from = Number(time[0]) || 0;
      const to = Number(time[1]) || from;
      return {
        id: clip.id,
        track: trackIndex,
        src: clip.src,
        at,
        time: [from, to],
        durationMs: Math.max(0, (to - from) * 1000),
        ...(clip.link ? { link: clip.link } : {}),
      };
    })
  ));
  return {
    rev: film?.rev ?? '',
    problems: Array.isArray(film?.problems) ? film.problems : [],
    trackCount: tracks.length,
    stage: doc?.stage ?? null,
    trackFlags: tracks.map((/** @type {any} */ track, /** @type {number} */ index) => ({
      track: index,
      locked: Boolean(track.locked),
      hidden: Boolean(track.hidden),
      muted: Boolean(track.muted),
    })),
    clips,
    durationMs: Math.round(Math.max(0, ...clips.map((/** @type {any} */ clip) => clip.at * 1000 + clip.durationMs))),
  };
}

export async function readProjectTool(/** @type {any} */ project, /** @type {{ editStage?: boolean }} */ options = {}) {
  const doc = readStoryboard(project);
  const film = await readProjectFilm(project.path);
  const storyboard = storyboardSummary(doc);
  const timeline = filmSummary(film);
  return {
    id: project.id,
    name: project.name,
    phase: options.editStage ? 'edit' : 'storyboard',
    ...(options.editStage ? {} : {
      storyboard: {
        revision: storyboard.revision,
        title: storyboard.title,
        brief: storyboard.brief,
        handedOffAt: storyboard.handedOffAt,
        scenes: storyboard.scenes,
        shotCount: storyboard.shots.length,
        selected: storyboard.shots.filter((/** @type {any} */ shot) => shot.selectedId).length,
      },
    }),
    film: {
      rev: timeline.rev,
      trackCount: timeline.trackCount,
      clipCount: timeline.clips.length,
      durationMs: timeline.durationMs,
      problems: timeline.problems,
    },
  };
}

export async function readStoryboardTool(/** @type {any} */ project) {
  return { storyboard: readStoryboard(project) };
}

export async function readTimelineTool(/** @type {any} */ project) {
  const film = await readProjectFilm(project.path);
  return { timeline: filmSummary(film), value: film.value };
}

/** The project's files and pages, so an editing agent can insert an existing asset by path. */
export async function listProjectFilesTool(/** @type {any} */ project) {
  const listing = await listFiles(project.path);
  return {
    files: listing.files.slice(0, 500).map((/** @type {any} */ file) => ({ path: file.path, kind: file.kind, size: file.size, mtime: file.mtime })),
    pages: listing.pages.slice(0, 200).map((/** @type {any} */ page) => ({ path: page.path, size: page.size, mtime: page.mtime })),
    folders: listing.folders.slice(0, 200),
  };
}

/** Normalize the aliases models commonly use for a timeline clip into `applyOps`'s `clip`. */
function normalizeFilmOps(/** @type {unknown} */ value) {
  const list = Array.isArray(value) ? value : [];
  return list.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const op = /** @type {Record<string, any>} */ ({ ...raw });
    const opName = op.op ?? op.operation ?? op.action;
    if (opName != null) op.op = String(opName);
    delete op.operation;
    delete op.action;
    const clip = op.clip ?? op.clipId ?? op.clip_id;
    if (clip != null && op.clip == null) op.clip = String(clip);
    delete op.clipId;
    delete op.clip_id;
    if (op.op === 'props' && Array.isArray(op.edits)) {
      op.edits = op.edits.map((/** @type {any} */ edit) => {
        if (!edit || typeof edit !== 'object') return edit;
        const next = { ...edit };
        const id = next.clip ?? next.clipId ?? next.clip_id;
        if (id != null && next.clip == null) next.clip = String(id);
        delete next.clipId;
        delete next.clip_id;
        return next;
      });
    }
    return [op];
  }).slice(0, MAX_OPERATIONS);
}

/** Apply validated storyboard operations. A stale `baseRevision` is a conflict, not a silent overwrite. */
export async function editStoryboardTool(/** @type {any} */ project, /** @type {any} */ input) {
  const operations = Array.isArray(input?.operations) ? input.operations.slice(0, MAX_OPERATIONS) : [];
  if (!operations.length) throw new HttpError(400, 'operations must be a non-empty array');
  const current = readStoryboard(project);
  if (typeof input?.baseRevision === 'number' && input.baseRevision !== current.revision) {
    throw new HttpError(409, 'the storyboard changed; read it again before editing', { revision: current.revision });
  }
  const next = applyOperations(current, operations);
  const saved = await saveStoryboard(project, next, current.revision);
  return { storyboard: saved, applied: operations.length };
}

/** Apply validated timeline operations. `editProjectFilm` keeps the file and its revision in charge. */
export async function editTimelineTool(/** @type {any} */ project, /** @type {any} */ input) {
  const ops = normalizeFilmOps(input?.ops);
  if (!ops.length) throw new HttpError(400, 'ops must be a non-empty array');
  const current = await readProjectFilm(project.path);
  /* One snapshot per validated tool edit: an explicit undo is possible even without Studio's UI. */
  await mkdir(join(project.path, '.film'), { recursive: true });
  await writeAtomic(undoFile(project), `${JSON.stringify({ at: Date.now(), rev: current.rev, text: current.text, ops }, null, 2)}\n`, { mode: 0o600 });
  const result = await editProjectFilm(project.path, typeof input?.base === 'string' && input.base ? input.base : current.rev, /** @type {any} */ (ops));
  return {
    rev: result.rev,
    rebased: result.rebased,
    timeline: filmSummary({ doc: result.doc, rev: result.rev, problems: [] }),
  };
}

/** Restore the timeline text saved before the last tool edit. */
export async function undoTimelineTool(/** @type {any} */ project) {
  let snapshot;
  try { snapshot = JSON.parse(await readFile(undoFile(project), 'utf8')); }
  catch { throw new HttpError(404, 'there is no timeline edit to undo'); }
  if (!snapshot || typeof snapshot.text !== 'string') throw new HttpError(404, 'the timeline undo snapshot is not readable');
  await writeAtomic(join(project.path, 'film.html'), snapshot.text);
  await rm(undoFile(project), { force: true });
  const film = await readProjectFilm(project.path);
  return { rev: film.rev, timeline: filmSummary(film), restoredFrom: snapshot.at ?? null };
}

/**
 * Automatic, deterministic QC. It is the cheap always-on layer; the pipeline's qc work slot adds
 * visual/editorial judgement where a vision model is configured.
 */
export function qcReport(/** @type {any} */ project, /** @type {any} */ doc = readStoryboard(project), /** @type {any} */ film = null) {
  /** @type {string[]} */
  const issues = [];
  const timeline = film?.doc ? filmSummary(film) : null;
  if (!doc.shots.length) issues.push('分镜为空：还没有可质检的镜头。');
  const selectedPaths = new Map();
  for (const shot of doc.shots) {
    const label = `第 ${shot.order + 1} 镜「${shot.title}」`;
    if (!shot.targetMs || shot.targetMs < 500) issues.push(`${label} 的目标时长过短。`);
    if (!shot.match.candidates.length) issues.push(`${label} 还没有候选素材。`);
    else if (!shot.match.selectedId) issues.push(`${label} 还没有选定素材。`);
    if (shot.match.state === 'review') issues.push(`${label} 的候选需要人工复核。`);
    if (shot.match.state === 'gap') issues.push(`${label} 存在素材缺口。`);
    if (shot.match.error) issues.push(`${label} 检索失败：${shot.match.error}`);
    const selected = shot.match.candidates.find((/** @type {any} */ candidate) => candidate.id === shot.match.selectedId);
    if (selected?.path) {
      const at = selectedPaths.get(selected.path) ?? [];
      at.push(shot.order + 1);
      selectedPaths.set(selected.path, at);
    }
  }
  for (const [path, orders] of selectedPaths) {
    if (orders.length > 1) issues.push(`素材「${path}」被 ${orders.length} 个镜头重复使用（第 ${orders.join('、')} 镜）。`);
  }
  if (doc.shots.length) {
    const total = doc.shots.reduce((/** @type {number} */ sum, /** @type {any} */ shot) => sum + (Number(shot.targetMs) || 0), 0);
    const wanted = Number(doc.brief?.durationMs) || 0;
    if (wanted && Math.abs(total - wanted) > Math.max(1000, wanted * 0.15)) {
      issues.push(`分镜目标总时长 ${(total / 1000).toFixed(1)}s 与成片目标 ${(wanted / 1000).toFixed(1)}s 相差较大。`);
    }
    if (timeline && timeline.clips.length === 0) {
      issues.push('分镜已有内容，但时间线还没有素材。');
    }
  }
  return {
    ok: issues.length === 0,
    issues,
    summary: {
      shots: doc.shots.length,
      selected: doc.shots.filter((/** @type {any} */ shot) => Boolean(shot.match.selectedId)).length,
      review: doc.shots.filter((/** @type {any} */ shot) => shot.match.state === 'review').length,
      gaps: doc.shots.filter((/** @type {any} */ shot) => shot.match.state === 'gap' || !shot.match.selectedId).length,
      timelineClips: timeline?.clips.length ?? 0,
    },
  };
}

export async function qcTool(/** @type {any} */ project) {
  const doc = readStoryboard(project);
  const film = await readProjectFilm(project.path);
  return qcReport(project, doc, film);
}

export async function searchMaterialsTool(/** @type {any} */ project, /** @type {any} */ semanticIndex, /** @type {any} */ input) {
  const query = typeof input?.query === 'string' ? input.query.trim() : '';
  if (!query) throw new HttpError(400, 'query is required');
  const result = await semanticIndex.search(project, {
    query: { type: 'text', text: query.slice(0, 1200) },
    mode: 'chunk',
    topK: Math.max(1, Math.min(40, Number(input?.topK) || 12)),
    libraryIds: [project.id],
  });
  return {
    hits: (Array.isArray(result?.hits) ? result.hits : []).slice(0, 40).map((/** @type {any} */ hit) => ({
      libraryId: hit.libraryId,
      path: hit.path,
      name: hit.name,
      kind: hit.kind,
      startMs: hit.startMs,
      endMs: hit.endMs,
      score: hit.score,
      thumbUrl: hit.thumbUrl,
    })),
    meta: result?.meta ?? null,
  };
}

/** MCP tool definitions. They intentionally stop short of render/export and audio generation. */
export const MCP_TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'read_project',
    description: 'Read the project summary. Before storyboard handoff it includes the storyboard; after handoff it is timeline-only (phase: edit).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_storyboard',
    description: 'Read the full storyboard document, including scenes, shots, candidates and selected material.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'read_timeline',
    description: 'Read the timeline: tracks, clip ids, source paths, trims, positions and the checked film value.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_project_files',
    description: 'List the project’s media files, pages and folders, with paths an edit_timeline insert can use. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'edit_storyboard',
    description: 'Apply storyboard operations by shot/candidate id. Allowed types: setTargetDuration, distributeDurations, setShotDuration, updateShot, deleteShot, duplicateShot, reorderShots, moveShot, addShot, addScene, updateScene, setMatch, clearMatch, rematchShots, lockShots, setBrief. Locked shots cannot be changed. Use read_storyboard first.',
    inputSchema: {
      type: 'object',
      required: ['operations'],
      properties: {
        baseRevision: { type: 'number', description: 'The revision read before this edit; a newer revision returns a conflict.' },
        operations: { type: 'array', items: { type: 'object' }, description: 'Storyboard operations, each with a type. The conversation agent contract lists the allowed types.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'edit_timeline',
    description: 'Apply timeline operations by clip id. The server validates the result and saves a one-step undo snapshot. Renders and exports are never available.',
    inputSchema: {
      type: 'object',
      required: ['ops'],
      properties: {
        base: { type: 'string', description: 'The timeline revision read before this edit; a different current revision is rebased by clip id.' },
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['set', 'move', 'insert', 'remove', 'split', 'props', 'stage', 'fields', 'track', 'reorder'] },
            },
            required: ['op'],
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'undo_timeline',
    description: 'Restore the timeline text saved before the last edit_timeline call. Storyboard edits use Studio’s storyboard undo instead.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_materials',
    description: 'Search the project material index with a visual text query. Returns candidates and their paths; it does not attach them.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        topK: { type: 'number', description: '1–40 candidates; default 12.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'qc',
    description: 'Run automatic deterministic QC over the storyboard and timeline. Returns issues and counts; it never edits anything.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'preview',
    description: 'Tell the person where to look. Studio updates its preview from the documents; this tool does not render an MP4.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]);

export const MCP_TOOL_NAMES = new Set(MCP_TOOL_DEFINITIONS.map((tool) => tool.name));
