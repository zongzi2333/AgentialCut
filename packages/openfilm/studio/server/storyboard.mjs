// @ts-check
/**
 * Storyboard documents: the storyboard step's own data, kept in `<project>/.film/storyboard.json`.
 *
 * The document is an artifact, not a timeline: scenes hold the intent, shots hold the words and the
 * visual requirement, and a shot's `match` holds the candidates the matcher found and the one that was
 * adopted. The rough cut is derived by `handoffClips` and written to the editor's normal timeline later.
 *
 * Everything here is pure enough to test without a server: reading, checking, generating a local draft,
 * applying a controlled proposal, and collecting the clips for handoff. The HTTP routes and the model
 * calls live beside it in server.mjs and agent-runtime.mjs.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './http.mjs';
import { writeAtomic } from './atomic.mjs';

/** @typedef {{ verdict: 'pass' | 'uncertain' | 'fail', confidence: number, reason: string }} StoryboardReview */
/** @typedef {{ id: string, libraryId: string, libraryName: string, assetId: string, path: string, name: string, kind: string, startMs: number, endMs: number, score: number, thumbUrl: string, modelId?: string, origin: 'library' | 'generated', review?: StoryboardReview }} StoryboardCandidate */
/** @typedef {{ state: 'draft' | 'matched' | 'review' | 'gap', candidates: StoryboardCandidate[], selectedId: string | null, confidence: number, query?: string, stale?: boolean, error?: string }} StoryboardMatch */
/** @typedef {{ id: string, sceneId: string, order: number, title: string, narration: string, visualIntent: string, must: string[], avoid: string[], targetMs: number, locked: boolean, generated: boolean, match: StoryboardMatch }} StoryboardShot */
/** @typedef {{ id: string, title: string, order: number }} StoryboardScene */
/** @typedef {{ durationMs: number, aspect: string, tone: string, notes: string }} StoryboardBrief */
/** @typedef {{ version: 1, revision: number, id: string, title: string, brief: StoryboardBrief, scenes: StoryboardScene[], shots: StoryboardShot[], source: 'manual' | 'local' | 'ai', createdAt: number, updatedAt: number, handedOffAt: number | null, roughcut: null | { createdAt: number, durationMs: number, clips: HandoffClip[], gaps: string[] } }} Storyboard */
/** @typedef {{ shotId: string, path: string, name: string, startMs: number, endMs: number, durationMs: number }} HandoffClip */

export const STORYBOARD_FILE = 'storyboard.json';
export const MAX_SHOTS = 200;
export const MAX_CANDIDATES = 40;
/** Below this a match is still adopted, but marked for the person to review. */
export const REVIEW_SCORE = 0.55;
export const LOW_SCORE = 0.35;

const now = () => Date.now();
const clean = (/** @type {unknown} */ value, /** @type {number} */ max) => String(value ?? '').trim().slice(0, max);
const integer = (/** @type {unknown} */ value, /** @type {number} */ fallback, /** @type {number} */ min, /** @type {number} */ max) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};
const textList = (/** @type {unknown} */ value) => Array.isArray(value)
  ? value.map((entry) => clean(entry, 120)).filter(Boolean).slice(0, 12)
  : [];
/** @param {string} prefix */
const id = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;
const within = (/** @type {number} */ value) => Math.min(1, Math.max(0, value));

/** A new, empty storyboard. Revision 0 means it has not been saved yet. */
export function emptyStoryboard(/** @type {{ name?: string, path?: string }} */ project = {}) {
  const at = now();
  return /** @type {Storyboard} */ ({
    version: 1,
    revision: 0,
    id: id('sb'),
    title: clean(project.name, 120) || 'Storyboard',
    brief: { durationMs: 30_000, aspect: '16:9', tone: '', notes: '' },
    scenes: [],
    shots: [],
    source: 'manual',
    createdAt: at,
    updatedAt: at,
    handedOffAt: null,
    roughcut: null,
  });
}

/** The path of a project's storyboard document. */
export const storyboardPath = (/** @type {{ path: string }} */ project) => join(project.path, '.film', STORYBOARD_FILE);

/** Read the document, or an empty one when the project has none. A broken file is an error rather than silence. */
export function readStoryboard(/** @type {{ id?: string, name?: string, path: string }} */ project) {
  const file = storyboardPath(project);
  if (!existsSync(file)) return emptyStoryboard(project);
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new HttpError(500, 'The storyboard file is not valid JSON. Nothing was overwritten.'); }
  return normalizeStoryboard(raw, project);
}

