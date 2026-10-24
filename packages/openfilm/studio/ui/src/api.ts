/**
 * Studio's API, as the editor calls it (studio/server/server.mjs). Same origin, so the launch key travels as the
 * cookie `/open` set; writes are refused from any other origin.
 */
import type { ExportJob } from '@/lib/export-jobs';
import { studioHost } from '@/lib/host';
import { watchStudioVersion } from '@/lib/studio-version';

/** `working`: an agent of the app's chat is working in it right now (it cannot be deleted meanwhile). */
/** GET /api/version: this Studio's, and npm's latest (null when never learnt; `checking` false: never asked). */
export interface StudioVersion { version: string; latest: string | null; newer: boolean; checkedAt: number | null; checking: boolean; source: boolean;
  /** the update Studio runs from the top bar (lib/web-update), or one that failed */
  update?: { status: 'updating' | 'failed'; version: string; error?: string } }

/** `cover`: when the person set a cover of its own (studio/server/cover.mjs), absent when it has none. */
export type Project = { id: string; path: string; name: string; openedAt: number; missing: boolean; working?: boolean; cover?: number };
export type Clip = { src: string; id: string; at?: number; time?: [number] | [number, number];
  box?: { x: number; y: number; w?: number; h?: number; r?: number }; volume?: number; speed?: number; overrides?: unknown[];
  /** a page that sets no size of its own: the px it is laid out at (the stage's without it) */
  size?: { w: number; h: number };
  /** a video's sound alone (an <audio> of its file) */
  sound?: true;
  /** its look: class names for the film's styles, and its own CSS */
  class?: string; style?: string; attrs?: Record<string, string> };
export type Track = { clips: Clip[]; locked?: boolean; hidden?: boolean; muted?: boolean; attrs?: Record<string, string> };
export type Film = { stage?: { w: number; h: number }; tracks: Track[] };
/** `value`: film.html as read, every clip named (a clip with no id takes its file's name, as the server and preview do). */
export type ProjectFilm = { project: Project; folder: string; text: string; rev: string; value: Film | null; doc: Film | null; problems: string[] };
export type MediaFile = { path: string; kind: 'video' | 'image' | 'audio' | 'page' | 'other'; size: number; mtime: number; added?: number; desc?: string };
/** A project's editor settings (studio/server/project-settings.mjs). */
export type ProjectSettings = { fps?: number; trackNames?: { name: string; index: number; clips: string[] }[]; trackHeights?: { height: number; index: number; clips: string[] }[] };
export type Listing = { files: MediaFile[]; folders: string[]; pages: { path: string; size: number; mtime: number; desc?: string }[] };
export type Op =
  | { op: 'set'; clip: string; field: string; value?: unknown }
  | { op: 'move'; clip: string; at: number; track?: number; newTrack?: number }
  | { op: 'insert'; clip?: Partial<Clip> & { src: string }; from?: string; at?: number; after?: string; track?: number | { insert: number }; newTrack?: number; link?: string | null }
  | { op: 'remove'; clip: string }
  | { op: 'split'; clip: string; at: number; time: [number, number]; restTime: [number, number] }
  | { op: 'split'; clip: string; left: Record<string, PropValue>; right: Record<string, PropValue>; rightId?: string }
  | { op: 'track'; track: number; field: 'locked' | 'hidden' | 'muted'; value: boolean }
  | { op: 'reorder'; from: number; to: number }
  | { op: 'props'; edits: PropEdit[] }
  | { op: 'stage'; w: number; h: number }
  | { op: 'fields'; clip: string; fields: Record<string, unknown> };

/** A value a clip's property takes (null removes it). */
export type PropValue = number | string | boolean | readonly number[] | Record<string, unknown> | null;
/** One property of one clip, by the clip's id (see studio/server/ops.mjs). */
export type PropEdit = { clip: string; prop: string; value: PropValue };

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) {
    super(message);
  }
}

/** Writes on their way (edits, renames…): a reload for a new Studio waits for them (studioVersion). */
let writing = 0;

async function call<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const write = (rest.method ?? 'GET') !== 'GET';
  if (write) writing += 1;
  try {
    const res = await fetch(`/api/${path}`, {
      ...rest,
      headers: json === undefined ? rest.headers : { 'content-type': 'application/json', ...rest.headers },
      body: json === undefined ? rest.body : JSON.stringify(json),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 401) markLocked();
    if (!res.ok) throw new ApiError(String(body.error ?? `Studio answered ${res.status}`), res.status, body);
    return body as T;
  } finally {
    if (write) writing -= 1;
  }
}

const p = (id: string) => `projects/${encodeURIComponent(id)}`;