/** Normalize anything the editor or a model wrote into the current shape. Unknown fields are dropped. */
export function normalizeStoryboard(/** @type {unknown} */ raw, /** @type {{ name?: string, path?: string }} */ project = {}) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, any>} */ (raw) : {};
  const base = emptyStoryboard(project);
  const at = now();
  const briefRaw = source.brief && typeof source.brief === 'object' ? source.brief : {};
  const scenesRaw = Array.isArray(source.scenes) ? source.scenes : [];
  const shotsRaw = Array.isArray(source.shots) ? source.shots : [];
  /** @type {StoryboardScene[]} */
  const scenes = scenesRaw.slice(0, MAX_SHOTS).map((scene, index) => ({
    id: clean(scene?.id, 80) || id('sc'),
    title: clean(scene?.title, 160) || `Scene ${index + 1}`,
    order: index,
  }));
  if (!scenes.length) scenes.push({ id: id('sc'), title: 'Scene 01', order: 0 });
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  /** @type {StoryboardShot[]} */
  const shots = shotsRaw.slice(0, MAX_SHOTS).map((shot, index) => {
    const sceneId = sceneIds.has(clean(shot?.sceneId, 80)) ? clean(shot.sceneId, 80) : scenes[0].id;
    return {
      id: clean(shot?.id, 80) || id('sh'),
      sceneId,
      order: index,
      title: clean(shot?.title, 200) || `Shot ${index + 1}`,
      narration: clean(shot?.narration, 4000),
      visualIntent: clean(shot?.visualIntent, 2000),
      must: textList(shot?.must),
      avoid: textList(shot?.avoid),
      targetMs: integer(shot?.targetMs, 4000, 500, 120_000),
      locked: Boolean(shot?.locked),
      generated: Boolean(shot?.generated),
      match: normalizeMatch(shot?.match),
    };
  });
  // A scene with no shots is still a useful draft; remove scene ids that no shot references is not needed.
  return /** @type {Storyboard} */ ({
    version: 1,
    revision: integer(source.revision, 0, 0, 1_000_000_000),
    id: clean(source.id, 80) || base.id,
    title: clean(source.title, 160) || base.title,
    brief: {
      durationMs: integer(briefRaw.durationMs, base.brief.durationMs, 1000, 3_600_000),
      aspect: clean(briefRaw.aspect, 20) || base.brief.aspect,
      tone: clean(briefRaw.tone, 200),
      notes: clean(briefRaw.notes, 2000),
    },
    scenes,
    shots,
    source: source.source === 'ai' || source.source === 'local' ? source.source : 'manual',
    createdAt: integer(source.createdAt, at, 0, 9e15),
    updatedAt: integer(source.updatedAt, at, 0, 9e15),
    handedOffAt: source.handedOffAt == null ? null : integer(source.handedOffAt, 0, 0, 9e15) || null,
    roughcut: normalizeRoughcut(source.roughcut),
  });
}

function normalizeMatch(/** @type {unknown} */ value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {};
  const candidates = /** @type {StoryboardCandidate[]} */ ((Array.isArray(raw.candidates) ? raw.candidates : []).slice(0, MAX_CANDIDATES).map((candidate, index) => normalizeCandidate(candidate, index)).filter(Boolean));
  const chosen = clean(raw.selectedId, 120);
  const selected = candidates.find((candidate) => candidate.id === chosen) ?? candidates[0] ?? null;
  const state = candidates.length ? (raw.state === 'review' ? 'review' : 'matched') : (raw.state === 'draft' ? 'draft' : 'gap');
  return /** @type {StoryboardMatch} */ ({
    state,
    candidates,
    selectedId: selected?.id ?? null,
    confidence: selected ? Math.round(within(selected.score) * 100) : 0,
    query: clean(raw.query, 500),
    ...(raw.stale ? { stale: true } : {}),
    ...(raw.error ? { error: clean(raw.error, 500) } : {}),
  });
}

function normalizeCandidate(/** @type {unknown} */ value, /** @type {number} */ index) {
  if (!value || typeof value !== 'object') return null;
  const raw = /** @type {Record<string, any>} */ (value);
  const path = clean(raw.path, 3000);
  if (!path) return null;
  const startMs = integer(raw.startMs, 0, 0, 86_400_000);
  const endMs = Math.max(startMs, integer(raw.endMs, startMs, 0, 86_400_000));
  return /** @type {StoryboardCandidate} */ ({
    id: clean(raw.id, 120) || `candidate_${index + 1}`,
    libraryId: clean(raw.libraryId, 120),
    libraryName: clean(raw.libraryName, 200),
    assetId: clean(raw.assetId, 3000),
    path,
    name: clean(raw.name, 300) || path.slice(path.lastIndexOf('/') + 1),
    kind: clean(raw.kind, 20) || 'video',
    startMs,
    endMs,
    score: within(Number(raw.score) || 0),
    thumbUrl: clean(raw.thumbUrl, 4000),
    modelId: clean(raw.modelId, 200) || undefined,
    origin: raw.origin === 'generated' ? 'generated' : 'library',
    ...(raw.review && typeof raw.review === 'object' ? {
      review: {
        verdict: raw.review.verdict === 'pass' || raw.review.verdict === 'fail' ? raw.review.verdict : 'uncertain',
        confidence: within(Number(raw.review.confidence) || 0),
        reason: clean(raw.review.reason, 500),
      },
    } : {}),
  });
}