/** Studio's own preferences, the same for every project (studio/server/prefs.mjs). */
export interface StudioPrefs {
  proxies: { on: boolean; height: 540 | 720 | 1080 };
  seenVersion: string | null;
  projectsFolder: string | null;
  /** the keyboard shortcuts: the scheme in use and the custom ones (lib/keymap `KeyPrefs`, checked there) */
  keys?: unknown;
  /** the rough cut's search: how many candidate materials its shelf asks for and shows */
  storyboard?: { candidateCount: number };
}
/** Where the projects library is (src/locations.mjs): the folder, its default, whether the person chose it, the free space on its disk, how many projects are in it. */
export interface StudioLocation { path: string; default: string; chosen: boolean; free: number | null; count: number }
export interface StudioLocations { projects: StudioLocation }

/** A local model package the semantic index sidecar found (semantic-index.mjs / VideoSeek). */
export interface SemanticModel {
  id: string;
  name: string;
  provider: string;
  variant: string;
  dimension: number;
  imageSize: number;
  languages: string[];
  license?: string;
  path?: string;
}
export interface SemanticStore {
  id: string;
  modelId: string;
  name?: string;
  provider?: string;
  dimension?: number;
  state: 'idle' | 'queued' | 'indexing' | 'ready' | 'partial' | 'error';
  frames: number;
  chunks: number;
  options?: Record<string, unknown>;
}
export interface SemanticLibrary {
  id: string;
  name: string;
  kind: 'project' | 'external';
  mediaRoot: string;
  indexRoot: string;
  offline?: boolean;
  error?: string;
  assets: { total: number; ready: number; stale: number; missing?: number; error: number; notIndexed: number; unsupported: number; excluded: number };
  assetStates?: Record<string, string>;
  stores: SemanticStore[];
  storeIds?: string[];
  job: null | { id: string; store_id: string; state: string; progress: number; message?: string | null; error?: string | null; total: number; done: number };
}
export interface SemanticSidecar {
  state: 'off' | 'starting' | 'ready' | 'error';
  reason?: string;
  port?: number;
  python?: string;
  modelsRoot?: string;
  videoSeekRoot?: string;
  models?: number;
  device?: string;
  version?: string;
  ok?: boolean;
  videoSeek?: boolean;
  chineseClip?: boolean;
  frameExtraction?: boolean;
  chunking?: boolean;
}
export interface SemanticStatus {
  sidecar: SemanticSidecar;
  project: SemanticLibrary | null;
  global?: SemanticLibrary;
  libraries: SemanticLibrary[];
  models: SemanticModel[];
  root?: string;
}
export interface SemanticHit {
  libraryId: string;
  libraryName: string;
  storeId: string;
  modelId: string;
  providerId?: string;
  contentKey: string;
  assetId: string;
  path: string;
  name: string;
  kind: string;
  size: number;
  dir: string;
  startMs: number;
  endMs: number;
  anchorMs: number;
  score: number;
  rankScore?: number;
  engine: 'visual';
  thumbUrl: string;
  degraded?: string;
}
export interface SemanticSearchResponse {
  hits: SemanticHit[];
  meta: { returned: number; elapsedMs: number; mode: 'frame' | 'chunk'; storeIds: string[]; modelIds: string[]; indexState: string; degraded?: string };
}

/* ── storyboard: a project's draft, its candidates, and the review/apply boundary (server/storyboard.mjs) ── */
export interface StoryboardCandidate {
  id: string;
  libraryId: string;
  libraryName: string;
  assetId: string;
  path: string;
  name: string;
  kind: string;
  startMs: number;
  endMs: number;
  score: number;
  thumbUrl: string;
  modelId?: string;
  origin: 'library' | 'generated';
  review?: { verdict: 'pass' | 'uncertain' | 'fail'; confidence: number; reason: string };
}
export interface StoryboardMatch {
  state: 'draft' | 'matched' | 'review' | 'gap';
  candidates: StoryboardCandidate[];
  selectedId: string | null;
  confidence: number;
  query?: string;
  stale?: boolean;
  error?: string;
}
export interface StoryboardShot {
  id: string;
  sceneId: string;
  order: number;
  title: string;
  narration: string;
  visualIntent: string;
  must: string[];
  avoid: string[];
  targetMs: number;
  locked: boolean;
  generated: boolean;
  match: StoryboardMatch;
}
export interface StoryboardScene { id: string; title: string; order: number }
export interface StoryboardBrief { durationMs: number; aspect: string; tone: string; notes: string }
export interface StoryboardDocument {
  version: 1;
  revision: number;
  id: string;
  title: string;
  brief: StoryboardBrief;
  scenes: StoryboardScene[];
  shots: StoryboardShot[];
  source: 'manual' | 'local' | 'ai';
  createdAt: number;
  updatedAt: number;
  handedOffAt: number | null;
  roughcut: null | { createdAt: number; durationMs: number; clips: HandoffClip[]; gaps: string[] };
}
export interface HandoffClip { shotId: string; path: string; name: string; startMs: number; endMs: number; durationMs: number }
export interface StoryboardProposal {
  id: string;
  baseRevision: number;
  source: 'local' | 'ai';
}
export interface StoryboardChatResponse {
  reply: string;
  operations: Array<Record<string, unknown>>;
  proposal: StoryboardProposal;
  intent?: string;
}
export interface ModelLogEntry {
  id: number;
  at: number;
  role: string;
  agent: string;
  provider: string;
  model: string;
  protocol: string;
  status: 'running' | 'ok' | 'error';
  ms: number;
  request: { system: string; messages: { role: string; content: string }[] };
  reply: string;
  usage: { input?: number; output?: number; total?: number } | null;
  error: string;
}
export interface PipelineStep {
  id: string; label: string; state: 'idle' | 'running' | 'done' | 'skipped' | 'error'; detail?: string; startedAt?: number; finishedAt?: number;
}
export interface PipelineRun {
  id: string; state: 'idle' | 'running' | 'done' | 'error' | 'cancelled'; step: string; steps: PipelineStep[];
  startedAt: number | null; updatedAt: number; finishedAt: number | null; error: string; cancelRequested: boolean;
  storyboardRevision: number | null; applied: string[]; issues: string[];
}

/* The model services behind Settings → Agents. A key is never returned to the page. */


/* The unified provider cards and agent cards (studio/server/provider-cards.mjs, agent-cards.mjs). */
export type ProviderCategory = 'llm' | 'vl' | 'embedding' | 'rerank' | 'asr' | 'tts' | 'image' | 'video' | 'image-search' | 'web-search' | 'web-fetch' | 'music' | 'sfx';
export type ProviderScope = 'cloud' | 'local';
export interface ProviderCategoryInfo { id: ProviderCategory; label: string; cloud: boolean; local: boolean }
export interface ProviderModel { id: string; name: string; remoteName?: string; dimension?: number; vision?: boolean; context?: number; maxOutput?: number }
export interface ProviderConnectionView {
  id: string; vendorId: string; name: string; scope: ProviderScope; baseUrl: string;
  auth: 'bearer' | 'api-key' | 'none'; authHeader?: string; keyEnv?: string; headers?: Record<string, string>;
  hasKey?: boolean; last4?: string; key?: string;
}
export interface ProviderCardView {
  id: string; catalogId?: string; vendorId: string; name: string; category: ProviderCategory;
  scope: ProviderScope; protocol: string; connectionId: string;
  connectionOverride?: Partial<ProviderConnectionView>; models: ProviderModel[]; defaultModelId: string;
  options?: Record<string, unknown>; enabled: boolean; order: number;
  builtin?: { providerId: string; verb: string }; docsUrl?: string;
}
export interface ProviderStateView { revision: number; connections: ProviderConnectionView[]; cards: ProviderCardView[]; defaults: Record<string, string> }
export interface ProviderCatalogEntry {
  id: string; vendorId: string; vendorName: string; name: string; category: ProviderCategory;
  scope: ProviderScope; baseUrl: string; protocol: string; models: ProviderModel[]; defaultModelId: string;
  docsUrl: string; auth: 'bearer' | 'api-key' | 'none'; builtin?: { providerId: string; verb: string };
}
export interface ProviderCardsResponse { state: ProviderStateView; catalog: ProviderCatalogEntry[]; categories: ProviderCategoryInfo[] }
export interface ProviderTestResult { ok: boolean; elapsedMs: number; detail: string }
export interface AgentRoleInfo { id: 'storyboard' | 'director' | 'query' | 'verify' | 'continuity'; label: string; hint: string }
export interface AgentCard {
  id: string; name: string; role: AgentRoleInfo['id'] | ''; description: string; enabled: boolean; order: number;
  cardId: string; modelId: string; systemPrompt: string; temperature: number; maxTokens: number; topP: number; tools: string[];
  skills: string[];
}
export interface AgentCardsResponse { state: { revision: number; agents: AgentCard[] }; roles: AgentRoleInfo[]; prompts?: Record<string, string> }
/** Said on the window when they change, for what plays by them (the preview's proxies). */
export const PREFS_EVENT = 'openfilm:prefs';
/** Said on the window when the library moved, for the Projects list. */
export const LIBRARY_EVENT = 'openfilm:library';