function normalizeRoughcut(/** @type {unknown} */ value) {
  if (!value || typeof value !== 'object') return null;
  const raw = /** @type {Record<string, any>} */ (value);
  const clips = Array.isArray(raw.clips) ? raw.clips.filter((clip) => clip && typeof clip === 'object').map((clip) => ({
    shotId: clean(clip.shotId, 80),
    path: clean(clip.path, 3000),
    name: clean(clip.name, 300),
    startMs: integer(clip.startMs, 0, 0, 86_400_000),
    endMs: integer(clip.endMs, 0, 0, 86_400_000),
    durationMs: integer(clip.durationMs, 0, 0, 86_400_000),
  })).slice(0, MAX_SHOTS) : [];
  return {
    createdAt: integer(raw.createdAt, now(), 0, 9e15),
    durationMs: integer(raw.durationMs, 0, 0, 9e15),
    clips,
    gaps: textList(raw.gaps),
  };
}

/** One writer per project: two edits arriving together must not read the same revision and both win. */
const writers = new Map();
function serialized(/** @type {string} */ key, /** @type {() => Promise<Storyboard>} */ run) {
  const previous = writers.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  writers.set(key, next);
  void next.then(
    () => { if (writers.get(key) === next) writers.delete(key); },
    () => { if (writers.get(key) === next) writers.delete(key); },
  );
  return next;
}