/** A problem as Studio keeps it (src/problems.mjs): when, what it was about, what it said. */
export interface StudioProblem {
  t: string;
  area: string;
  what: string;
  agent?: string;
  step?: string;
}

export const api = {
  /** this Studio's version and the latest openfilm on npm; `check`: ask npm now */
  version: (check = false) => call<StudioVersion>(`version${check ? '?check=1' : ''}`),
  /** the newest openfilm, run in the background (`openfilm update`): Studio starts again on it; refused (ApiError, `body.code`) while busy */
  update: () => call<{ update: NonNullable<StudioVersion['update']> }>('update', { method: 'POST', json: {} }),
  /** `openfilm doctor`, run by this Studio: the report to paste into an issue (src/doctor.mjs) */
  doctor: () => call<{ ok: boolean; text: string }>('doctor'),
  /** what went wrong in the last two weeks, newest first (src/problems.mjs) */
  problems: () => call<{ problems: StudioProblem[] }>('diagnostics/problems').then((r) => r.problems),
  /** the diagnostic file (server/diagnostics.mjs): `report` and the rest, zipped into the exports folder and shown there */
  exportDiagnostics: (report: string, conversations: boolean) => call<{ path: string; files: string[]; conversations: boolean }>('diagnostics/export', { method: 'POST', json: { report, conversations } }),
  projects: () => call<{ projects: Project[] }>('projects').then((r) => r.projects),
  prefs: () => call<StudioPrefs>('prefs'),
  /** where new projects and exports go, and the free space there */
  locations: () => call<StudioLocations>('locations'),
  /** move the library to `path` (null: the default); with `move`, its projects go too (those that could not are in `failed`) */
  moveLibrary: (path: string | null, move: boolean) => call<{ moved: number; failed: { name: string; error: string }[]; locations: StudioLocations }>('locations/projects', { method: 'PUT', json: { path, move } }).then((done) => {
    window.dispatchEvent(new Event(LIBRARY_EVENT));
    return done;
  }),
  /** a project's folder, shown in the system's file manager */
  revealProject: (id: string) => call<object>(`projects/${encodeURIComponent(id)}/reveal`, { method: 'POST', json: {} }),
  /** one of them in the system's file manager */
  openLocation: (which: keyof StudioLocations) => call<{ ok: true }>(`locations/${which}`, { method: 'POST', json: {} }),
  setPrefs: (patch: { proxies?: Partial<StudioPrefs['proxies']>; seenVersion?: string; projectsFolder?: string | null; keys?: unknown; storyboard?: Partial<NonNullable<StudioPrefs['storyboard']>> }) => call<StudioPrefs>('prefs', { method: 'PATCH', json: patch }).then((prefs) => {
    window.dispatchEvent(new Event(PREFS_EVENT));
    return prefs;
  }),
  /** the system's folder dialog, opened by Studio (a page in a browser cannot learn a path): the folder, or null when
      cancelled; throws (501) where this system has none */
  pickFolder: (title: string, at?: string) => call<{ path: string | null }>('pick-folder', { method: 'POST', json: { title, ...(at ? { at } : {}) } }).then((r) => r.path),
  newProject: (name?: string) => call<{ project: Project }>('projects', { method: 'POST', json: { name } }).then((r) => r.project),
  /** open a folder (its full path) as a project: made one when it is not yet */
  openFolder: (path: string) => call<{ project: Project }>('projects', { method: 'POST', json: { path } }).then((r) => r.project),
  rename: (id: string, name: string) => call<{ project: Project }>(p(id), { method: 'PATCH', json: { name } }).then((r) => {
    studioHost?.projectChanged?.(r.project);
    return r.project;
  }),
  forget: (id: string) => call<object>(p(id), { method: 'DELETE' }),
  film: (id: string) => call<ProjectFilm>(p(id)),
  /** the person opened it here: the one `openfilm open` alone comes back to */
  opened: (id: string) => call<{ project: Project }>(`${p(id)}/opened`, { method: 'POST' }),
  edit: (id: string, base: string | null, ops: Op[]) => call<{ text: string; rev: string; value: Film; doc: Film; rebased: boolean }>(`${p(id)}/edit`, { method: 'POST', json: { base, ops } }),
  files: (id: string) => call<Listing>(`${p(id)}/files`),
  /** the editing stage's assistant conversation (advice only; edits stay in Studio's undoable tools) */
  editChat: (id: string, text: string) => call<{ reply: string }>(`${p(id)}/edit/chat`, { method: 'POST', json: { text } }).then((r) => r.reply),
  assetDescriptions: (id: string) => call<{ descriptions: Record<string, string> }>(`${p(id)}/asset-descriptions`).then((r) => r.descriptions),
  describeAsset: (id: string, path: string, regenerate = false) => call<{ desc: string }>(`${p(id)}/asset-descriptions`, { method: 'POST', json: { path, regenerate } }).then((r) => r.desc),
  /** the editor's settings of the project (`.film/settings.json`): its frame rate, its tracks' names */
  settings: (id: string) => call<{ settings: ProjectSettings }>(`${p(id)}/settings`).then((r) => r.settings),
  /** change some of them (null takes one away); answers them all as kept */
  patchSettings: (id: string, patch: { fps?: number | null; trackNames?: ProjectSettings['trackNames'] | null; trackHeights?: ProjectSettings['trackHeights'] | null }) => (
    call<{ settings: ProjectSettings }>(`${p(id)}/settings`, { method: 'PATCH', json: patch }).then((r) => r.settings)
  ),
  /** its markers (`.film/markers.json`, lib/markers): the whole list, read and written */
  markers: (id: string) => call<{ markers: unknown }>(`${p(id)}/markers`).then((r) => r.markers),
  putMarkers: (id: string, markers: unknown[]) => call<{ markers: unknown }>(`${p(id)}/markers`, { method: 'PUT', json: { markers } }).then((r) => r.markers),
  /** the loudness of a part of a file's sound (its own seconds): integrated LUFS (null: silent) and true peak */
  loudness: (id: string, path: string, from: number, to: number) => call<{ lufs: number | null; peak: number | null }>(
    `${p(id)}/media?what=loudness&path=${encodeURIComponent(path)}&from=${from}&to=${to}`,
  ),
  /** a video's frame (`ms` of its own time) made a still beside it; answers its path */
  freezeFrame: (id: string, path: string, ms: number) => call<{ path: string }>(`${p(id)}/files/still`, { method: 'POST', json: { path, ms } }).then((r) => r.path),
  /** The project's own cover for its card (studio/server/cover.mjs): a picture from this computer, a picture of the project,
      the film at `ms`, or none (null: its film's poster again). Each answers when it was set. */
  setCover: (id: string, from: { file: Blob } | { path: string } | { ms: number }) => call<{ cover: number | null }>(`${p(id)}/cover`,
    'file' in from ? { method: 'PUT', body: from.file, headers: { 'content-type': 'application/octet-stream' } } : { method: 'POST', json: from }).then((r) => r.cover),
  clearCover: (id: string) => call<{ cover: null }>(`${p(id)}/cover`, { method: 'DELETE' }).then(() => null),
  answerAsk: (askId: string, allow: boolean) => call<{ answered: boolean }>(`get/asks/${encodeURIComponent(askId)}`, { method: 'POST', json: { allow } }),
  /** the provider's own page for its balance, opened in the person's browser */
  openBilling: (providerId: string) => call<Record<string, never>>(`providers/${encodeURIComponent(providerId)}/billing`, { method: 'POST' }),
  /** clips (by id), clips together (a group) and files (by path) of a project put in Saved (studio/server/saved.mjs):
      each one's place there */
  save: (id: string, what: { clips?: SavedAsk[]; groups?: Array<SavedAsk & { ids: string[] }>; files?: Array<SavedAsk & { path: string }>; into?: string }) => (
    call<{ paths: string[] }>(`${p(id)}/saved`, { method: 'POST', json: what }).then((r) => r.paths)
  ),
  /** a thing of Saved (its `saved/` path) used in the project: a file imported (its place), or a bundle's files brought in
      and the clip, a group's clips or the page to put on the timeline */
  takeSaved: (id: string, path: string) => call<{ clip: Record<string, unknown> & { src: string } } | { clips: SavedGroupClip[] } | { path: string }>(
    `${p(id)}/saved/take`, { method: 'POST', json: { path } },
  ),
  /** the project's semantic index: its status, and its sidecar's models */
  semanticStatus: (id?: string | null) => call<SemanticStatus>(id ? `${p(id)}/index` : 'index'),
  /** Move the one global vector library to a folder (contents move too). */
  semanticSetRoot: (id: string | null, path: string) => call<SemanticStatus>(id ? `${p(id)}/index/root` : 'index/root', { method: 'PUT', json: { path } }),
  /** Which global stores this project references. */
  semanticSetStores: (id: string, stores: readonly string[]) => call<SemanticStatus>(`${p(id)}/index/stores`, { method: 'PUT', json: { stores } }),
  /** Stop and start the index sidecar, letting go of catalogs it holds. */
  semanticRestart: () => call<{ health: SemanticSidecar }>('index/restart', { method: 'POST', json: {} }).then((r) => r.health),
  /** Delete one vector store (its vectors) from a project or external library. */
  semanticDeleteStore: (libraryId: string, storeId: string) => call<object>(`index/libraries/${encodeURIComponent(libraryId)}/index?storeId=${encodeURIComponent(storeId)}`, { method: 'DELETE' }),
  semanticStart: (id: string, body: { modelId?: string; mode?: string; assetIds?: string[]; folders?: string[] }) => call<{ job: unknown; storeId: string }>(`${p(id)}/index/jobs`, { method: 'POST', json: body }),
  semanticStartExternal: (libraryId: string, body: { modelId?: string; mode?: string; assetIds?: string[]; folders?: string[] }) => call<{ job: unknown; storeId: string }>('index/jobs', { method: 'POST', json: { ...body, libraryId } }),
  semanticSearch: (id: string, body: { query: { type: 'text'; text: string } | { type: 'image'; dataUrl: string }; mode?: 'frame' | 'chunk'; topK?: number; libraryIds?: string[]; filters?: Record<string, unknown> }) => call<SemanticSearchResponse>(`${p(id)}/index/search`, { method: 'POST', json: body }),
  semanticJob: (libraryId: string, jobId: string) => call<{ job: Record<string, unknown>; items: unknown[] }>(`index/jobs/${encodeURIComponent(jobId)}?libraryId=${encodeURIComponent(libraryId)}`),
  semanticCancel: (libraryId: string, jobId: string) => call<object>(`index/jobs/${encodeURIComponent(jobId)}/cancel?libraryId=${encodeURIComponent(libraryId)}`, { method: 'POST', json: {} }),
  semanticDelete: (id: string) => call<object>(`${p(id)}/index`, { method: 'DELETE' }),
  semanticModels: () => call<{ models: SemanticModel[]; health: SemanticSidecar }>('index/models'),
  semanticImportModel: async (file: File) => {
    const res = await fetch(`/api/index/models?filename=${encodeURIComponent(file.name)}`, { method: 'PUT', body: file });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(String(body.error ?? `Studio answered ${res.status}`), res.status, body);
    return body as { model: string; path: string };
  },
  semanticLibraries: () => call<{ libraries: { id: string; name: string; path: string; indexRoot: string }[]; health: SemanticSidecar }>('index/libraries'),
  semanticAddLibrary: (body: { name?: string; path: string; indexRoot?: string }) => call<{ library: { id: string; name: string; path: string; indexRoot: string } }>('index/libraries', { method: 'POST', json: body }).then((r) => r.library),
  semanticRemoveLibrary: (id: string) => call<object>(`index/libraries/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** the storyboard draft, its matches and its handoff (server/storyboard.mjs) */
  storyboard: (id: string) => call<{ storyboard: StoryboardDocument }>(`${p(id)}/storyboard`).then((r) => r.storyboard),
  saveStoryboard: (id: string, storyboard: StoryboardDocument, baseRevision = storyboard.revision) => call<{ storyboard: StoryboardDocument }>(`${p(id)}/storyboard`, { method: 'PUT', json: { storyboard, baseRevision } }).then((r) => r.storyboard),
  generateStoryboard: (id: string, body: { text?: string; prompt?: string; brief?: Partial<StoryboardBrief> }) => call<{ storyboard: StoryboardDocument; source: 'local' | 'ai' }>(`${p(id)}/storyboard/generate`, { method: 'POST', json: body }),
  matchStoryboard: (id: string, body: { shotIds?: string[]; topK?: number } = {}) => call<{ storyboard: StoryboardDocument }>(`${p(id)}/storyboard/match`, { method: 'POST', json: body }).then((r) => r.storyboard),
  fillStoryboard: (id: string, body: { shotId: string; prompt?: string; duration?: number }) => call<{ storyboard: StoryboardDocument; path: string }>(`${p(id)}/storyboard/fill`, { method: 'POST', json: body }),
  chatStoryboard: (id: string, body: { text: string; selectedIds?: string[] }) => call<StoryboardChatResponse>(`${p(id)}/storyboard/chat`, { method: 'POST', json: body }),
  applyStoryboard: (id: string, body: { baseRevision: number; operations: Array<Record<string, unknown>> }) => call<{ storyboard: StoryboardDocument }>(`${p(id)}/storyboard/apply`, { method: 'POST', json: body }).then((r) => r.storyboard),
  handoffStoryboard: (id: string) => call<{ storyboard: StoryboardDocument; clips: HandoffClip[]; gaps: string[] }>(`${p(id)}/storyboard/handoff`, { method: 'POST', json: {} }),
  /** the developer's floating model-call log */
  modelLogs: (limit = 200) => call<{ entries: ModelLogEntry[] }>(`model-logs?limit=${limit}`).then((r) => r.entries),
  clearModelLogs: () => call<object>('model-logs', { method: 'DELETE' }),
  storyboardRun: (id: string) => call<{ run: PipelineRun }>(`${p(id)}/storyboard/run`).then((r) => r.run),
  startStoryboardRun: (id: string, body: { text?: string; prompt?: string; brief?: Partial<StoryboardBrief> }) => call<{ run: PipelineRun }>(`${p(id)}/storyboard/run`, { method: 'POST', json: body }).then((r) => r.run),
  cancelStoryboardRun: (id: string) => call<{ run: PipelineRun }>(`${p(id)}/storyboard/run/cancel`, { method: 'POST', json: {} }).then((r) => r.run),
  undoStoryboardRun: (id: string) => call<{ storyboard: StoryboardDocument }>(`${p(id)}/storyboard/run/undo`, { method: 'POST', json: {} }).then((r) => r.storyboard),
  /** providers → models → agents for the film's own storyboard/director agents */
  /** the unified provider cards: card catalog, redacted state, save/order/defaults, connection test */
  providerCards: () => call<ProviderCardsResponse>('provider-cards'),
  saveProviderCards: (state: ProviderStateView) => call<ProviderStateView>('provider-cards', { method: 'PUT', json: state }),
  testProviderCard: (body: Record<string, unknown>) => call<ProviderTestResult>('provider-cards/test', { method: 'POST', json: body }),
  /** editable agent cards: work slot, prompt, model binding and sampling */
  agentCards: () => call<AgentCardsResponse>('agent-cards'),
  saveAgentCards: (state: AgentCardsResponse['state']) => call<{ state: AgentCardsResponse['state']; roles: AgentRoleInfo[] }>('agent-cards', { method: 'PUT', json: state }),
};

/** A clip of a saved group: its track counted from the group's top one, its time in seconds from the group's start. */
export type SavedGroupClip = { track: number; at: number; clip: Record<string, unknown> & { src: string } };

/** What is said of a thing put in Saved: a clip's id (a file's path beside it), a name, and how long and big it is. */
export type SavedAsk = { id?: string; name?: string; durationMs?: number; w?: number; h?: number };

/** What an agent's `openfilm get` asks the person before it spends (studio/server/get.mjs). */
export type SpendAsk = {
  id: string; kind: 'video'; provider: string; model?: string; seconds?: number; prompt?: string;
};

/** What the person is told without a question (studio/server/get.mjs): a provider with no balance left for a run. */
export type StudioNotice = { id: string; kind: 'balance'; provider: string; providerId: string };

export type FolderEvent = { type: 'film'; rev: string } | { type: 'files'; paths?: string[] } | { type: 'history' } | { type: 'export'; job: ExportJob } | { type: 'open'; to: string }
  | { type: 'history-progress'; op: string; phase: string; done: number; total: number }
  | { type: 'ask'; ask: SpendAsk } | { type: 'asked'; id: string } | { type: 'notice'; notice: StudioNotice } | { type: 'project'; project: Project }
  /* the project was deleted, or its folder is not there any more: its pages leave it */
  | { type: 'gone' };

/**
 * Listen to a stream of events (a WebSocket: a browser's six HTTP connections to Studio stay free for the page's
 * requests, however many pages are open); returns a function that stops listening. It reconnects on its own;
 * `onBack` runs when it does (Studio stopped and started again: what changed meanwhile was not told). `watch`: this
 * stream says whether Studio answers (studioConnection), and reloads the page when Studio comes back as another
 * version (lib/studio-version); the page's own one does. It also tells Studio whether the page is in sight, so
 * `openfilm open` opens a browser when no page is (a tab behind others, a minimized window).
 */
export function listen(path: string, on: (event: FolderEvent) => void, { onBack, watch = false, gone }: { onBack?: () => void; watch?: boolean; gone?: () => Promise<boolean> } = {}): () => void {
  const inSight = () => document.visibilityState === 'visible';
  const url = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/${path}${watch ? `?visible=${inSight() ? 1 : 0}` : ''}`;
  const tell = () => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ visible: inSight() })); };
  if (watch) document.addEventListener('visibilitychange', tell);
  let socket: WebSocket | null = null;
  let stopped = false, lost = false, tries = 0;
  let again: ReturnType<typeof setTimeout> | null = null;
  const watcher = watch ? watchConnection() : null;
  if (watch) studioVersion ??= watchStudioVersion({
    version: () => fetch('/api/health', { cache: 'no-store' }).then((r) => r.json()).then((h) => (typeof h?.version === 'string' ? h.version : null)),
    idle: () => writing === 0,
    reload: () => location.reload(),
    storage: (() => { try { return sessionStorage; } catch { return null; } })(),
  });
  const connect = () => {
    const s = new WebSocket(url());
    socket = s;
    s.onopen = () => {
      tries = 0;
      watcher?.up();
      if (lost) {
        lost = false;
        onBack?.();
        /* back as another version (a newer openfilm, or the desktop app's): this page's code is reloaded to match */
        if (watch) void studioVersion?.back();
      }
    };
    s.onmessage = (e) => { try { on(JSON.parse(String(e.data)) as FolderEvent); } catch { /* not ours */ } };
    s.onclose = () => {
      if (stopped) return;
      lost = true;
      watcher?.down();
      /* refused, not gone: Studio is there but this browser has no key (the stream says no reason, a request does) */
      if (watch && tries === 0) void fetch('/api/version', { cache: 'no-store' }).then((r) => { if (r.status === 401) markLocked(); }, () => {});
      /* soon at first, then every second: Studio restarting (`openfilm open` starts it afresh) is back within one
         or two, and waits a few for the pages before it */
      again = setTimeout(connect, Math.min(1000, 250 * 2 ** tries++));
      /* refused again and again while Studio answers: what it streams may be gone (a project deleted, its folder
         moved away), which reconnecting can't change; asked, and if so said once and left */
      if (gone && (tries === 3 || tries % 20 === 0)) {
        void gone().then((yes) => {
          if (!yes || stopped) return;
          stopped = true;
          if (again) clearTimeout(again);
          on({ type: 'gone' });
        }, () => {});
      }
    };
  };
  connect();
  return () => { stopped = true; if (again) clearTimeout(again); if (watch) document.removeEventListener('visibilitychange', tell); watcher?.stop(); socket?.close(); };
}