/** Save the whole document, refusing to overwrite a newer revision. */
export function saveStoryboard(/** @type {{ path: string }} */ project, /** @type {unknown} */ raw, /** @type {number | undefined} */ baseRevision = undefined) {
  return serialized(project.path, async () => {
    const current = readStoryboard(project);
    if (baseRevision != null && baseRevision !== current.revision) {
      throw new HttpError(409, 'This storyboard changed in another window. Reload it before saving.', { revision: current.revision });
    }
    const next = normalizeStoryboard(raw, project);
    next.revision = current.revision + 1;
    next.updatedAt = now();
    if (!next.createdAt) next.createdAt = next.updatedAt;
    await mkdir(join(project.path, '.film'), { recursive: true });
    await writeAtomic(storyboardPath(project), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return next;
  });
}

/** Parse a script or a one-line idea into a usable first draft without a model. */
export function localStoryboard(/** @type {{ name?: string }} */ project, /** @type {{ text?: string, prompt?: string, brief?: Partial<StoryboardBrief> }} */ input) {
  const rawText = clean(input.text, 120_000);
  const prompt = clean(input.prompt, 4000);
  const brief = {
    durationMs: integer(input.brief?.durationMs, 30_000, 1000, 3_600_000),
    aspect: clean(input.brief?.aspect, 20) || '16:9',
    tone: clean(input.brief?.tone, 200),
    notes: clean(input.brief?.notes, 2000),
  };
  const blocks = paragraphs(rawText || prompt);
  /** @type {{ scene: string, text: string }[]} */
  const units = [];
  let scene = '';
  for (const block of blocks) {
    if (block.heading) { scene = block.text; continue; }
    for (const one of splitShots(block.text)) units.push({ scene, text: one });
  }
  const chosen = (units.length ? units : [{ scene: '', text: prompt || rawText || 'The first shot.' }]).slice(0, 80);
  const scenes = [];
  const sceneIndex = new Map();
  const shots = chosen.map((unit, index) => {
    const title = unit.scene || 'Scene 01';
    if (!sceneIndex.has(title)) {
      const one = { id: id('sc'), title, order: sceneIndex.size };
      sceneIndex.set(title, one);
      scenes.push(one);
    }
    const first = unit.text.split(/[。.!?！？\n]/).find((part) => part.trim()) || unit.text;
    return {
      id: id('sh'),
      sceneId: sceneIndex.get(title).id,
      order: index,
      title: first.trim().slice(0, 42) || `Shot ${index + 1}`,
      narration: unit.text,
      visualIntent: unit.text,
      must: [],
      avoid: [],
      targetMs: 4000,
      locked: false,
      generated: false,
      match: { state: 'draft', candidates: [], selectedId: null, confidence: 0 },
    };
  });
  if (!scenes.length) scenes.push({ id: id('sc'), title: 'Scene 01', order: 0 });
  const doc = normalizeStoryboard({
    ...emptyStoryboard(project),
    title: prompt.slice(0, 80) || clean(project.name, 120) || 'Storyboard',
    brief,
    scenes,
    shots,
    source: 'local',
  }, project);
  return distributeDurations(doc, brief.durationMs);
}

function paragraphs(/** @type {string} */ text) {
  const parts = text.replace(/\r\n/g, '\n').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  /** @type {{ heading: boolean, text: string }[]} */
  const out = [];
  for (const part of parts) {
    const heading = /^#{1,6}\s+(.+)(?:\n|$)/.exec(part);
    if (heading) {
      out.push({ heading: true, text: heading[1].trim() });
      const rest = part.slice(heading[0].length).trim();
      if (rest) out.push({ heading: false, text: rest });
    } else {
      out.push({ heading: false, text: part.replace(/^#{1,6}\s+/gm, '').trim() });
    }
  }
  return out;
}

function splitShots(/** @type {string} */ text) {
  const lines = text.split('\n').map((line) => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim()).filter(Boolean);
  if (lines.length > 1) return lines;
  const sentences = text.split(/(?<=[。！？.!?])\s+/).map((line) => line.trim()).filter(Boolean);
  return sentences.length > 1 ? sentences : [text];
}

/**
 * Give each shot a length by what it carries, not by an equal split: a line of dialogue and a
 * visual beat are not the same job. The opening and closing shots get a little breathing room;
 * long narration/visual requirements earn more time. The total still equals the brief.
 */
export function distributeDurations(/** @type {Storyboard} */ doc, /** @type {number} */ durationMs) {
  const total = Math.max(1000, Math.min(3_600_000, Math.round(durationMs)));
  doc.brief.durationMs = total;
  if (!doc.shots.length) return doc;
  const min = 1000;
  const weights = doc.shots.map((shot, index) => {
    const text = `${shot.narration} ${shot.visualIntent} ${shot.title}`.trim();
    const opening = index === 0 ? 0.35 : 0;
    const closing = index === doc.shots.length - 1 ? 0.25 : 0;
    return 1 + Math.min(2.4, text.length / 70) + opening + closing;
  });
  const sum = weights.reduce((all, weight) => all + weight, 0) || 1;
  let left = total;
  doc.shots.forEach((shot, index) => {
    const last = index === doc.shots.length - 1;
    const share = last ? left : Math.max(min, Math.round((weights[index] / sum) * total));
    shot.targetMs = Math.max(500, last ? share : Math.min(share, Math.max(500, left - (doc.shots.length - index - 1) * min)));
    left -= shot.targetMs;
  });
  return doc;
}

/** Scale target lengths so the rough cut lands at `durationMs`, never below half a second. */
export function scaleDuration(/** @type {Storyboard} */ doc, /** @type {number} */ durationMs) {
  const total = Math.max(1000, Math.min(3_600_000, Math.round(durationMs)));
  doc.brief.durationMs = total;
  if (!doc.shots.length) return doc;
  const current = doc.shots.reduce((sum, shot) => sum + shot.targetMs, 0);
  if (!current) return doc;
  let left = total;
  doc.shots.forEach((shot, index) => {
    const last = index === doc.shots.length - 1;
    shot.targetMs = last ? Math.max(500, left) : Math.max(500, Math.round((shot.targetMs / current) * total));
    left -= shot.targetMs;
  });
  return doc;
}

/** Apply a controlled proposal. Every operation either succeeds or the whole proposal is rejected first. */
export function applyOperations(/** @type {Storyboard} */ doc, /** @type {unknown} */ rawOperations) {
  const operations = Array.isArray(rawOperations) ? rawOperations : [];
  if (operations.length > 80) throw new HttpError(400, 'too many storyboard operations');
  const next = normalizeStoryboard(doc);
  for (const raw of operations) {
    if (!raw || typeof raw !== 'object') throw new HttpError(400, 'a storyboard operation is not an object');
    const op = /** @type {Record<string, any>} */ (raw);
    /* Models often drop `type`, or use a natural name. Accept the common shapes so one missing key
       does not throw away an otherwise useful edit; the whole proposal is still validated first. */
    const rawType = String(op.type ?? op.operation ?? op.action ?? '').trim();
    const type = ({
      setshotduration: 'setShotDuration', setduration: 'setShotDuration', setshotlength: 'setShotDuration',
      updateduration: 'setShotDuration', duration: 'setShotDuration',
      setshot: 'updateShot', updateshot: 'updateShot', editshot: 'updateShot', modifyshot: 'updateShot',
      setshotfields: 'updateShot', updateshotfields: 'updateShot', replaceshot: 'updateShot',
      settitle: 'updateShot', setnarration: 'updateShot', setvisualintent: 'updateShot',
      removeshot: 'deleteShot', delete: 'deleteShot', remove: 'deleteShot',
      createshot: 'addShot', insertshot: 'addShot', newshot: 'addShot',
      moveshot: 'moveShot', reordershot: 'moveShot',
      duplicateshot: 'duplicateShot', copyshot: 'duplicateShot',
      clearmatch: 'clearMatch', removematch: 'clearMatch', unmatch: 'clearMatch',
      distribute: 'distributeDurations', distributedurations: 'distributeDurations',
      balancdurations: 'distributeDurations', balancetiming: 'distributeDurations',
      rematch: 'rematchShots', rematchshot: 'rematchShots', markstale: 'rematchShots',
      setscene: 'updateScene', updatescene: 'updateScene',
      addscene: 'addScene', createscene: 'addScene',
      lockshots: 'lockShots', lock: 'lockShots',
    })[rawType.toLowerCase()] ?? rawType;
    const inferred = !type
      ? (op.shotIds ? 'reorderShots' : op.brief ? 'setBrief' : op.scene ? 'addScene' : op.shot ? 'addShot'
        : op.candidateId ? 'setMatch' : op.patch || op.shotId ? 'updateShot' : op.durationMs ? 'setTargetDuration' : '')
      : type;
    if (!inferred) throw new HttpError(400, `unknown storyboard operation: ${String(op.type ?? 'missing type')}`);
    const kind = inferred;
    const shot = op.shotId ? next.shots.find((item) => item.id === String(op.shotId)) : null;
    switch (kind) {
      case 'setBrief': {
        const brief = op.brief && typeof op.brief === 'object' ? op.brief : op;
        if (brief.durationMs != null) next.brief.durationMs = integer(brief.durationMs, next.brief.durationMs, 1000, 3_600_000);
        if (brief.aspect != null) next.brief.aspect = clean(brief.aspect, 20) || next.brief.aspect;
        if (brief.tone != null) next.brief.tone = clean(brief.tone, 200);
        if (brief.notes != null) next.brief.notes = clean(brief.notes, 2000);
        break;
      }
      case 'setTargetDuration':
        scaleDuration(next, integer(op.durationMs ?? op.targetDuration, next.brief.durationMs, 1000, 3_600_000));
        break;
      case 'distributeDurations':
        distributeDurations(next, integer(op.durationMs ?? op.targetDuration, next.brief.durationMs, 1000, 3_600_000));
        break;
      case 'setShotDuration': {
        if (!shot) throw new HttpError(404, 'no such shot');
        if (shot.locked) throw new HttpError(409, 'that shot is locked');
        shot.targetMs = integer(op.targetMs ?? op.durationMs ?? op.duration, shot.targetMs, 500, 120_000);
        break;
      }
      case 'updateShot': {
        if (!shot) throw new HttpError(404, 'no such shot');
        if (shot.locked) throw new HttpError(409, 'that shot is locked');
        const patch = op.patch && typeof op.patch === 'object' ? op.patch : op;
        if (patch.title != null) shot.title = clean(patch.title, 200) || shot.title;
        if (patch.narration != null) shot.narration = clean(patch.narration, 4000);
        if (patch.visualIntent != null) shot.visualIntent = clean(patch.visualIntent, 2000);
        if (patch.must != null) shot.must = textList(patch.must);
        if (patch.avoid != null) shot.avoid = textList(patch.avoid);
        if (patch.targetMs != null || patch.durationMs != null) shot.targetMs = integer(patch.targetMs ?? patch.durationMs, shot.targetMs, 500, 120_000);
        if (patch.locked != null) shot.locked = Boolean(patch.locked);
        if (patch.generated != null) shot.generated = Boolean(patch.generated);
        if (['title', 'narration', 'visualIntent', 'must', 'avoid'].some((key) => key in patch)) {
          shot.match = { ...shot.match, stale: true };
        }
        break;
      }
      case 'addShot': {
        const input = op.shot && typeof op.shot === 'object' ? op.shot : op;
        const sceneId = next.scenes.some((scene) => scene.id === String(op.sceneId)) ? String(op.sceneId) : next.scenes[0]?.id;
        if (!sceneId) throw new HttpError(409, 'add a scene before a shot');
        const at = op.index == null ? next.shots.length : Math.max(0, Math.min(next.shots.length, integer(op.index, next.shots.length, 0, MAX_SHOTS)));
        next.shots.splice(at, 0, normalizeShot({ ...input, sceneId }, next.shots.length));
        break;
      }
      case 'duplicateShot': {
        if (!shot) throw new HttpError(404, 'no such shot');
        const copy = { ...normalizeShot({ ...shot, id: '', locked: false }, next.shots.length), sceneId: shot.sceneId, match: { ...shot.match, candidates: [...shot.match.candidates], selectedId: shot.match.selectedId } };
        next.shots.splice(shot.order + 1, 0, copy);
        break;
      }
      case 'deleteShot':
        if (!shot) throw new HttpError(404, 'no such shot');
        if (shot.locked) throw new HttpError(409, 'that shot is locked');
        next.shots = next.shots.filter((item) => item.id !== shot.id);
        break;
      case 'reorderShots': {
        const ids = Array.isArray(op.shotIds) ? op.shotIds.map(String) : [];
        if (new Set(ids).size !== ids.length || ids.length !== next.shots.length || ids.some((one) => !next.shots.some((item) => item.id === one))) {
          throw new HttpError(400, 'reorderShots must name every shot once');
        }
        const byId = new Map(next.shots.map((item) => [item.id, item]));
        next.shots = ids.map((one) => /** @type {StoryboardShot} */ (byId.get(one)));
        break;
      }
      case 'moveShot': {
        if (!shot) throw new HttpError(404, 'no such shot');
        const to = Math.max(0, Math.min(next.shots.length - 1, integer(op.index ?? op.toIndex ?? op.to, shot.order, 0, MAX_SHOTS)));
        const [moved] = next.shots.splice(shot.order, 1);
        next.shots.splice(to, 0, moved);
        break;
      }
      case 'setMatch': {
        if (!shot) throw new HttpError(404, 'no such shot');
        if (shot.locked) throw new HttpError(409, 'that shot is locked');
        const candidate = shot.match.candidates.find((item) => item.id === String(op.candidateId));
        if (!candidate) throw new HttpError(404, 'no such candidate');
        shot.match = { ...shot.match, selectedId: candidate.id, confidence: Math.round(within(candidate.score) * 100), state: candidate.score < REVIEW_SCORE ? 'review' : 'matched' };
        break;
      }
      case 'clearMatch': {
        if (!shot) throw new HttpError(404, 'no such shot');
        if (shot.locked) throw new HttpError(409, 'that shot is locked');
        shot.match = { ...shot.match, selectedId: null, state: 'gap', confidence: 0 };
        break;
      }
      case 'rematchShots': {
        const ids = Array.isArray(op.shotIds) ? op.shotIds.map(String) : op.shotId ? [String(op.shotId)] : [];
        const targets = ids.length ? next.shots.filter((item) => ids.includes(item.id)) : next.shots;
        for (const target of targets) {
          if (target.locked) continue;
          target.match = { ...target.match, stale: true };
        }
        break;
      }
      case 'lockShots': {
        const ids = Array.isArray(op.shotIds) ? op.shotIds.map(String) : op.shotId ? [String(op.shotId)] : [];
        for (const target of next.shots.filter((item) => ids.includes(item.id))) target.locked = true;
        break;
      }
      case 'updateScene': {
        const scene = next.scenes.find((item) => item.id === String(op.sceneId ?? op.id));
        if (!scene) throw new HttpError(404, 'no such scene');
        if (op.title != null) scene.title = clean(op.title, 200) || scene.title;
        break;
      }
      case 'addScene': {
        const count = next.scenes.length;
        next.scenes.push({ id: id('sc'), title: clean(op.title, 200) || `Scene ${count + 1}`, order: count });
        break;
      }
      default:
        throw new HttpError(400, `unknown storyboard operation: ${String(op.type ?? kind)}`);
    }
  }
  next.shots.forEach((shot, index) => { shot.order = index; });
  next.scenes.forEach((scene, index) => { scene.order = index; });
  next.updatedAt = now();
  return next;
}

function normalizeShot(/** @type {Record<string, any>} */ raw, /** @type {number} */ index) {
  return {
    id: clean(raw.id, 80) || id('sh'),
    sceneId: clean(raw.sceneId, 80),
    order: index,
    title: clean(raw.title, 200) || `Shot ${index + 1}`,
    narration: clean(raw.narration, 4000),
    visualIntent: clean(raw.visualIntent, 2000),
    must: textList(raw.must),
    avoid: textList(raw.avoid),
    targetMs: integer(raw.targetMs, 4000, 500, 120_000),
    locked: Boolean(raw.locked),
    generated: Boolean(raw.generated),
    match: normalizeMatch(raw.match),
  };
}

/**
 * Ask the semantic index for several candidates per shot (never just one); the first is adopted immediately.
 * `planQuery` lets the query agent turn a shot into better search words; a failed model call falls back to
 * the shot's own visual intent, so matching never becomes unavailable because an agent is misconfigured.
 * @param {Storyboard} doc @param {{ id: string, name: string, path: string }} project
 * @param {{ search: Function }} semanticIndex @param {{ shotIds?: unknown, topK?: unknown }} options
 * @param {((shot: StoryboardShot, fallback: string) => Promise<string>) | null} [planQuery]
 */
export async function matchStoryboard(doc, project, semanticIndex, options = {}, planQuery = null) {
  const wanted = new Set(Array.isArray(options.shotIds) ? options.shotIds.map(String) : []);
  const shots = doc.shots.filter((shot) => !shot.locked && (!wanted.size || wanted.has(shot.id)));
  if (!shots.length) return doc;
  const topK = integer(options.topK, 10, 3, 30);
  /* A material already adopted by another shot is not a first choice for this one. The same source
     may still be used when it is the only candidate, but adjacent shots no longer default to the
     same clip. The match score remains the semantic score; this is only selection order. */
  const usedPaths = new Set();
  for (const shot of doc.shots) {
    const chosen = shot.match.candidates.find((candidate) => candidate.id === shot.match.selectedId);
    if (chosen?.path) usedPaths.add(chosen.path);
  }
  for (const shot of shots) {
    const own = shot.match.candidates.find((candidate) => candidate.id === shot.match.selectedId);
    if (own?.path) usedPaths.delete(own.path);
    const fallback = [...new Set([shot.visualIntent, shot.narration, ...shot.must].map((part) => part.trim()).filter(Boolean))].join(' ').slice(0, 1200) || shot.title;
    let query = fallback;
    if (planQuery) query = (await planQuery(shot, fallback).catch(() => fallback)) || fallback;
    try {
      const result = await semanticIndex.search(project, {
        query: { type: 'text', text: query },
        mode: 'chunk',
        topK,
        libraryIds: [project.id],
      });
      const hits = /** @type {any[]} */ (Array.isArray(result?.hits) ? result.hits : []);
      const seen = new Set();
      const candidates = hits.filter((hit) => {
        const key = `${hit.assetId}:${hit.startMs}:${hit.endMs}`;
        if (!hit.path || seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, MAX_CANDIDATES).map((/** @type {any} */ hit, /** @type {number} */ index) => normalizeCandidate({
        id: `candidate_${shot.id}_${index + 1}`,
        libraryId: hit.libraryId,
        libraryName: hit.libraryName,
        assetId: hit.assetId || hit.path,
        path: hit.path,
        name: hit.name,
        kind: hit.kind,
        startMs: hit.startMs,
        endMs: hit.endMs,
        score: hit.score,
        thumbUrl: hit.thumbUrl,
        modelId: hit.modelId,
        origin: 'library',
      }, index)).filter(Boolean);
      const selected = candidates.find((candidate) => candidate && !usedPaths.has(candidate.path)) ?? candidates[0] ?? null;
      if (selected?.path) usedPaths.add(selected.path);
      shot.match = {
        state: selected ? (selected.score < REVIEW_SCORE ? 'review' : 'matched') : 'gap',
        candidates: /** @type {StoryboardCandidate[]} */ (candidates),
        selectedId: selected?.id ?? null,
        confidence: selected ? Math.round(within(selected.score) * 100) : 0,
        query,
      };
    } catch (error) {
      shot.match = {
        state: 'gap',
        candidates: [],
        selectedId: null,
        confidence: 0,
        query,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  doc.updatedAt = now();
  return doc;
}

/** The adopted clips in story order, plus the shots that have no clip. */
export function handoffClips(/** @type {Storyboard} */ doc) {
  /** @type {HandoffClip[]} */
  const clips = [];
  const gaps = [];
  for (const shot of doc.shots) {
    const candidate = shot.match.candidates.find((item) => item.id === shot.match.selectedId) ?? null;
    if (!candidate || !candidate.path) {
      gaps.push(shot.id);
      continue;
    }
    /* The rough cut uses the shot's target length from the matched source, not the whole source
       clip. Importing the candidate's full end (often the entire camera file) was what made a
       30-second storyboard become minutes of "all the material" on the timeline. */
    const startMs = Math.max(0, candidate.startMs);
    const endMs = Math.min(candidate.endMs, startMs + Math.max(500, shot.targetMs));
    clips.push({
      shotId: shot.id,
      path: candidate.path,
      name: candidate.name,
      startMs,
      endMs,
      durationMs: Math.max(0, endMs - startMs),
    });
  }
  return { clips, gaps };
}

/** A deterministic first draft for the conversation when no model is configured. */
export function localProposal(/** @type {Storyboard} */ doc, /** @type {string} */ instruction) {
  const text = instruction.trim();
  const duration = /(?:压到|压缩到|缩短到|目标|总时长)\s*(\d+(?:\.\d+)?)\s*(?:秒|s)/i.exec(text);
  if (duration) {
    const seconds = Number(duration[1]);
    if (Number.isFinite(seconds) && seconds >= 1) {
      return {
        reply: `把目标时长改为 ${seconds.toFixed(1)} 秒，并重新分配到 ${doc.shots.length} 个镜头。`,
        operations: [{ type: 'setTargetDuration', durationMs: Math.round(seconds * 1000) }],
      };
    }
  }
  const remove = /(?:删除|去掉|移除)\s*第?\s*(\d+)\s*(?:镜|个镜头)/i.exec(text);
  if (remove) {
    const index = Number(remove[1]) - 1;
    const shot = doc.shots[index];
    if (shot) return { reply: `删除第 ${index + 1} 镜“${shot.title}”。`, operations: [{ type: 'deleteShot', shotId: shot.id }] };
  }
  const retime = /第?\s*(\d+)\s*(?:镜|个镜头)\s*(加长|延长|缩短)\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?/i.exec(text);
  if (retime) {
    const shot = doc.shots[Number(retime[1]) - 1];
    if (shot) {
      const sign = retime[2] === '缩短' ? -1 : 1;
      const targetMs = Math.max(500, shot.targetMs + sign * Number(retime[3]) * 1000);
      return { reply: `把第 ${shot.order + 1} 镜调整为 ${(targetMs / 1000).toFixed(1)} 秒。`, operations: [{ type: 'setShotDuration', shotId: shot.id, targetMs }] };
    }
  }
  const opening = /(?:保持|保留)\s*开头\s*(\d+(?:\.\d+)?)\s*(?:秒|s)/i.exec(text);
  if (opening && doc.shots[0]) {
    const targetMs = Math.round(Number(opening[1]) * 1000);
    return { reply: `把开场镜头保持在 ${(targetMs / 1000).toFixed(1)} 秒。`, operations: [{ type: 'setShotDuration', shotId: doc.shots[0].id, targetMs }] };
  }
  const keep = /(?:保持|保留)\s*开头\s*([一二三四五六七八九十两\d]+)\s*(?:镜|个镜头)?/i.exec(text);
  if (keep) {
    const count = Number(keep[1]) || ({ 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[keep[1]] ?? 0);
    const shots = doc.shots.slice(0, Math.max(1, count)).filter((shot) => !shot.locked);
    return shots.length
      ? { reply: `锁定开头 ${shots.length} 个镜头，后续修改不会再动它们。`, operations: [{ type: 'lockShots', shotIds: shots.map((shot) => shot.id) }] }
      : { reply: '开头镜头已经锁定，不需要再改。', operations: [] };
  }
  if (/(重复|雷同|相似)/.test(text) && /(减少|去重|合并|删)/.test(text)) {
    const seen = new Set();
    const removeOps = doc.shots.filter((shot) => {
      const key = `${shot.title}|${shot.narration}`.replace(/\s+/g, '').toLowerCase();
      if (!key || !seen.has(key)) { seen.add(key); return false; }
      return !shot.locked;
    }).map((shot) => ({ type: 'deleteShot', shotId: shot.id }));
    return removeOps.length
      ? { reply: `按标题和旁白去重，删掉 ${removeOps.length} 个重复镜头。`, operations: removeOps }
      : { reply: '没有发现可安全删除的重复镜头；锁定镜头保持不动。', operations: [] };
  }
  if (/(时长|长短|节奏|分配|自行决定|你决定)/.test(text)) {
    return {
      reply: `按内容主次重新分配 ${doc.shots.length} 个镜头的长度，总时长保持 ${(doc.brief.durationMs / 1000).toFixed(1)} 秒。`,
      operations: [{ type: 'distributeDurations', durationMs: doc.brief.durationMs }],
    };
  }
  if (/匹配|找素材|补齐/.test(text)) {
    return { reply: '这一步需要先选中镜头，再点击“精确匹配”；候选会留在素材架里让你选择。', operations: [], intent: 'match' };
  }
  return {
    reply: '我可以直接改时长、调整各镜长短、删除重复镜头或修改镜头内容。直接说“按内容分配时长”或“减少重复镜头”即可。',
    operations: [],
  };
}