/** Which version of Studio served this page (see listen's `watch`). */
let studioVersion: ReturnType<typeof watchStudioVersion> | null = null;

/**
 * Whether Studio answers, for the notice when it does not: 'up', 'lost' (stopped a moment ago, reconnecting), 'gone'
 * (still not back), or 'locked': Studio answers but not this browser, which was never let in (its address was typed
 * or pasted without the key `openfilm open` prints, or its key is another launch's). Waiting does not fix that one.
 */
export type Connection = 'up' | 'lost' | 'gone' | 'locked';
let connection: Connection = 'up';
const connectionListeners = new Set<() => void>();
export const studioConnection = {
  get: () => connection,
  subscribe(fn: () => void) { connectionListeners.add(fn); return () => { connectionListeners.delete(fn); }; },
};
/** Studio answered this page 401: it was never let in (see Connection). */
export function markLocked() { setConnection('locked'); }
function setConnection(next: Connection) {
  if (next === connection || (connection === 'locked' && next !== 'up')) return;
  connection = next;
  for (const fn of [...connectionListeners]) fn();
}
/** A moment without Studio is said, a long one more plainly. */
function watchConnection() {
  let timers: ReturnType<typeof setTimeout>[] = [];
  const clear = () => { for (const timer of timers) clearTimeout(timer); timers = []; };
  return {
    down() {
      if (timers.length || connection !== 'up') return;
      /* a blip (the computer woke, the stream was cut and came straight back) is not worth a notice */
      timers = [setTimeout(() => setConnection('lost'), 2000), setTimeout(() => setConnection('gone'), 20_000)];
    },
    up() { clear(); setConnection('up'); },
    stop: clear,
  };
}
/* One stream per project, shared by everyone listening on the page. */
const streams = new Map<string, { stop: () => void; listeners: Set<(event: FolderEvent) => void> }>();
export function projectEvents(id: string, on: (event: FolderEvent) => void): () => void {
  let stream = streams.get(id);
  if (!stream) {
    const listeners = new Set<(event: FolderEvent) => void>();
    const tell = (event: FolderEvent) => {
      if (listeners.size && event.type === 'project') studioHost?.projectChanged?.(event.project);
      for (const fn of [...listeners]) fn(event);
    };
    /* back after Studio was away: the film, the files and the history may all have changed meanwhile */
    const stop = listen(`${p(id)}/events`, tell, {
      onBack: () => { tell({ type: 'film', rev: '' }); tell({ type: 'files' }); tell({ type: 'history' }); },
      /* the project off the list, or its folder missing: gone (a list that can't be read says nothing) */
      gone: () => call<{ projects: Project[] }>('projects').then((r) => { const found = r.projects.find((x) => x.id === id); return !found || Boolean(found.missing); }),
    });
    stream = { stop, listeners };
    streams.set(id, stream);
  }
  stream.listeners.add(on);
  const mine = stream;
  return () => {
    mine.listeners.delete(on);
    if (!mine.listeners.size && streams.get(id) === mine) { mine.stop(); streams.delete(id); }
  };
}
