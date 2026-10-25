// @ts-check
/**
 * OpenFilm Studio's server: one process for the whole editor. Two origins, so a web page can never reach the editor:
 *
 *   http://127.0.0.1:<port>      the editor's pages and its API. The API needs the launch key: as a cookie, set by
 *                                any page's address with ?key=… (/open?key=… too), or as `x-studio-key` (the CLI).
 *                                The key stays in the pages' address, so a copied address opens Studio anywhere on
 *                                this machine (another browser, an agent's preview). Writes from a browser must come
 *                                from this origin.
 *   http://localhost:<port + 1>  the film itself: project files, read only, for the preview (see pages.mjs).
 *
 * Both answer only requests addressed to 127.0.0.1, localhost or [::1] at their own port (ownHost): another site
 * whose name is pointed at this machine (DNS rebinding) gets nothing, not even /api/health.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { pipeline } from 'node:stream';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { EditError, editProjectFilm, pageClipLook, readProjectFilm } from './film.mjs';
import { FileError, bringIn, collect, extractAudio, freezeFrame, importFile, inside, listFiles, makeFolder, moveCheck, moveFile, readable, relink, trashFile } from './files.mjs';
import { ExportError, createExports, draftApps, exportCapabilities, exportsRoot, projectSizes } from './exports.mjs';
import { MediaError, frame, loudness, poster, probe, waveform } from './derived.mjs';
import { HistoryError, checkout, commitChanges, deleteBranch, discardChanges, historyFiles, log, mergeBranch, renameBranch, restoreCommit, status as historyStatus } from './history.mjs';
import { ownHost, startPages } from './pages.mjs';
import { HttpError, cookie, json, readJson } from './http.mjs';
import { acceptWebSocket } from './websocket.mjs';
import {
  ProjectError, createFolder, createProject, deleteFolder, deleteProject, libraryRoot, listFolders, listProjects, locateProject, markOpened, moveFolder, moveLibrary,
  moveProjectToFolder, openProject, projectById, renameFolder, renameProject, studioHome, studioKey, TOOL_DIR,
} from './projects.mjs';
import { FetchError, createFetches, fetchFilm, parseRepoUrl } from './fetch-repo.mjs';
import { BrowseError, browseFolder, browsePlaces } from './browse.mjs';
import { exampleFile, exampleFolder, listExamples } from './examples.mjs';
import { pickFiles, pickFolder } from './folder-picker.mjs';
import { readPrefs, writePrefs } from './prefs.mjs';
import { ensureProxies } from './proxies.mjs';
import { ensurePreviews, knownLate } from './preview-cache.mjs';
import { npmOpenfilm, olderThanThis } from '../client.mjs';
import { writeAtomic } from './atomic.mjs';
import { createWatchers } from './watch.mjs';
import { installedFonts } from './fonts.mjs';
import { projectFonts, resolveIn } from './project-fonts.mjs';
import { FILM_PAGE, PageFrameError, closePageFrames, filmPoster, pageFacts, pageFrame, warmFilmPoster } from './pageframes.mjs';
import { COVER_FRAME_W, CoverError, clearCover, readCover, readCoverBody, setCover, setCoverFromFile } from './cover.mjs';
import { SavedError, bundlePoster, libraryPath, libraryRel, libraryRoot as savedLibrary, listLibrary, saveClip, saveFile, saveGroup, takeSaved } from './saved.mjs';
import { FILM_FILE, clipKind, isPage } from '../../src/film-doc.mjs';
import { moveToTrash } from './trash.mjs';
import { addSkills, listSkills, removeSkill, setSkillCover, setSkillInstalled, setSkillOn, skillOrigins, skillsInstalled, skillsOff } from '../../src/skills.mjs';
import { providersRoute } from './providers/index.mjs';
import { captionRoutes } from './captions.mjs';
import { projectSettingsRoute } from './project-settings.mjs';
import { markersRoute } from './markers.mjs';
import { transitionPageRoutes } from './transition-pages.mjs';
import { createAsks, getRoute, runGet, subtitleTranscriber, subtitleTranslator } from './get.mjs';
import { LOCATION_KEYS, chooseFolder, locations, usableFolder } from '../../src/locations.mjs';
import { doctor } from '../../src/doctor.mjs';
import { recentProblems } from '../../src/problems.mjs';
import { exportDiagnostics } from './diagnostics.mjs';
import { SemanticIndexService } from './semantic-index.mjs';
import { applyOperations, distributeDurations, handoffClips, localProposal, normalizeStoryboard, readStoryboard, saveStoryboard, scaleDuration } from './storyboard.mjs';
import { agentReady, callAgent, parseJsonReply, storyboardSchemaHint, testConnection } from './agent-runtime.mjs';
import { readProviderState, redactState, saveProviderState, CATALOG, CATEGORIES, cardConnection, syncLegacyRuntime } from './provider-cards.mjs';
import { readAgentState, saveAgentState, AGENT_ROLES, defaultPrompts } from './agent-cards.mjs';
import { editContext, storyboardContext } from './agent-flow.mjs';
import { conversationReact } from './agent-react.mjs';
import { fillStoryboardTool, matchStoryboardTool } from './agent-tools.mjs';
import { audioRoutes } from './audio.mjs';
import { appendAgentChat, clearAgentChat, readAgentChat } from './agent-chat.mjs';
import { handleMcpRequest } from './mcp.mjs';
import { PIPELINE_STEPS, clearUndo, emptyRun, publicRun, readRun, readUndo, writeRun } from './pipeline.mjs';
import { materialQueryPlanner, retryPlan, runPlan } from './plan-execute.mjs';
import { clearApi, listApi, recordApi } from './api-log.mjs';
import { clearModelCalls, listModelCalls } from './model-log.mjs';
import { descriptionsFor, getDescription, saveDescription } from './asset-descriptions.mjs';

/** @typedef {import('./http.mjs').Req} Req @typedef {import('./http.mjs').Res} Res */

/* the session cookie's name carries the port: cookies are per host, not per port, so two Studios on 127.0.0.1 (an
   installed one and a checkout, say) would otherwise sign each other's pages out */
const cookieName = (/** @type {number} */ port) => `openfilm_studio_${port}`;
/* and its twin for a page shown inside another site's frame (an agent's preview pane): a SameSite=Strict cookie is
   neither kept nor sent there, so Studio would say "open it from the address…" however it was opened. This one is
   Partitioned (CHIPS): kept for that frame's top-level site only, so a page elsewhere never has it unless it framed the
   address with the key itself; and a write still has to come from the editor's own origin (authorize) */
const framedCookieName = (/** @type {number} */ port) => `${cookieName(port)}_framed`;
/** How long `/open` waits, after a restart, for the pages of the Studio before to come back (they retry every second). */
const PAGES_BACK_MS = 3000;
/** The project's website (package.json `homepage`). */
const HOMEPAGE = (() => { try { return String(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).homepage ?? ''); } catch { return ''; } })();
/** Where the desktop app's installers are (product.json `desktop.updates`): empty in a build from source. */
const DESKTOP_FILES = (() => { try { return String(JSON.parse(readFileSync(new URL('../../product.json', import.meta.url), 'utf8')).desktop?.updates ?? '').replace(/\/+$/, ''); } catch { return ''; } })();

/**
 * The desktop app's installer for a system and chip, as the release publishes it, or null: an unknown system or chip,
 * or a build that names no place for installers.
 * @param {unknown} os @param {unknown} arch @param {string} [base]
 */
export function desktopInstaller(os, arch, base = DESKTOP_FILES) {
  if (!base || (arch !== 'arm64' && arch !== 'x64')) return null;
  if (os === 'mac') return `${base}/mac/${arch}/OpenFilm-${arch}.dmg`;
  if (os === 'win') return `${base}/win/${arch}/OpenFilm-Setup-${arch}.exe`;
  return null;
}

/**
 * Flatten the model's nested storyboard JSON into the document shape. A model that returns a flat
 * `shots` list is accepted too; a reply with no usable shot is an error, never an empty "success".
 * @param {{ id?: string, name?: string, path: string }} project
 * @param {unknown} raw @param {Record<string, unknown>} brief
 */
export function aiStoryboard(project, raw, brief) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, any>} */ (raw) : {};
  const scenesIn = Array.isArray(source.scenes) ? source.scenes : [];
  const flatScenes = [];
  const flatShots = [];
  for (const [sceneIndex, scene] of scenesIn.entries()) {
    if (!scene || typeof scene !== 'object') continue;
    const sceneId = `ai_scene_${sceneIndex + 1}`;
    flatScenes.push({ id: sceneId, title: String(scene.title ?? `Scene ${sceneIndex + 1}`), order: sceneIndex });
    const shots = Array.isArray(scene.shots) ? scene.shots : [];
    for (const shot of shots) {
      if (!shot || typeof shot !== 'object') continue;
      flatShots.push({
        ...shot,
        sceneId,
        targetMs: Number(shot.targetMs) || 4000,
        must: Array.isArray(shot.must) ? shot.must : [],
        avoid: Array.isArray(shot.avoid) ? shot.avoid : [],
      });
    }
  }
  if (!flatShots.length && Array.isArray(source.shots)) {
    for (const shot of source.shots) {
      if (!shot || typeof shot !== 'object') continue;
      flatShots.push({
        ...shot,
        sceneId: flatScenes[0]?.id ?? 'ai_scene_1',
        targetMs: Number(shot.targetMs) || 4000,
        must: Array.isArray(shot.must) ? shot.must : [],
        avoid: Array.isArray(shot.avoid) ? shot.avoid : [],
      });
    }
  }
  if (!flatShots.length) throw new HttpError(502, '模型没有给出可用的分镜镜头');
  if (!flatScenes.length) flatScenes.push({ id: 'ai_scene_1', title: 'Scene 01', order: 0 });
  const doc = normalizeStoryboard({
    id: source.id,
    title: source.title || project.name || 'Storyboard',
    brief: { ...(source.brief && typeof source.brief === 'object' ? source.brief : {}), ...brief },
    scenes: flatScenes,
    shots: flatShots,
    source: 'ai',
  }, project);
  /* A model that fell back to equal beats still gets a purposeful rhythm: only when every shot is
     effectively the same length, never on top of durations it chose itself. */
  const rounded = new Set(doc.shots.map((shot) => Math.round(shot.targetMs / 100)));
  if (brief.durationMs != null) {
    if (doc.shots.length > 1 && rounded.size <= 1) distributeDurations(doc, Number(brief.durationMs));
    else scaleDuration(doc, Number(brief.durationMs));
  }
  return doc;
}

/** One thumbnail as a data URL the visual reviewer can read, wherever the candidate lives. */
async function thumbnailDataUrl(/** @type {any} */ candidate, /** @type {any} */ semanticIndex) {
  if (!candidate?.thumbUrl) return null;
  try {
    const url = new URL(candidate.thumbUrl, 'http://studio.local');
    const response = await semanticIndex.thumb(url.searchParams);
    const type = response.headers.get('content-type') || 'image/jpeg';
    return `data:${type};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
  } catch {
    return null;
  }
}

/** One picture the VL agent can look at: an indexed candidate's thumb, or a poster/frame of a library file. */
async function materialImageData(
  /** @type {any} */ project,
  /** @type {{ libraryId?: string, path: string, kind?: string, thumbUrl?: string }} */ info,
  /** @type {any} */ semanticIndex,
  /** @type {string | null} */ base = null,
) {
  if (info.thumbUrl) {
    const indexed = await thumbnailDataUrl(info, semanticIndex);
    if (indexed) return indexed;
  }
  const external = info.libraryId && info.libraryId !== project.id
    ? semanticIndex.externalLibraries().find((/** @type {any} */ item) => item.id === info.libraryId)
    : null;
  const root = external?.path ?? project.path;
  const rel = isAbsolute(info.path) ? relative(root, info.path) : info.path;
  if (!rel || rel.startsWith('..')) return null;
  try {
    const kind = info.kind || clipKind(rel);
    if (kind === 'page' && base) {
      const jpeg = await pageFrame(root, base, rel, -1, 640);
      return jpeg ? `data:image/jpeg;base64,${jpeg.toString('base64')}` : null;
    }
    if (kind === 'video' || kind === 'image' || kind === 'still') {
      const jpeg = await poster(root, rel);
      return jpeg?.length ? `data:image/jpeg;base64,${jpeg.toString('base64')}` : null;
    }
  } catch { /* no picture: no description */ }
  return null;
}

/**
 * Read a saved description, or make one with the VL agent the first time this material is needed.
 * Automatic generation is best-effort: a failed description must not fail a storyboard operation.
 * @param {any} project
 * @param {{ libraryId?: string, path: string, name?: string, kind?: string, thumbUrl?: string }} info
 * @param {any} semanticIndex
 * @param {{ regenerate?: boolean, base?: string | null }} [options]
 */
async function ensureAssetDescription(
  /** @type {any} */ project,
  /** @type {{ libraryId?: string, path: string, name?: string, kind?: string, thumbUrl?: string }} */ info,
  /** @type {any} */ semanticIndex,
  options = {},
) {
  const { regenerate = false, base = null } = options;
  const libraryId = info.libraryId || project.id;
  const saved = await getDescription(libraryId, info.path).catch(() => null);
  if (saved?.desc && !regenerate) return saved.desc;
  if (!agentReady('qc')) return null;
  const image = await materialImageData(project, info, semanticIndex, base);
  if (!image) return null;
  const reply = await callAgent('qc', [{
    role: 'user',
    content: [
      { type: 'text', text: `Describe this material for a video editor. One or two concise Chinese sentences about what is actually visible: subject, setting, action, shot size and mood. Do not invent anything not visible. Material: ${JSON.stringify({ name: info.name ?? '', kind: info.kind ?? '' })}\nReturn only JSON: {"desc":"..."}.` },
      { type: 'image_url', image_url: { url: image } },
    ],
  }], { project });
  let desc = '';
  try {
    const parsed = parseJsonReply(reply);
    desc = typeof parsed?.desc === 'string' ? parsed.desc : typeof parsed?.candidates?.[0]?.desc === 'string' ? parsed.candidates[0].desc : '';
  } catch {
    desc = reply;
  }
  desc = desc.trim().slice(0, 2000);
  if (!desc) return null;
  await saveDescription(libraryId, info.path, desc, { by: 'agent', model: 'qc' }).catch(() => {});
  return desc;
}

/** Optional visual review of a shot's candidates; keeps every candidate and records the reason. */
async function reviewShot(/** @type {any} */ project, /** @type {any} */ shot, /** @type {any} */ semanticIndex) {
  const candidates = (Array.isArray(shot.match?.candidates) ? shot.match.candidates : []).slice(0, 4);
  const withImages = [];
  for (const [index, candidate] of candidates.entries()) {
    const image = await thumbnailDataUrl(candidate, semanticIndex);
    if (image) withImages.push({ candidate, index, image });
  }
  if (!withImages.length) return false;
  const content = [
    { type: 'text', text: `Review these candidate shots for: ${JSON.stringify({ title: shot.title, narration: shot.narration, visualIntent: shot.visualIntent, must: shot.must, avoid: shot.avoid })}.\nReturn only JSON: {"candidates":[{"index":1,"verdict":"pass|uncertain|fail","confidence":0,"reason":"short reason","desc":"one or two Chinese sentences describing what this candidate actually shows"}]}. Candidate indexes are listed below.` },
    ...withImages.flatMap(({ candidate, index, image }) => ([
      { type: 'text', text: `candidate ${index + 1}: ${candidate.name}` },
      { type: 'image_url', image_url: { url: image } },
    ])),
  ];
  const reply = await callAgent('qc', [{ role: 'user', content }], { project });
  const parsed = parseJsonReply(reply);
  const reviews = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
  for (const review of reviews) {
    const index = Number(review?.index) - 1;
    const candidate = candidates[index];
    if (!candidate) continue;
    candidate.review = {
      verdict: review?.verdict === 'pass' || review?.verdict === 'fail' ? review.verdict : 'uncertain',
      confidence: Math.max(0, Math.min(1, Number(review?.confidence) || 0)),
      reason: typeof review?.reason === 'string' ? review.reason.slice(0, 500) : '',
    };
    if (typeof review?.desc === 'string' && review.desc.trim()) {
      const existing = await getDescription(candidate.libraryId || project.id, candidate.path).catch(() => null);
      if (!existing?.desc) await saveDescription(candidate.libraryId || project.id, candidate.path, review.desc, { by: 'agent', model: 'qc' }).catch(() => {});
    }
  }
  const selected = candidates.find((/** @type {any} */ candidate) => candidate.id === shot.match.selectedId) ?? candidates[0] ?? null;
  shot.match = {
    ...shot.match,
    state: shot.match.state === 'gap' ? 'gap' : (selected?.review?.verdict === 'fail' || shot.match.confidence < 55 ? 'review' : 'matched'),
  };
  return true;
}

/**
 * The rough-cut pipeline's Plan-Execute entry point. The planner produces a validated plan, then
 * the executor runs its steps through the same storyboard/film functions the UI and MCP use. The
 * old fixed five stages still appear in `run.steps` for pages that have not adopted `run.plan`.
 */
async function runRoughcutPipeline(/** @type {any} */ project, /** @type {any} */ input, /** @type {any} */ semanticIndex, /** @type {any} */ run) {
  return runPlan(project, input, semanticIndex, run, {
    buildStoryboard: (raw, brief) => aiStoryboard(project, raw, brief),
    reviewShot,
  });
}

/**
 * Start Studio. `port` 0 picks a free one. `advertise`:
 * write where it listens to ~/.openfilm/run.json (removed on close), which is how the CLI finds this machine's Studio,
 * and open with the machine's key (see studioKey); otherwise the key is new each launch.
 * `onQuit`: what `POST /api/quit` does (by default, close); `stays`: it does nothing and says so (an app's Studio,
 * which its window needs). `editorDir`: the built editor to serve (by default studio/ui/dist); an app that builds
 * Studio's editor into a page of its own (its chat beside it) serves that one. `working`: the folders an app's agent
 * is working in right now (an app with a chat), which cannot be renamed or deleted meanwhile. Resolves once both servers listen.
 * @param {{ port?: number, key?: string, openBrowser?: (url: string) => void, advertise?: boolean, onQuit?: () => void, stays?: boolean, editorDir?: string, working?: () => string[] }} [options]
 */
export async function startStudio({ port = 4747, key, openBrowser = systemBrowser, advertise = false, onQuit, stays = false, editorDir = EDITOR_DIR, working = () => [] } = {}) {
  let COOKIE = cookieName(port);
  let FRAMED = framedCookieName(port);
  /** The key from either session cookie. */
  const cookieKey = (/** @type {Req} */ req) => (sameKey(cookie(req, COOKIE)) ? cookie(req, COOKIE) : cookie(req, FRAMED));
  key ??= advertise ? studioKey() : randomBytes(24).toString('hex');
  /* A separate, session-only credential for the MCP endpoint. It cannot be used on any other
     Studio API (notably render/export): an agent may learn this one, never the editor's key. */
  const mcpKey = randomBytes(24).toString('hex');
  const watchers = createWatchers();
  /** the local semantic index: process, project/extra roots, model import (semantic-index.mjs) */
  const semanticIndex = new SemanticIndexService();
  /** questions about spending for the person, in the pages showing a project (see get.mjs) */
  const asks = createAsks({ emit: (root, event) => watchers.emit(root, event), roots: watchers.roots });
  /** the editor pages open right now, and whether each is in sight: `/open` switches them to a project */
  /** @type {Map<(event: unknown) => void, { visible: boolean }>} */
  const editorPages = new Map();
  /** a page connected: what `/open` waits on after a restart, while the pages of the Studio before come back */
  let pageCame = () => {};
  /** media being made for an agent's `openfilm get` right now (it would be lost, and paid for, if Studio stopped) */
  let making = 0;
  /** the update run from the top bar: `{ status: 'updating' | 'failed', version, error? }` (see /api/update) */
  let updating = /** @type {{ status: 'updating' | 'failed', version: string, error?: string } | null} */ (null);
  /** whether an app's agent is working in the project at `path` now */
  const agentIn = (/** @type {string} */ path) => working().some((folder) => resolve(folder) === resolve(path));
  /** how many editor pages have connected since Studio started: whether one opened an address `/open` gave out */
  let pagesConnected = 0;
  /** @type {(event: unknown) => void} */
  const toPages = (event) => { for (const send of editorPages.keys()) send(event); };
  let origin = '';
  let filmOrigin = '';

  /** where each project's exports report their progress: the pages watching it */
  const exportRoots = new Map();
  const exports = createExports({ onChange: (job) => { const root = exportRoots.get(job.project); if (root) watchers.emit(root, { type: 'export', job }); } });
  /** films fetched from GitHub into the library (fetch-repo.mjs), each opened as a project when it lands */
  const fetches = createFetches({ library: libraryRoot, open: (folder) => openProject(folder) });

  const sameKey = (/** @type {string | null | undefined} */ given) => typeof given === 'string' && given.length === key.length
    && timingSafeEqual(Buffer.from(given), Buffer.from(key));
  const sameMcpKey = (/** @type {string | null | undefined} */ given) => typeof given === 'string' && given.length === mcpKey.length
    && timingSafeEqual(Buffer.from(given), Buffer.from(mcpKey));

  /** The caller holds the key; a browser write must also come from the editor's own origin. */
  function authorize(/** @type {Req} */ req) {
    if (sameKey(/** @type {string | undefined} */ (req.headers['x-studio-key']))) return;
    /* MCP clients use the standard Bearer header with the separate MCP key. It is accepted only on
       this project MCP path, so a tool token cannot become a render/export token. */
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    if (/^\/api\/projects\/[^/]+\/mcp(?:\?|$)/.test(req.url ?? '') && sameMcpKey(bearer)) return;
    if (!sameKey(cookieKey(req))) throw new HttpError(401, 'open Studio from the address `openfilm open` prints');
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers.origin !== origin) throw new HttpError(403, 'not from Studio');
  }

  /*
   * The editor pages' streams of events, over WebSockets (websocket.mjs): `/api/events`, what the CLI's `open` sends
   * (and how many pages are open), and `/api/projects/:id/events`, a project's changes and the questions for the
   * person. Each returns how it stops.
   */
  /** @param {(event: unknown) => void} send @param {{ visible: boolean }} page */
  const editorStream = (send, page) => {
    editorPages.set(send, page);
    pagesConnected += 1;
    pageCame();
    return () => { editorPages.delete(send); };
  };
  /** @param {Awaited<ReturnType<typeof projectById>>} project @param {(event: any) => void} send */
  const projectStream = (project, send) => {
    const stop = watchers.subscribe(project.path, send);
    /* A page reconnecting after a rename takes the current path even if it missed the live event. */
    send({ type: 'project', project });
    for (const ask of asks.pending(project.path)) send(ask);
    return stop;
  };

  /** @param {Req} req @param {Res} res */
  async function route(req, res) {
    const url = new URL(req.url ?? '/', origin);
    const path = url.pathname;
    if (path.startsWith('/api/')) {
      const startedAt = Date.now();
      res.once('finish', () => recordApi({ method: req.method, path, status: res.statusCode, ms: Date.now() - startedAt }));
    }

    /* which Studio this is: the CLI replaces an older one, and finds its own home's when run.json is gone. Asked
       without the key, so it says nothing of the machine: its home only as a digest (homeTag), no process id */
    /* `app`: the desktop app's Studio, which updates with the app (`openfilm update` says so instead) */
    if (path === '/api/health') return json(res, 200, { product: 'openfilm-studio', version: VERSION, home: homeTag(), filmOrigin, ...(stays ? { app: true } : {}) });
    const signIn = [`${COOKIE}=${key}; Path=/; HttpOnly; SameSite=Strict`, `${FRAMED}=${key}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`];
    /** A page's address with the key in it (the address bar is what a person copies). */
    const keyed = (/** @type {string} */ to) => {
      const at = new URL(to, origin);
      at.searchParams.set('key', String(key));
      return at.pathname + at.search;
    };
    if (path === '/open') {
      if (!sameKey(url.searchParams.get('key'))) throw new HttpError(403, 'this link is from another Studio launch; use the one `openfilm open` printed');
      const to = url.searchParams.get('to') ?? '/';
      res.writeHead(302, { location: keyed(/^\/(?!\/)[^\s\\]*$/.test(to) ? to : '/'), 'set-cookie': signIn, 'referrer-policy': 'no-referrer' });
      return res.end();
    }
    if (!path.startsWith('/api/')) {
      if (path.startsWith('/assets/')) return sendEditor(res, editorDir, path);
      /* A page with the key in its address signs this browser in. A browser that opens the bare local
         address is the person at this machine: sign it in too, so typing 127.0.0.1:4848 works. The cookie
         stays HttpOnly + SameSite=Strict; API writes still must come from this origin. */
      const suppliedKey = url.searchParams.get('key');
      if (sameKey(suppliedKey)) return sendEditor(res, editorDir, path, { 'set-cookie': signIn });
      if (sameKey(cookieKey(req))) return sendEditor(res, editorDir, path);
      /* A wrong key is still just the unauthenticated page; never let the loopback convenience
         turn it into a signed-in browser. */
      if (suppliedKey != null) return sendEditor(res, editorDir, path);
      const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
      return sendEditor(res, editorDir, path, loopback ? { 'set-cookie': signIn } : undefined);
    }

    authorize(req);
    if (path === '/api/api-logs') {
      if (req.method === 'GET') return json(res, 200, { entries: listApi(Number(url.searchParams.get('limit') || 300)) });
      if (req.method === 'DELETE') { clearApi(); return json(res, 200, {}); }
      throw new HttpError(405, 'use GET or DELETE');
    }
    if (path === '/api/model-logs') {
      if (req.method === 'GET') return json(res, 200, { entries: listModelCalls(Number(url.searchParams.get('limit') || 200)) });
      if (req.method === 'DELETE') { clearModelCalls(); return json(res, 200, {}); }
      throw new HttpError(405, 'use GET or DELETE');
    }
    const parts = path.slice('/api/'.length).split('/').map(decodeURIComponent);

    /* ── semantic index: sidecar, models, extra libraries, jobs (semantic-index.mjs) ── */
    if (parts[0] === 'index') {
      /* Global vector library: the same view without a project. */
      if (parts.length === 1 && req.method === 'GET') return json(res, 200, await semanticIndex.status(null));
      if (parts[1] === 'root' && parts.length === 2 && req.method === 'PUT') {
        const body = /** @type {{ path?: unknown }} */ (await readJson(req) ?? {});
        if (typeof body.path !== 'string' || !isAbsolute(body.path)) throw new HttpError(400, 'an absolute folder is required');
        await semanticIndex.changeGlobalRoot(body.path);
        return json(res, 200, await semanticIndex.status(null));
      }
      if (parts[1] === 'health' && parts.length === 2 && req.method === 'GET') return json(res, 200, await semanticIndex.health());
      if (parts[1] === 'restart' && parts.length === 2 && req.method === 'POST') return json(res, 200, { health: await semanticIndex.restart() });
      if (parts[1] === 'models' && parts.length === 2 && req.method === 'GET') return json(res, 200, { models: await semanticIndex.models(), health: await semanticIndex.health() });
      if (parts[1] === 'models' && parts.length === 2 && req.method === 'PUT') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 2 << 30) throw new HttpError(413, 'the model package is larger than 2 GB');
          chunks.push(chunk);
        }
        const filename = basename(url.searchParams.get('filename') || 'model.zip').replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'model.zip';
        return json(res, 200, await semanticIndex.importModel(Buffer.concat(chunks), filename));
      }
      if (parts[1] === 'libraries' && parts.length === 2 && req.method === 'GET') {
        return json(res, 200, { libraries: semanticIndex.externalLibraries(), health: await semanticIndex.health() });
      }
      if (parts[1] === 'libraries' && parts.length === 2 && req.method === 'POST') {
        return json(res, 200, { library: await semanticIndex.addExternal(/** @type {any} */ (await readJson(req))) });
      }
      if (parts[1] === 'libraries' && parts[2] && parts.length === 3 && req.method === 'DELETE') {
        await semanticIndex.removeExternal(parts[2]);
        return json(res, 200, {});
      }
      if (parts[1] === 'libraries' && parts[2] && parts[3] === 'index' && parts.length === 4 && req.method === 'DELETE') {
        await semanticIndex.removeStore(parts[2], url.searchParams.get('storeId') || '');
        return json(res, 200, {});
      }
      if (parts[1] === 'jobs' && parts.length === 2 && req.method === 'POST') {
        const body = /** @type {any} */ (await readJson(req));
        if (!body?.libraryId) throw new HttpError(400, 'libraryId is required');
        return json(res, 200, await semanticIndex.startExternalJob(String(body.libraryId), body));
      }
      if (parts[1] === 'jobs' && parts[2] && parts.length === 3 && req.method === 'GET') {
        const libraryId = url.searchParams.get('libraryId');
        if (!libraryId) throw new HttpError(400, 'libraryId is required');
        return json(res, 200, await semanticIndex.job(libraryId, parts[2]));
      }
      if (parts[1] === 'jobs' && parts[2] && parts[3] === 'cancel' && parts.length === 4 && req.method === 'POST') {
        const libraryId = url.searchParams.get('libraryId');
        if (!libraryId) throw new HttpError(400, 'libraryId is required');
        return json(res, 200, await semanticIndex.cancelJob(libraryId, parts[2]));
      }
      if (parts[1] === 'thumb' && parts.length === 2 && req.method === 'GET') {
        const upstream = await semanticIndex.thumb(url.searchParams);
        const data = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(200, {
          'content-type': upstream.headers.get('content-type') || 'image/jpeg',
          'cache-control': 'private, max-age=3600',
          'content-length': data.length,
        });
        return res.end(data);
      }
      /* a candidate's media, wherever its library lives: project files and external folders share the
         global vector catalog, so the preview needs to resolve its own source root, not the open project. */
      if (parts[1] === 'media' && parts.length === 2 && req.method === 'GET') {
        const libraryId = url.searchParams.get('libraryId') || '';
        const file = url.searchParams.get('path') || '';
        if (!libraryId || !file) throw new HttpError(400, 'libraryId and path are required');
        const projects = await listProjects();
        const project = projects.find((item) => item.id === libraryId && !item.missing);
        const external = semanticIndex.externalLibraries().find((item) => item.id === libraryId);
        const root = project?.path ?? external?.path;
        if (!root) throw new HttpError(404, 'no such media library');
        const absolute = resolve(root, file);
        if (!inside(root, absolute)) throw new HttpError(403, 'that file is outside its library');
        return sendMedia(req, res, absolute, { keep: true });
      }
      throw new HttpError(404, 'no such index route');
    }

    /* ── the unified provider cards and agent cards (provider-cards.mjs, agent-cards.mjs) ── */
    if (parts[0] === 'provider-cards') {
      if (parts.length === 1 && req.method === 'GET') {
        const state = readProviderState();
        return json(res, 200, { state: redactState(state), catalog: CATALOG, categories: CATEGORIES });
      }
      if (parts.length === 1 && req.method === 'PUT') {
        const saved = await saveProviderState(await readJson(req));
        await syncLegacyRuntime(saved).catch(() => {});
        await semanticIndex.syncRemoteModels().catch(() => {});
        return json(res, 200, redactState(saved));
      }
      if (parts[1] === 'test' && parts.length === 2 && req.method === 'POST') {
        const body = /** @type {Record<string, any>} */ (await readJson(req) ?? {});
        const state = readProviderState();
        const card = state.cards.find((item) => item.id === body.cardId);
        const connection = card ? cardConnection(card, state) : state.connections.find((item) => item.id === body.connectionId);
        return json(res, 200, await testConnection({
          ...body,
          baseUrl: body.baseUrl || connection?.baseUrl || '',
          key: body.key || connection?.key || '',
          auth: body.auth || connection?.auth,
          authHeader: body.authHeader || connection?.authHeader,
          headers: body.headers || connection?.headers,
        }));
      }
      throw new HttpError(404, 'no such provider cards route');
    }
    if (parts[0] === 'agent-cards') {
      if (parts.length === 1 && req.method === 'GET') return json(res, 200, { state: readAgentState(), roles: AGENT_ROLES, prompts: defaultPrompts() });
      if (parts.length === 1 && req.method === 'PUT') return json(res, 200, { state: await saveAgentState(await readJson(req)), roles: AGENT_ROLES });
      throw new HttpError(404, 'no such agent cards route');
    }

    /* stop: another app is taking over this machine's Studio, or `openfilm open` starts it afresh (`whenIdle`: not
       while an export runs or media is made — it would be lost). `pages`: how many were open, to come back */
    if (parts[0] === 'quit' && parts.length === 1 && req.method === 'POST') {
      const { whenIdle = false } = /** @type {{ whenIdle?: boolean }} */ ((await readJson(req).catch(() => null)) ?? {});
      if (whenIdle && exports.busy()) return json(res, 409, { error: 'an export is running' });
      if (whenIdle && making) return json(res, 409, { error: 'media is being made' });
      /* not busy, but kept (423, not 409: the app asks its own Studio whether it is busy this way) */
      if (stays) return json(res, 423, { error: 'it is the OpenFilm app\'s, which keeps it' });
      json(res, 200, { pages: editorPages.size });
      setImmediate(() => (onQuit ?? (() => { void studio.close(); }))());
      return;
    }
    /* `openfilm open [folder]`: open it (no folder: the project opened last, else the Projects window) and show it.
       Every Studio page open already switches to it; when one is in sight (not a tab behind others, a window
       minimized, an agent's hidden browser), nothing more opens: one window is enough. Else in a browser: the
       agent's own when it opens the address within `fallback` seconds, else the person's (`now`: at once, for a
       person at a terminal, who has no other). `pages`: how many the Studio before this one had, waited for up to a
       few seconds while they come back (Studio was just started afresh) */
    if (parts[0] === 'open' && req.method === 'POST') {
      const { path: folder, fallback = 15, now = false, pages: before = 0 } = /** @type {{ path?: string, fallback?: number, now?: boolean, pages?: number }} */ (await readJson(req));
      if (folder != null && (typeof folder !== 'string' || !folder)) throw new HttpError(400, 'which folder?');
      /* a relative path would be read from Studio's own folder, not the caller's */
      if (folder != null && !isAbsolute(folder)) throw new HttpError(400, 'the folder\'s full path, please');
      /* the last one still there as a project: a folder whose film.html was taken away is not made one again */
      const last = folder == null ? (await listProjects()).find((p) => !p.missing && existsSync(join(p.path, FILM_FILE))) : null;
      const project = folder != null ? await openProject(folder) : last ? await openProject(last.path) : null;
      const to = project ? `/projects/${encodeURIComponent(project.id)}` : '/';
      const address = `${origin}/open?key=${key}&to=${encodeURIComponent(to)}`;
      for (const end = Date.now() + PAGES_BACK_MS; editorPages.size < before && Date.now() < end;) {
        await new Promise((done) => { pageCame = () => done(undefined); setTimeout(done, end - Date.now()).unref(); });
      }
      pageCame = () => {};
      const open = [...editorPages.values()].filter((page) => page.visible).length;
      toPages({ type: 'open', to });
      if (!open) {
        const before = pagesConnected;
        if (now) openBrowser(address);
        else if (fallback > 0) setTimeout(() => { if (pagesConnected === before) openBrowser(address); }, fallback * 1000).unref();
      }
      return json(res, 200, { project, url: address, pages: open });
    }

    /* this Studio's version, and the latest on npm (Settings → General; `?check=1` asks npm now) */
    if (parts[0] === 'version' && parts.length === 1 && req.method === 'GET') {
      const now = url.searchParams.get('check') === '1';
      const { latest, checkedAt } = await npmOpenfilm({ force: now, waitMs: 4000 });
      return json(res, 200, { version: VERSION, latest, newer: Boolean(latest && olderThanThis(VERSION, latest)), checkedAt, checking: !process.env.OPENFILM_NO_UPDATE_CHECK && !FROM_SOURCE, source: FROM_SOURCE,
        ...(updating ? { update: updating } : {}) });
    }
    /* Settings → Developer's diagnostic report: `openfilm doctor` (src/doctor.mjs), as this Studio sees the computer */
    if (parts[0] === 'doctor' && parts.length === 1 && req.method === 'GET') {
      const report = await doctor({ studio: { origin, version: VERSION, ...(stays ? { app: true } : {}) } });
      return json(res, 200, { ok: report.ok, text: report.text });
    }
    /* Settings → Developer: the problems of the last two weeks (src/problems.mjs), newest first */
    if (parts[0] === 'diagnostics' && parts[1] === 'problems' && parts.length === 2 && req.method === 'GET') {
      return json(res, 200, { problems: recentProblems().reverse() });
    }
    /* Settings → Developer's diagnostic file (diagnostics.mjs): the report the page made, and the rest, as a zip in the
       exports folder, shown in the file manager */
    if (parts[0] === 'diagnostics' && parts[1] === 'export' && parts.length === 2 && req.method === 'POST') {
      const { report, conversations } = /** @type {{ report?: unknown, conversations?: unknown }} */ ((await readJson(req).catch(() => null)) ?? {});
      const text = typeof report === 'string' && report.trim() ? report
        : (await doctor({ studio: { origin, version: VERSION, ...(stays ? { app: true } : {}) } })).text;
      const made = await exportDiagnostics({ report: text, conversations: conversations === true });
      reveal(made.path);
      return json(res, 200, made);
    }
    /* the top bar's Update (Studio run with npm, not the app's nor a checkout): the newest openfilm run in the
       background as `openfilm update` (client.mjs updateOpenfilm), which starts Studio again on it; the pages come back
       on the new version and reload. Not while an export runs or media is made. `/api/version` says how it goes */
    if (parts[0] === 'update' && parts.length === 1 && req.method === 'POST') {
      if (stays || FROM_SOURCE) return json(res, 409, { error: 'this Studio does not update itself', code: stays ? 'app' : 'source' });
      if (exports.busy()) return json(res, 409, { error: 'an export is running', code: 'exporting' });
      if (making) return json(res, 409, { error: 'media is being made', code: 'making' });
      if (updating?.status === 'updating') return json(res, 202, { update: updating });
      const { latest } = await npmOpenfilm({ waitMs: 4000 });
      if (!latest || !olderThanThis(VERSION, latest)) return json(res, 409, { error: 'this is the newest openfilm', code: 'newest' });
      updating = runUpdate(latest, (next) => { updating = next; });
      return json(res, 202, { update: updating });
    }
    /* the fonts installed here (what a web page can draw with, in the preview and the export alike) */
    if (parts[0] === 'fonts' && parts.length === 1 && req.method === 'GET') return json(res, 200, { fonts: await installedFonts() });

    /* the top bar's Desktop button: the installer for this computer ({ os, arch }) opened in the person's browser,
       else the website, where the download is */
    if (parts[0] === 'desktop' && parts.length === 1 && req.method === 'POST') {
      const { os, arch } = /** @type {{ os?: unknown, arch?: unknown }} */ (await readJson(req).catch(() => ({})) ?? {});
      const to = desktopInstaller(os, arch) ?? HOMEPAGE;
      if (to) openBrowser(to);
      return json(res, 200, {});
    }
    /* ── own keys and who makes each kind of media (Settings → Providers): never a key back; see providers/index.mjs ── */
    if (parts[0] === 'providers') return providersRoute(req, res, parts.slice(1), { openBrowser });
    /* ── `openfilm get`: media from a provider, landed in the project; spending is asked here first (see get.mjs) ── */
    if (parts[0] === 'get') {
      making += req.method === 'POST' ? 1 : 0;
      try { return await getRoute(req, res, parts.slice(1), asks); } finally { making -= req.method === 'POST' ? 1 : 0; }
    }

    /* the system's folder dialog, opened here for a page in a browser (folder-picker.mjs): { path } (null: cancelled);
       501 when this system has none Studio can open */
    if (parts[0] === 'pick-folder' && parts.length === 1 && req.method === 'POST') {
      const { title, at } = /** @type {{ title?: unknown, at?: unknown }} */ (await readJson(req).catch(() => ({})) ?? {});
      try {
        const path = await pickFolder({ title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : 'Choose a folder', at: typeof at === 'string' ? at : null });
        return json(res, 200, { path });
      } catch (e) {
        throw new HttpError(501, /** @type {Error} */ (e).message);
      }
    }
    /* Saved, the person's own library for every project (saved.mjs): its files and folders as a project's media are
       (files.mjs), by their `saved/` paths; a file's bytes, a bundle's picture, and what Studio works out from a file */
    if (parts[0] === 'saved') {
      const sub = parts.slice(1).join('/');
      const lib = await savedLibrary();
      const rel = (/** @type {unknown} */ path) => { try { return libraryRel(path); } catch (e) { throw new HttpError(400, /** @type {Error} */ (e).message); } };
      const at = url.searchParams.get('path') ?? '';
      if (sub === 'files') {
        /* `folder`: the library as the film's origin serves it, so a saved page plays in the media pane's viewer as a
           project's does */
        if (req.method === 'GET') return json(res, 200, { ...await listLibrary(), folder: pages.folderUrl({ id: SAVED_ORIGIN_ID, path: lib }) });
        if (req.method === 'PUT') return json(res, 200, { path: libraryPath((await importFile(lib, rel(at), req)).path) });
        if (req.method === 'PATCH') {
          const { from, to } = /** @type {{ from?: unknown, to?: unknown }} */ (await readJson(req) ?? {});
          return json(res, 200, { path: libraryPath((await moveFile(lib, rel(from), rel(to))).path) });
        }
        if (req.method === 'DELETE') { await trashFile(lib, rel(at)); return json(res, 200, {}); }
      }
      if (sub === 'folders' && req.method === 'POST') {
        const { path: folder } = /** @type {{ path?: unknown }} */ (await readJson(req) ?? {});
        return json(res, 200, { path: libraryPath(await makeFolder(lib, rel(folder))) });
      }
      /* files or folders of this computer copied in: the paths given, else the person's pick. { landed } */
      if (sub === 'files/bring' && req.method === 'POST') {
        const { into, paths, folder, title } = /** @type {{ into?: unknown, paths?: unknown, folder?: unknown, title?: unknown }} */ (await readJson(req) ?? {});
        const ask = { title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : 'Choose', at: null };
        const picked = Array.isArray(paths) ? paths.map(String)
          : await (folder === true ? pickFolder(ask).then((p) => (p ? [p] : [])) : pickFiles(ask)).catch((e) => { throw new HttpError(501, String(e?.message ?? e)); });
        return json(res, 200, { landed: (await bringIn(lib, rel(into ?? 'saved'), picked, 'copy', { anywhere: true })).map(libraryPath) });
      }
      if (sub === 'reveal' && req.method === 'POST') {
        const { path: shown } = /** @type {{ path?: unknown }} */ (await readJson(req) ?? {});
        const where = rel(shown ?? 'saved');
        if (where) reveal(inside(lib, where)); else openFile(lib);
        return json(res, 200, {});
      }
      if (sub === 'file' && req.method === 'GET') return sendMedia(req, res, inside(lib, rel(at)));
      if (sub === 'poster' && req.method === 'GET') return sendMedia(req, res, await savedCall(() => bundlePoster(at)));
      if (sub === 'media' && req.method === 'GET') {
        const what = url.searchParams.get('what');
        const file = rel(at);
        if (what === 'probe') return json(res, 200, isPage(file) ? {} : await probe(lib, file));
        if (what === 'wave') return json(res, 200, await waveform(lib, file));
        const jpeg = what === 'poster' && !isPage(file) ? await poster(lib, file)
          : what === 'frame' && !isPage(file) ? await frame(lib, file, Number(url.searchParams.get('ms')), Number(url.searchParams.get('w')))
          : null;
        if (!jpeg) throw new HttpError(400, 'what: probe, poster, frame or wave, of a media file');
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400', 'content-length': jpeg.length });
        return res.end(jpeg);
      }
    }
    /* Studio's own preferences, the same for every project (prefs.mjs) */
    if (parts[0] === 'prefs' && parts.length === 1) {
      if (req.method === 'GET') return json(res, 200, readPrefs());
      if (req.method === 'PATCH') {
        /* a folder chosen for new projects is checked, and made, before it is kept */
        const patch = /** @type {Record<string, unknown>} */ (await readJson(req) ?? {});
        for (const key of Object.values(LOCATION_KEYS)) {
          if (patch[key] == null) continue;
          try { patch[key] = usableFolder(patch[key]); } catch (e) { throw new HttpError(400, /** @type {Error} */ (e).message); }
        }
        return json(res, 200, writePrefs(patch));
      }
    }
    /* where new projects go (src/locations.mjs): the folder, its default, and its disk's free space; a POST opens it
       in the system's file manager */
    if (parts[0] === 'locations' && parts.length === 1 && req.method === 'GET') return json(res, 200, locations());
    /* the library moved (projects.mjs moveLibrary): { path } (null: the default), and with `move` its projects go too */
    if (parts[0] === 'locations' && parts[1] === 'projects' && parts.length === 2 && req.method === 'PUT') {
      const { path: asked, move } = /** @type {{ path?: unknown, move?: unknown }} */ (await readJson(req) ?? {});
      let to = null;
      if (asked != null) {
        try { to = usableFolder(asked); } catch (e) { throw new HttpError(400, /** @type {Error} */ (e).message); }
      }
      const from = libraryRoot();
      /* The index sidecar keeps a catalog.sqlite open in each project, and watchers keep a handle on the folder.
         Windows will not rename either while it is open: close both before the library moves, and keep status calls
         from opening them again until it is done. */
      const moving = move === true
        ? (await listProjects()).filter((p) => p.path === from || p.path.startsWith(`${from}${sep}`))
        : [];
      const migrating = moving.length > 0;
      if (migrating) semanticIndex.beginMigration();
      try {
        if (migrating) {
          if (await semanticIndex.hasActiveJobs(moving.map((p) => p.id))) {
            throw new HttpError(409, 'Stop the running index job before moving the projects folder.');
          }
          await semanticIndex.closeProjectLibraries(moving.map((p) => p.id));
          watchers.closeUnder(from);
        }
        const done = await moveLibrary(to, { move: move === true, choose: (folder) => chooseFolder('projectsFolder', folder) });
        return json(res, 200, { ...done, locations: locations() });
      } finally {
        if (migrating) semanticIndex.endMigration();
      }
    }
    if (parts[0] === 'locations' && parts[1] === 'projects' && parts.length === 2 && req.method === 'POST') {
      const folder = locations()[parts[1]].path;
      mkdirSync(folder, { recursive: true });
      openFile(folder);
      return json(res, 200, { ok: true });
    }
    /* the system's file dialog (folder-picker.mjs pickFiles), several at once: { paths } (none: cancelled); 501 when
       this system has none */
    if (parts[0] === 'pick-files' && parts.length === 1 && req.method === 'POST') {
      const { title } = /** @type {{ title?: unknown }} */ (await readJson(req).catch(() => ({})) ?? {});
      try {
        return json(res, 200, { paths: await pickFiles({ title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : 'Choose files', at: null }) });
      } catch (e) {
        throw new HttpError(501, /** @type {Error} */ (e).message);
      }
    }
    /* the web editor's folder browser (browse.mjs): `path`'s folders, only under the home folder, and where to start */
    if (parts[0] === 'browse' && parts.length === 1 && req.method === 'GET') {
      const listing = await browseFolder(url.searchParams.get('path'), { anywhere: url.searchParams.get('anywhere') === '1' });
      const places = await browsePlaces({ library: libraryRoot(), recent: (await listProjects()).filter((p) => !p.missing).map((p) => p.path), anywhere: url.searchParams.get('anywhere') === '1' });
      return json(res, 200, { ...listing, ...places });
    }
    /* the example films (examples.mjs): none when the index cannot be read */
    if (parts[0] === 'examples' && parts.length === 1 && req.method === 'GET') return json(res, 200, { examples: await listExamples() });
    /* a poster or preview beside an index read from this computer (examples.mjs exampleFile) */
    if (parts[0] === 'examples' && parts[1] === 'file' && parts.length > 2 && req.method === 'GET') {
      return sendMedia(req, res, exampleFile(parts.slice(2).map(decodeURIComponent).join('/')), { keep: true });
    }
    /* an example's folder on this computer, to point an agent at (examples.mjs exampleFolder) */
    if (parts[0] === 'examples' && parts.length === 3 && parts[2] === 'folder' && req.method === 'POST') {
      try {
        const folder = await exampleFolder(decodeURIComponent(parts[1]), {
          home: studioHome(),
          fetchFolder: (address, into) => fetchFilm(parseRepoUrl(address), { library: into }),
        });
        return json(res, 200, { folder });
      } catch (e) {
        throw new HttpError(e instanceof FetchError ? e.status : 404, e instanceof Error ? e.message : String(e));
      }
    }
    /* a folder of skills copied into the person's own Skills/ (the Agent settings' pool adds real files) */
    if (parts[0] === 'skills' && parts[1] === 'import' && parts.length === 2 && req.method === 'POST') {
      const body = /** @type {{ path?: unknown }} */ (await readJson(req) ?? {});
      if (typeof body.path !== 'string' || !isAbsolute(body.path)) throw new HttpError(400, 'an absolute folder is required');
      try {
        const added = await addSkills(body.path);
        return json(res, 200, { skills: added.map((skill) => ({ name: skill.name, description: skill.description, source: skill.source })) });
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
    }
    /* the skills a project can be made with (../../src/skills.mjs): its own, the person's, the official ones */
    if (parts[0] === 'skills' && parts.length === 1 && req.method === 'GET') {
      const id = url.searchParams.get('project');
      const project = id ? (await listProjects()).find((p) => p.id === id && !p.missing) : null;
      const skills = listSkills({ project: project?.path ?? null });
      const origins = skillOrigins();
      const off = new Set(skillsOff());
      const installed = new Set(skillsInstalled());
      const media = (/** @type {string} */ name, /** @type {'cover' | 'preview'} */ which) => `/api/skills/${encodeURIComponent(name)}/${which}${id ? `?project=${encodeURIComponent(id)}` : ''}`;
      return json(res, 200, {
        skills: skills.map((k) => ({
          name: k.name, description: k.description, source: k.source, scripts: k.scripts.length,
          ...(k.shown ? { shown: k.shown } : {}), ...(k.version ? { version: k.version } : {}), ...(k.kind ? { kind: k.kind } : {}),
          ...(k.order != null ? { order: k.order } : {}), ...(k.icon ? { icon: k.icon } : {}), ...(k.repository ? { repository: k.repository } : {}),
          ...(k.cover ? { cover: `${media(k.name, 'cover')}${id ? '&' : '?'}v=${encodeURIComponent(k.cover)}` } : {}), ...(k.preview ? { preview: media(k.name, 'preview') } : {}),
          /* the person's own: where it came from (none kept: made where it is) */
          ...(k.source === 'mine' ? { origin: origins[basename(k.folder)] ?? { from: 'made' } } : {}),
          /* an official one is installed to be used; the person's own and a project's are theirs already */
          installed: k.source !== 'official' || installed.has(k.name),
          /* turned off: offered to no agent until it is turned on again */
          ...(off.has(k.name) ? { off: true } : {}),
        })),
      });
    }
    /* an official skill installed or uninstalled (PUT { installed }) */
    if (parts[0] === 'skills' && parts.length === 3 && parts[2] === 'installed' && req.method === 'PUT') {
      const installed = (await readJson(req))?.installed;
      if (typeof installed !== 'boolean') throw new HttpError(400, 'installed: true or false');
      const skill = listSkills().find((k) => k.name === decodeURIComponent(parts[1]));
      if (!skill || skill.source !== 'official') throw new HttpError(404, 'no such official skill');
      setSkillInstalled(skill.name, installed);
      return json(res, 200, { installed });
    }
    /* one of the person's own skills, or a project's, moved to the trash (an official one is uninstalled instead) */
    if (parts[0] === 'skills' && parts.length === 2 && req.method === 'DELETE') {
      const id = url.searchParams.get('project');
      const project = id ? (await listProjects()).find((p) => p.id === id && !p.missing) : null;
      const skill = listSkills({ project: project?.path ?? null }).find((k) => k.name === decodeURIComponent(parts[1]));
      if (!skill) throw new HttpError(404, 'no such skill');
      if (skill.source === 'official') throw new HttpError(400, 'An official skill is uninstalled, not removed.');
      if (skill.source === 'mine') await removeSkill(skill.name);
      else await moveToTrash(skill.folder);
      return json(res, 200, {});
    }
    /* a skill turned on or off, by name, for every project (PUT { on }) */
    if (parts[0] === 'skills' && parts.length === 3 && parts[2] === 'on' && req.method === 'PUT') {
      const on = (await readJson(req))?.on;
      if (typeof on !== 'boolean') throw new HttpError(400, 'on: true or false');
      try { setSkillOn(decodeURIComponent(parts[1]), on); } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
      return json(res, 200, { on });
    }
    /* Only the person's own skill can be changed; a project override must not edit a hidden personal skill. */
    if (parts[0] === 'skills' && parts.length === 3 && parts[2] === 'cover' && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = url.searchParams.get('project');
      const project = id ? (await listProjects()).find((p) => p.id === id && !p.missing) : null;
      const name = decodeURIComponent(parts[1]);
      const skill = listSkills({ project: project?.path ?? null }).find((s) => s.name === name);
      if (!skill) throw new HttpError(404, 'no such skill');
      if (skill.source !== 'mine') throw new HttpError(403, 'Only your own skills can have their cover changed.');
      const cover = req.method === 'DELETE' ? null : (await readJson(req, 7 << 20))?.cover;
      try {
        const updated = setSkillCover(name, cover);
        return json(res, 200, { cover: updated?.cover ? `/api/skills/${encodeURIComponent(name)}/cover?v=${encodeURIComponent(updated.cover)}` : null });
      } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : String(e)); }
    }
    /* a skill's cover picture or preview video (its openfilm.json's `cover`, `preview`) */
    if (parts[0] === 'skills' && parts.length === 3 && (parts[2] === 'cover' || parts[2] === 'preview') && req.method === 'GET') {
      const id = url.searchParams.get('project');
      const project = id ? (await listProjects()).find((p) => p.id === id && !p.missing) : null;
      const skill = listSkills({ project: project?.path ?? null }).find((k) => k.name === decodeURIComponent(parts[1]));
      const file = skill?.[parts[2]];
      return sendMedia(req, res, skill && file ? join(skill.folder, file) : null, { keep: true });
    }

    if (parts[0] !== 'projects') throw new HttpError(404, 'no such API');
    if (parts.length === 1) {
      if (req.method === 'GET') return json(res, 200, { projects: (await listProjects()).map((p) => (agentIn(p.path) ? { ...p, working: true } : p)) });
      /* `create` false: only a folder holding a film opens (the editor asks before starting one in a folder) */
      if (req.method === 'POST') {
        const body = /** @type {{ path?: string, name?: string, create?: boolean }} */ (await readJson(req));
        return json(res, 200, { project: body.path ? await openProject(body.path, { create: body.create !== false }) : await createProject(body.name) });
      }
    }
    /* a film from GitHub (fetch-repo.mjs): POST { url } `projects/fetch` starts it → { job }; GET `projects/fetch/:id`
       says how it goes (`project` once it is opened); DELETE stops it */
    if (parts[1] === 'fetch') {
      if (parts.length === 2 && req.method === 'POST') return json(res, 200, { job: fetches.start(/** @type {{ url?: string }} */ (await readJson(req)).url) });
      if (parts.length === 3 && req.method === 'GET') return json(res, 200, { job: fetches.get(parts[2]) });
      if (parts.length === 3 && req.method === 'DELETE') { fetches.cancel(parts[2]); return json(res, 200, {}); }
    }
    /* the Projects list's folders (projects.mjs): GET / POST { name, parentId? } `projects/folders`, PATCH { name } /
       DELETE `projects/folders/:id` (with the folders inside it; answers the ids of the projects that were in them), PUT { folderId }
       `projects/:id/folder` (null: no folder) */
    if (parts[1] === 'folders' && parts.length <= 3) {
      if (parts.length === 2 && req.method === 'GET') return json(res, 200, { folders: await listFolders() });
      if (parts.length === 2 && req.method === 'POST') {
        const { name, parentId } = /** @type {{ name?: string, parentId?: string | null }} */ (await readJson(req));
        return json(res, 200, { folder: await createFolder(name, parentId) });
      }
      if (parts.length === 3 && req.method === 'PATCH') {
        const body = /** @type {{ name?: string, parentId?: string | null }} */ (await readJson(req));
        /* { parentId }: moved into another folder (null: the top level); else { name }: renamed */
        if (Object.hasOwn(body ?? {}, 'parentId')) return json(res, 200, { folder: await moveFolder(parts[2], body.parentId || null) });
        return json(res, 200, { folder: await renameFolder(parts[2], body.name) });
      }
      if (parts.length === 3 && req.method === 'DELETE') return json(res, 200, { projects: await deleteFolder(parts[2]) });
    }
    if (parts.length === 3 && parts[2] === 'folder' && req.method === 'PUT') {
      const { folderId = null } = /** @type {{ folderId?: string | null }} */ (await readJson(req));
      return json(res, 200, { project: await moveProjectToFolder(parts[1], folderId || null) });
    }
    /* a project whose folder was moved: the folder it is in now (projects.mjs locateProject) */
    if (parts.length === 3 && parts[2] === 'locate' && req.method === 'POST') {
      const { path: folder } = /** @type {{ path?: string }} */ (await readJson(req));
      if (typeof folder !== 'string' || !isAbsolute(folder)) throw new HttpError(400, 'the folder\'s full path, please');
      return json(res, 200, { project: await locateProject(parts[1], folder) });
    }
    const project = await projectById(parts[1]);
    const rest = parts.slice(2).join('/');
    /* a project whose folder is gone (moved, renamed or deleted outside Studio): taking it off the list is all there is */
    if (!existsSync(project.path) && !(!rest && req.method === 'DELETE')) {
      throw new HttpError(410, 'This project’s folder is not there any more: it was moved, renamed or deleted.', { code: 'missing' });
    }
    /* ── the project's MCP endpoint: the controlled tools an ACP agent uses (mcp.mjs) ── */
    if (rest === 'mcp') {
      if (req.method !== 'POST') throw new HttpError(405, 'MCP uses POST');
      return handleMcpRequest(req, res, { project, semanticIndex });
    }
    /* ── the project's semantic index (semantic-index.mjs) ── */
    if (rest === 'index' && req.method === 'GET') return json(res, 200, await semanticIndex.status(project));
    if (rest === 'index/root' && req.method === 'PUT') {
      const body = /** @type {{ path?: unknown }} */ (await readJson(req) ?? {});
      if (typeof body.path !== 'string' || !isAbsolute(body.path)) throw new HttpError(400, 'an absolute folder is required');
      await semanticIndex.changeGlobalRoot(body.path);
      return json(res, 200, await semanticIndex.status(project));
    }
    if (rest === 'index/stores' && req.method === 'PUT') {
      const body = /** @type {{ stores?: unknown }} */ (await readJson(req) ?? {});
      const stores = Array.isArray(body.stores) ? body.stores.map(String) : [];
      semanticIndex.setProjectStores(project, stores);
      return json(res, 200, await semanticIndex.status(project));
    }
    if (rest === 'index' && req.method === 'DELETE') {
      await semanticIndex.removeProjectIndex(project);
      return json(res, 200, {});
    }
    if (rest === 'index/jobs' && req.method === 'POST') {
      const body = /** @type {any} */ (await readJson(req));
      return json(res, 200, await semanticIndex.startProjectJob(project, body));
    }
    if (rest === 'index/search' && req.method === 'POST') {
      const body = /** @type {any} */ (await readJson(req, 24 << 20));
      return json(res, 200, await semanticIndex.search(project, body));
    }
    /* ── storyboard: draft, match, proposals and handoff (storyboard.mjs) ── */
    if (rest === 'storyboard' && req.method === 'GET') return json(res, 200, { storyboard: readStoryboard(project) });
    if (rest === 'storyboard' && req.method === 'PUT') {
      const body = /** @type {{ storyboard?: unknown, baseRevision?: unknown }} */ (await readJson(req) ?? {});
      if (!body.storyboard || typeof body.storyboard !== 'object') throw new HttpError(400, 'storyboard is required');
      const base = typeof body.baseRevision === 'number' ? body.baseRevision : undefined;
      return json(res, 200, { storyboard: await saveStoryboard(project, body.storyboard, base) });
    }
    if (rest === 'storyboard/run' && req.method === 'GET') return json(res, 200, { run: publicRun(readRun(project)) });
    if (rest === 'storyboard/run' && req.method === 'POST') {
      const body = /** @type {{ text?: unknown, prompt?: unknown, brief?: unknown, handoff?: unknown }} */ (await readJson(req, 24 << 20) ?? {});
      const existing = readRun(project);
      if (existing.state === 'running') throw new HttpError(409, '分镜流水线正在运行');
      const input = {
        text: typeof body.text === 'string' ? body.text.slice(0, 120_000) : '',
        prompt: typeof body.prompt === 'string' ? body.prompt.slice(0, 4000) : '',
        brief: body.brief && typeof body.brief === 'object' ? /** @type {any} */ (body.brief) : {},
        ...(body.handoff === true ? { handoff: true } : {}),
      };
      if (!input.text.trim() && !input.prompt.trim() && !readStoryboard(project).shots.length) throw new HttpError(400, 'a script or a prompt is required');
      if (!agentReady('storyboard')) throw new HttpError(409, '没有可用的分镜 Agent。请先在设置中绑定分镜智能体的模型。');
      const run = emptyRun();
      run.id = `pipeline_${Date.now().toString(36)}`;
      run.state = 'running';
      run.steps = PIPELINE_STEPS.map((item) => ({ ...item, state: 'idle' }));
      await writeRun(project, run);
      void runRoughcutPipeline(project, input, semanticIndex, run);
      return json(res, 200, { run: publicRun(run) });
    }
    if (rest === 'storyboard/run/cancel' && req.method === 'POST') {
      const run = readRun(project);
      if (run.state === 'running') {
        run.cancelRequested = true;
        await writeRun(project, run);
      }
      return json(res, 200, { run: publicRun(run) });
    }
    if (rest === 'storyboard/run/retry' && req.method === 'POST') {
      const run = readRun(project);
      if (run.state === 'running') throw new HttpError(409, '分镜流水线正在运行');
      if (!run.plan) throw new HttpError(409, '这次运行还没有可重试的计划');
      run.cancelRequested = false;
      run.state = 'running';
      run.finishedAt = null;
      run.error = '';
      await writeRun(project, run);
      void retryPlan(project, run, {
        buildStoryboard: (raw, brief) => aiStoryboard(project, raw, brief),
        reviewShot,
      }, semanticIndex);
      return json(res, 200, { run: publicRun(run) });
    }
    if (rest === 'storyboard/run/undo' && req.method === 'POST') {
      const previous = readUndo(project);
      if (!previous) throw new HttpError(404, '没有可撤销的 AI 连续性修改');
      const current = readStoryboard(project);
      const saved = await saveStoryboard(project, previous, current.revision);
      await clearUndo(project);
      return json(res, 200, { storyboard: saved });
    }
    if (rest === 'storyboard/generate' && req.method === 'POST') {
      const body = /** @type {{ text?: unknown, prompt?: unknown, brief?: unknown }} */ (await readJson(req, 24 << 20) ?? {});
      const input = {
        text: typeof body.text === 'string' ? body.text : '',
        prompt: typeof body.prompt === 'string' ? body.prompt : '',
        brief: body.brief && typeof body.brief === 'object' ? /** @type {any} */ (body.brief) : {},
      };
      const existing = readStoryboard(project);
      if (!input.text.trim() && !input.prompt.trim() && !existing.shots.length) throw new HttpError(400, 'a script or a prompt is required');
      if (!agentReady('storyboard')) throw new HttpError(409, '没有可用的分镜 Agent。请先在设置中绑定分镜智能体的模型。');
      const result = await callAgent('storyboard', [
        {
          role: 'user',
          content: [
            input.text ? `SCRIPT:\n${input.text}` : '',
            input.prompt ? `IDEA:\n${input.prompt}` : '',
            existing.shots.length ? `EXISTING STORYBOARD:\n${JSON.stringify({ title: existing.title, brief: existing.brief, scenes: existing.scenes, shots: existing.shots }).slice(0, 120_000)}` : '',
            `BRIEF:\n${JSON.stringify(input.brief)}`,
            `Return only JSON matching: ${storyboardSchemaHint()}. Give each shot a deliberately different targetMs (1-12s) according to its dramatic importance, action and line length; do not give every shot the same length. The sum should match the brief duration. Make a shootable storyboard from existing footage, with explicit visual requirements.`,
          ].filter(Boolean).join('\n\n'),
        },
      ], { project });
      const storyboard = aiStoryboard(project, parseJsonReply(result), input.brief);
      const saved = await saveStoryboard(project, storyboard, existing.revision);
      return json(res, 200, { storyboard: saved, source: 'ai' });
    }
    if (rest === 'storyboard/match' && req.method === 'POST') {
      const body = /** @type {{ shotIds?: unknown, topK?: unknown }} */ (await readJson(req) ?? {});
      /* The material agent is optional: when configured it rewrites a shot into search words, and any
         failure falls back inside matchStoryboard to the shot's own visual intent. */
      const planQuery = agentReady('material') ? materialQueryPlanner(project) : null;
      const saved = await matchStoryboardTool(project, semanticIndex, { ...body, topK: body.topK ?? readPrefs().storyboard.candidateCount }, planQuery);
      return json(res, 200, { storyboard: saved.storyboard });
    }
    if (rest === 'storyboard/fill' && req.method === 'POST') {
      const body = /** @type {{ shotId?: unknown, prompt?: unknown, duration?: unknown }} */ (await readJson(req) ?? {});
      const made = await fillStoryboardTool(project, body);
      return json(res, 200, { storyboard: made.storyboard, path: made.path });
    }
    const chatScope = (/** @type {unknown} */ value) => value === 'edit' ? /** @type {'edit'} */ ('edit') : value === 'audio' ? /** @type {'audio'} */ ('audio') : /** @type {'storyboard'} */ ('storyboard');
    if (rest === 'agent/chat' && req.method === 'GET') {
      const scope = chatScope(url.searchParams.get('scope'));
      return json(res, 200, { messages: await readAgentChat(project, scope) });
    }
    if (rest === 'agent/chat' && req.method === 'DELETE') {
      const scope = chatScope(url.searchParams.get('scope'));
      await clearAgentChat(project, scope);
      return json(res, 200, { messages: [] });
    }
    if (rest === 'agent/chat' && req.method === 'POST') {
      const body = /** @type {{ text?: unknown, selectedIds?: unknown, selectedClipIds?: unknown, scope?: unknown }} */ (await readJson(req) ?? {});
      const instruction = typeof body.text === 'string' ? body.text.trim() : '';
      if (!instruction) throw new HttpError(400, 'instruction is required');
      const scope = chatScope(body.scope);
      const chatAbort = new AbortController();
      res.once('close', () => chatAbort.abort());
      /* The conversation remembers prior turns per scope. The current message is recorded even
         if the model fails, so switching stages never loses what the person typed. */
      const history = await readAgentChat(project, scope);
      await appendAgentChat(project, scope, { role: 'user', text: instruction });
      const recordReply = async (/** @type {string} */ reply) => {
        await appendAgentChat(project, scope, { role: 'agent', text: reply.slice(0, 20_000) });
      };
      /* Audio has its own agent and scope; its tools read the sound library and write the same
         native timeline as the edit stage. */
      if (scope === 'audio') {
        const film = await readProjectFilm(project.path);
        const listing = await listFiles(project.path);
        const selectedClipIds = Array.isArray(body.selectedClipIds) ? body.selectedClipIds.map(String).slice(0, 200) : [];
        const turn = await conversationReact(project, {
          text: instruction,
          scope: 'audio',
          history,
          selectedIds: selectedClipIds,
          context: editContext(film, selectedClipIds, listing),
          signal: chatAbort.signal,
        }, semanticIndex);
        await recordReply([turn.reply, turn.question].filter(Boolean).join('\n\n'));
        return json(res, 200, turn);
      }
      /* The edit stage applies validated timeline operations immediately; the storyboard stage
         writes through its own tools. */
      if (scope === 'edit') {
        const film = await readProjectFilm(project.path);
        const listing = await listFiles(project.path);
        const selectedClipIds = Array.isArray(body.selectedClipIds) ? body.selectedClipIds.map(String).slice(0, 200) : [];
        const turn = await conversationReact(project, {
          text: instruction,
          scope: 'edit',
          history,
          selectedIds: selectedClipIds,
          context: editContext(film, selectedClipIds, listing),
          signal: chatAbort.signal,
        }, semanticIndex);
        await recordReply([turn.reply, turn.question].filter(Boolean).join('\n\n'));
        return json(res, 200, turn);
      }
      const current = readStoryboard(project);
      const selected = Array.isArray(body.selectedIds) ? body.selectedIds.map(String) : [];
      /* Candidate descriptions are lazy, but a candidate sent to the conversation is being referenced:
         make its description now if it has none, then send it with the context. */
      const knownDescriptions = await descriptionsFor(project.id).catch(() => /** @type {Record<string, string>} */ ({}));
      /** @type {{ libraryId: string, path: string, name: string, kind: string, thumbUrl?: string }[]} */
      const referenced = [];
      const seenAssets = new Set();
      const addReference = (/** @type {any} */ candidate) => {
        if (!candidate?.path) return;
        const key = `${candidate.libraryId ?? project.id}\u0000${candidate.path}`;
        if (seenAssets.has(key)) return;
        seenAssets.add(key);
        referenced.push({ libraryId: candidate.libraryId ?? project.id, path: candidate.path, name: candidate.name ?? basename(candidate.path), kind: candidate.kind ?? clipKind(candidate.path) ?? '', ...(candidate.thumbUrl ? { thumbUrl: candidate.thumbUrl } : {}) });
      };
      for (const shot of current.shots.filter((item) => selected.includes(item.id))) {
        addReference(shot.match.candidates.find((item) => item.id === shot.match.selectedId) ?? shot.match.candidates[0]);
      }
      /* Naming a material in the instruction is also a reference: describe it before the model sees it. */
      for (const shot of current.shots) {
        for (const candidate of shot.match.candidates) {
          if (instruction.includes(candidate.name) || instruction.includes(candidate.name.replace(/\.[^.]+$/, ''))) addReference(candidate);
        }
      }
      for (const reference of referenced) {
        if (knownDescriptions[reference.path] || !agentReady('qc')) continue;
        const desc = await ensureAssetDescription(project, reference, semanticIndex, { base: pages.folderUrl(project) }).catch(() => null);
        if (desc) knownDescriptions[reference.path] = desc;
      }
      /* Clear structural intents are deterministic. Run them before the model so a prompt or a
         weak reply cannot turn "remove duplicates" or "keep the first three shots" into prose. */
      const quick = localProposal(current, instruction);
      const deterministic = /(重复|雷同|去重|保持\s*开头|保留\s*开头|第?\s*\d+\s*(?:镜|个镜头)\s*(?:加长|延长|缩短))/.test(instruction);
      if (deterministic) {
        await recordReply(quick.reply);
        return json(res, 200, {
          reply: quick.reply,
          operations: quick.operations,
          proposal: { id: `proposal_${Date.now().toString(36)}`, baseRevision: current.revision, source: 'local' },
          ...(quick.intent ? { intent: quick.intent } : {}),
        });
      }
      if (agentReady('storyboard')) {
        const context = storyboardContext(current, selected, knownDescriptions);
        const turn = await conversationReact(project, {
          text: instruction,
          scope: 'storyboard',
          history,
          selectedIds: selected,
          context,
          signal: chatAbort.signal,
        }, semanticIndex);
        await recordReply([turn.reply, turn.question].filter(Boolean).join('\n\n'));
        return json(res, 200, turn);
      }
      const local = localProposal(current, instruction);
      await recordReply(local.reply);
      return json(res, 200, {
        reply: local.reply,
        operations: local.operations,
        proposal: { id: `proposal_${Date.now().toString(36)}`, baseRevision: current.revision, source: 'local' },
        ...(local.intent ? { intent: local.intent } : {}),
      });
    }
    if (rest === 'storyboard/apply' && req.method === 'POST') {
      const body = /** @type {{ baseRevision?: unknown, operations?: unknown }} */ (await readJson(req) ?? {});
      const current = readStoryboard(project);
      if (typeof body.baseRevision === 'number' && body.baseRevision !== current.revision) {
        throw new HttpError(409, 'This storyboard changed in another window. Reload it before applying.', { revision: current.revision });
      }
      const next = applyOperations(current, body.operations);
      return json(res, 200, { storyboard: await saveStoryboard(project, next, current.revision) });
    }
    if (rest === 'asset-descriptions') {
      if (req.method === 'GET') return json(res, 200, { descriptions: await descriptionsFor(project.id) });
      if (req.method === 'POST') {
        const body = /** @type {{ path?: unknown, regenerate?: unknown }} */ (await readJson(req) ?? {});
        const path = String(body.path ?? '');
        if (!path) throw new HttpError(400, 'which material?');
        inside(project.path, path, { read: true });
        const desc = await ensureAssetDescription(project, {
          libraryId: project.id,
          path,
          name: basename(path),
          kind: clipKind(path) ?? '',
        }, semanticIndex, { regenerate: body.regenerate === true, base: pages.folderUrl(project) });
        if (!desc) throw new HttpError(409, '没有可用的视觉模型，或这个素材没有可读画面');
        return json(res, 200, { desc });
      }
      throw new HttpError(405, 'use GET or POST');
    }
    if (rest === 'storyboard/handoff' && req.method === 'POST') {
      const current = readStoryboard(project);
      const { clips, gaps } = handoffClips(current);
      if (!clips.length) throw new HttpError(409, 'no matched shot to make a rough cut from');
      current.handedOffAt = Date.now();
      current.roughcut = { createdAt: Date.now(), durationMs: clips.reduce((sum, clip) => sum + clip.durationMs, 0), clips, gaps };
      return json(res, 200, { storyboard: await saveStoryboard(project, current, current.revision), clips, gaps });
    }
    /* ── the sound stage: current audio, local/network sources, TTS/music/SFX, native timeline edits (audio.mjs) ── */
    if (await audioRoutes(req, res, project, rest, {
      folderUrl: pages.folderUrl(project),
      emit: (event) => watchers.emit(project.path, /** @type {any} */ (event)),
    })) return;
    /* ── subtitles: the film's lines, the person's subtitle style, translation (see captions.mjs) ── */
    if (await captionRoutes(req, res, project.path, rest, { translate: subtitleTranslator, transcribe: await subtitleTranscriber() })) return;
    /* ── end subtitles ── */
    /* the editor's settings of the project: its frame rate, its tracks' names (see project-settings.mjs) */
    if (await projectSettingsRoute(req, res, project.path, rest)) return;
    /* its markers (markers.mjs): Studio's own, beside film.html */
    if (await markersRoute(req, res, project.path, rest)) return;
    /* the page under a dip to white, kept once (transition-pages.mjs) */
    if (await transitionPageRoutes(req, res, project.path, rest)) return;
    if (!rest) {
      /* `folder`: the project's files on the film's origin, where the preview loads them */
      if (req.method === 'GET') {
        const film = await readProjectFilm(project.path);
        /* opened: its card in the projects list gets a picture before the list first shows it */
        if (film.doc?.tracks.some((t) => t.clips.length)) warmFilmPoster(project.path, pages.folderUrl(project));
        return json(res, 200, { project, folder: pages.folderUrl(project), ...film });
      }
      if (req.method === 'PATCH') {
        const { name } = /** @type {{ name?: string }} */ (await readJson(req));
        if (agentIn(project.path)) throw new HttpError(409, 'An agent is running in this project: stop it first, then rename the project.', { code: 'agent-running' });
        if (exports.list(project.id).some((job) => job.status === 'waiting' || job.status === 'running')) {
          throw new HttpError(409, 'An export is queued or running in this project: wait for it to finish or stop it first, then rename the project.', { code: 'export-running' });
        }
        await semanticIndex.removeProjectLibrary(project);
        const renamed = await renameProject(project.id, String(name ?? ''));
        if (renamed.path !== project.path || renamed.name !== project.name) {
          watchers.move(project.path, renamed.path);
          exportRoots.set(project.id, renamed.path);
          /* its address stays: the preview open on it keeps loading from the folder by its new name */
          pages.folderUrl(renamed);
          /* the pages showing it (renamed from another tab, or the projects list) take the new name */
          watchers.emit(renamed.path, { type: 'project', project: renamed });
          /* Reload changes waiting to settle when the old watcher closed. A blank revision also refreshes
             an unchanged film, but only for this project after an actual rename. */
          watchers.emit(renamed.path, { type: 'film', rev: '' });
          watchers.emit(renamed.path, { type: 'files' });
          watchers.emit(renamed.path, { type: 'history' });
        }
        return json(res, 200, { project: renamed });
      }
      /* the project is deleted: its folder goes to the Trash (pages showing it go back to the list) */
      if (req.method === 'DELETE') {
        /* its files are being written, and its chat is mid-turn: stopped first, by the person */
        if (agentIn(project.path)) throw new HttpError(409, 'An agent is running in this project: stop it first, then delete the project.', { code: 'agent-running' });
        await semanticIndex.removeProjectLibrary(project);
        await deleteProject(project.id);
        /* every page showing it leaves it (with tabs, its tab closes) */
        watchers.emit(project.path, { type: 'gone' });
        return json(res, 200, {});
      }
    }
    /* an editor page shows it: the person opened it, so it is the one `openfilm open` alone comes back to */
    if (rest === 'opened' && req.method === 'POST') return json(res, 200, { project: await markOpened(project.id) });
    /* the fonts its pages declare with @font-face, and with `page` (a project path) the families that page can draw with
       and names (project-fonts.mjs): the font menu's "In this project" */
    if (rest === 'fonts' && req.method === 'GET') {
      const page = url.searchParams.get('page');
      return json(res, 200, await projectFonts(project.path, page ? resolveIn('', page) : null));
    }
    /* ── version history: git, every change of it the person's (history.mjs) ──
         GET    history                          → { status, commits }: the branch checked out, the branches, the
                                                   uncommitted changes, the film's files against the folder's, and
                                                   the commits of the branch, newest first
         GET    history/files                    → { held, ignored }: the film's files, and the others (never kept)
         GET    history/poster/:commit           the film's picture when it was committed (404: none was taken)
         POST   history/commit    { message }    commit the uncommitted changes
         POST   history/discard                  put the film back as the last commit holds it
         POST   history/restore   { commit }     the film as a commit holds it, as uncommitted changes
         POST   history/checkout  { branch, create?, from?, carry? }   check out a branch (or make one)
         PATCH  history/branches/:name { name }  rename a branch
         DELETE history/branches/:name[?force=1] delete one
         POST   history/merge     { branch, message, prefer? }          merge a branch into the one checked out
       Every change tells the project's pages ({ type: 'history' }); one that changed the folder, the film too. While
       one runs, they hear how far it is ({ type: 'history-progress', op, phase, done, total }). */
    if (parts[2] === 'history') {
      const history = parts.slice(3);
      const changed = () => watchers.emit(project.path, { type: 'history' });
      /** @param {string} op */
      const onProgress = (op) => (/** @type {{ phase: string, done: number, total: number }} */ p) => watchers.emit(project.path, { type: 'history-progress', op, ...p });
      if (!history.length && req.method === 'GET') {
        const [state, commits] = await Promise.all([historyStatus(project.path, { onProgress: onProgress('load') }), log(project.path)]);
        return json(res, 200, { status: state, commits });
      }
      if (history[0] === 'files' && history.length === 1 && req.method === 'GET') return json(res, 200, await historyFiles(project.path));
      if (history[0] === 'poster' && history.length === 2 && req.method === 'GET') {
        if (!/^[0-9a-f]{40}$/.test(history[1])) throw new HttpError(400, 'which commit?');
        const jpeg = await readFile(join(project.path, TOOL_DIR, 'cache', 'commits', `${history[1]}.jpg`)).catch(() => null);
        if (!jpeg) throw new HttpError(404, 'no picture of that commit');
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable', 'content-length': jpeg.length });
        return res.end(jpeg);
      }
      if (history[0] === 'commit' && req.method === 'POST') {
        const { message } = /** @type {{ message?: string }} */ (await readJson(req));
        const sha = await commitChanges(project.path, String(message ?? ''), { onProgress: onProgress('commit') });
        changed();
        /* the film's picture as it was committed, for the commit's card: drawn after the answer (it takes a moment) */
        void pageFrame(project.path, pages.folderUrl(project), FILM_PAGE, -1, 480)
          .then(async (jpeg) => {
            const dir = join(project.path, TOOL_DIR, 'cache', 'commits');
            await mkdir(dir, { recursive: true });
            await writeAtomic(join(dir, `${sha}.jpg`), jpeg);
          })
          .then(changed, () => {});
        return json(res, 200, { commit: sha });
      }
      if (history[0] === 'discard' && req.method === 'POST') {
        await discardChanges(project.path, { onProgress: onProgress('discard') });
        changed();
        return json(res, 200, await readProjectFilm(project.path));
      }
      if (history[0] === 'restore' && req.method === 'POST') {
        const { commit: target } = /** @type {{ commit?: string }} */ (await readJson(req));
        const { missing } = await restoreCommit(project.path, String(target ?? ''), { onProgress: onProgress('restore') });
        changed();
        /* `missing`: media of that version history no longer has (left as it is in the folder) */
        return json(res, 200, { missing, ...(await readProjectFilm(project.path)) });
      }
      if (history[0] === 'checkout' && req.method === 'POST') {
        const { branch, create, from, carry } = /** @type {{ branch?: string, create?: boolean, from?: string, carry?: 'leave' | 'bring' }} */ (await readJson(req));
        const back = await checkout(project.path, { target: String(branch ?? ''), create: create === true, ...(from ? { from: String(from) } : {}), carry: carry === 'bring' ? 'bring' : 'leave', onProgress: onProgress('checkout') });
        changed();
        /* `parkedBack` false: the changes left on that branch collide with it now and stay put away */
        return json(res, 200, { parkedBack: back, ...(await readProjectFilm(project.path)) });
      }
      if (history[0] === 'branches' && history.length === 2) {
        if (req.method === 'PATCH') {
          const { name } = /** @type {{ name?: string }} */ (await readJson(req));
          const renamed = await renameBranch(project.path, history[1], String(name ?? ''));
          changed();
          return json(res, 200, { name: renamed });
        }
        if (req.method === 'DELETE') {
          await deleteBranch(project.path, history[1], { force: url.searchParams.get('force') === '1' });
          changed();
          return json(res, 200, {});
        }
      }
      if (history[0] === 'merge' && req.method === 'POST') {
        const { branch, message, prefer } = /** @type {{ branch?: string, message?: string, prefer?: string }} */ (await readJson(req));
        const merged = await mergeBranch(project.path, { branch: String(branch ?? ''), message: String(message ?? ''), ...(prefer === 'ours' || prefer === 'theirs' ? { prefer } : {}), onProgress: onProgress('merge') });
        changed();
        return json(res, 200, { merged, ...(await readProjectFilm(project.path)) });
      }
      throw new HttpError(404, 'no such history action');
    }
    if (rest === 'edit' && req.method === 'POST') {
      const { base = null, ops } = /** @type {{ base?: string | null, ops?: import('./film.mjs').Op[] }} */ (await readJson(req));
      try {
        return json(res, 200, await editProjectFilm(project.path, base, ops ?? []));
      } catch (e) {
        if (!(e instanceof EditError)) throw e;
        /* the person's view is out of date or the edit cannot be: send the film as it is now with the reason */
        const now = await readProjectFilm(project.path);
        throw new HttpError(e.kind === 'conflict' ? 409 : 422, e.message, { rev: now.rev, doc: now.doc });
      }
    }
    /* a video's sound, made a file of its own beside it (files.mjs extractAudio) */
    if (rest === 'files/audio' && req.method === 'POST') {
      const { path: from } = /** @type {{ path?: string }} */ (await readJson(req));
      return json(res, 200, { path: await extractAudio(project.path, String(from ?? '')) });
    }
    /* files or folders of this computer copied in (cloned where the disk can) or linked (files.mjs bringIn): the paths
       given (the desktop app knows a dropped file's), else the person's pick in the system's dialog. { landed } */
    if (rest === 'files/bring' && req.method === 'POST') {
      const { into, mode, paths, folder, title } = /** @type {{ into?: unknown, mode?: unknown, paths?: unknown, folder?: unknown, title?: unknown }} */ (await readJson(req));
      const how = mode === 'link' ? 'link' : 'copy';
      const ask = { title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : 'Choose', at: null };
      const picked = Array.isArray(paths) ? paths.map(String)
        : await (folder === true ? pickFolder(ask).then((p) => (p ? [p] : [])) : pickFiles(ask)).catch((e) => { throw new HttpError(501, String(e?.message ?? e)); });
      return json(res, 200, { landed: await bringIn(project.path, String(into ?? 'assets'), picked, how) });
    }
    /* a link pointed somewhere else (files.mjs relink): the path given, else the person's pick. { path } (null: cancelled) */
    if (rest === 'files/relink' && req.method === 'POST') {
      const { path: rel, to, folder, title } = /** @type {{ path?: unknown, to?: unknown, folder?: unknown, title?: unknown }} */ (await readJson(req));
      const ask = { title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 120) : 'Choose', at: null };
      const where = typeof to === 'string' ? to
        : await (folder === true ? pickFolder(ask) : pickFiles(ask).then((p) => p[0] ?? null)).catch((e) => { throw new HttpError(501, String(e?.message ?? e)); });
      return json(res, 200, { path: where ? await relink(project.path, String(rel ?? ''), where) : null });
    }
    /* the proxies the preview plays heavy footage from (proxies.mjs), asked for when not made yet: each heavy video's
       state. Off: none */
    if (rest === 'proxies' && req.method === 'POST') {
      const { proxies } = readPrefs();
      if (!proxies.on) return json(res, 200, { on: false, height: proxies.height, states: {} });
      const videos = (await listFiles(project.path)).files.filter((f) => f.kind === 'video').map((f) => f.path);
      return json(res, 200, { on: true, height: proxies.height, states: await ensureProxies(project.path, videos, proxies.height) });
    }
    /* renders of the stretches the preview played late (preview-cache.mjs), asked for when not made yet: each one's
       name and state, at the proxies' size */
    if (rest === 'preview-cache' && (req.method === 'POST' || req.method === 'GET')) {
      /* GET: the stretches known to play late (from an earlier session) and theirs */
      const { ranges, fps } = /** @type {{ ranges?: unknown, fps?: unknown }} */ (req.method === 'GET'
        ? { ranges: knownLate(project.path), fps: url.searchParams.get('fps') }
        : await readJson(req));
      const rate = Number(fps);
      const list = Array.isArray(ranges) ? ranges.filter((r) => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite) && r[1] > r[0] && r[0] >= 0).slice(0, 50) : [];
      if (!(rate > 0 && rate <= 240)) throw new HttpError(400, 'fps: a frame rate');
      const { proxies } = readPrefs();
      return json(res, 200, { late: list, ranges: list.length ? ensurePreviews(project.path, /** @type {[number, number][]} */ (list), rate, proxies.height) : [] });
    }
    /* what a link leads to copied into the project in its place (files.mjs collect) */
    if (rest === 'files/collect' && req.method === 'POST') {
      const { path: rel } = /** @type {{ path?: unknown }} */ (await readJson(req));
      return json(res, 200, { path: await collect(project.path, String(rel ?? '')) });
    }
    /* a video's frame made a still beside it (files.mjs freezeFrame): the timeline's freeze frame */
    if (rest === 'files/still' && req.method === 'POST') {
      const { path: from, ms } = /** @type {{ path?: string, ms?: number }} */ (await readJson(req));
      return json(res, 200, { path: await freezeFrame(project.path, String(from ?? ''), Number(ms)) });
    }
    if (rest === 'files') {
      const at = url.searchParams.get('path') ?? '';
      if (req.method === 'GET') {
        const listing = await listFiles(project.path);
        const descs = await descriptionsFor(project.id).catch(() => /** @type {Record<string, string>} */ ({}));
        return json(res, 200, {
          ...listing,
          files: listing.files.map((file) => ({ ...file, ...(descs[file.path] ? { desc: descs[file.path] } : {}) })),
          pages: listing.pages.map((page) => ({ ...page, ...(descs[page.path] ? { desc: descs[page.path] } : {}) })),
        });
      }
      /* the body is the file itself, streamed to disk: an import of any size */
      if (req.method === 'PUT') {
        const { path: landed } = await importFile(project.path, at, req);
        /* a picture, video or sound that cannot be read (a broken or mislabelled file) is kept, and said: it would
           only fail later, as a blank tile or a clip that never plays. Read as the kind its ending says: a picture
           or a video with no picture in it (a size of 0), a sound with no sound */
        const kind = isPage(landed) ? null : clipKind(landed);
        const unreadable = kind
          ? await probe(project.path, landed).then(
            (/** @type {{ width?: number, height?: number, audio?: boolean }} */ facts) => (kind === 'sound'
              ? (facts.audio ? null : 'there is no sound in it')
              : (Number(facts.width) > 0 && Number(facts.height) > 0 ? null : 'there is no picture in it')),
            (e) => (e instanceof MediaError && e.status !== 501 ? e.message : null))
          : null;
        return json(res, 200, { path: landed, ...(unreadable ? { unreadable } : {}) });
      }
      if (req.method === 'PATCH') {
        const { from, to, check } = /** @type {{ from?: string, to?: string, check?: boolean }} */ (await readJson(req));
        /* `check`: what the move could not keep true (paths a page makes while it runs), nothing moved */
        if (check === true) return json(res, 200, { unseen: await moveCheck(project.path, String(from ?? ''), String(to ?? '')) });
        return json(res, 200, await moveFile(project.path, String(from ?? ''), String(to ?? '')));
      }
      if (req.method === 'DELETE') {
        await trashFile(project.path, at);
        return json(res, 200, {});
      }
    }
    /* clips, groups of clips and files of this project put in Saved (saved.mjs), each bundle with its picture; and a
       thing of Saved taken into this project (a file imported, a bundle's files copied in) */
    if (rest === 'saved' && req.method === 'POST') {
      const body = /** @type {{ clips?: unknown, groups?: unknown, files?: unknown, into?: unknown }} */ (await readJson(req) ?? {});
      const asked = (/** @type {unknown} */ list) => (Array.isArray(list) ? list.filter((x) => x && typeof x === 'object').slice(0, 50) : []);
      const into = typeof body.into === 'string' ? body.into : undefined;
      const base = pages.folderUrl(project);
      const paths = await savedCall(async () => {
        const out = [];
        for (const c of /** @type {{ id?: unknown, name?: string, durationMs?: number, w?: number, h?: number }[]} */ (asked(body.clips))) {
          const ms = typeof c.durationMs === 'number' && c.durationMs > 0 ? c.durationMs : 0;
          out.push(await saveClip(project.path, String(c.id ?? ''), { ...c, into, poster: (clip) => clipPoster(project.path, base, clip, ms) }));
        }
        for (const g of /** @type {{ ids?: unknown, name?: string, durationMs?: number, w?: number, h?: number }[]} */ (asked(body.groups))) {
          const ids = Array.isArray(g.ids) ? g.ids.filter((id) => typeof id === 'string').slice(0, 200) : [];
          out.push(await saveGroup(project.path, ids, { ...g, into, poster: (clip) => clipPoster(project.path, base, clip, 0) }));
        }
        for (const f of /** @type {{ path?: unknown, name?: string, durationMs?: number, w?: number, h?: number }[]} */ (asked(body.files))) {
          const file = String(f.path ?? '');
          out.push(await saveFile(project.path, file, { ...f, into, poster: () => clipPoster(project.path, base, { src: file }, typeof f.durationMs === 'number' ? f.durationMs : 0) }));
        }
        return out;
      });
      return json(res, 200, { paths });
    }
    if (rest === 'saved/take' && req.method === 'POST') {
      const { path: from } = /** @type {{ path?: unknown }} */ (await readJson(req) ?? {});
      return json(res, 200, await savedCall(() => takeSaved(project.path, from)));
    }
    /* what Studio works out from a media file: its length and size, a poster, a frame, a waveform (see derived.mjs) */
    if (rest === 'media' && req.method === 'GET') {
      const at = url.searchParams.get('path') ?? '';
      const what = url.searchParams.get('what');
      /* the file itself, to save (the media library's "export shots"): streamed as it is, not read into memory */
      if (what === 'file') {
        const abs = readable(project.path, at);
        const name = basename(abs);
        const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
        const rfc = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
        res.setHeader('content-disposition', `attachment; filename="${fallback}"; filename*=UTF-8''${rfc}`);
        return sendMedia(req, res, abs);
      }
      /* a web page says its own length and size (none: it has no end) */
      if (what === 'probe' && isPage(at)) {
        return json(res, 200, await pageFacts(project.path, pages.folderUrl(project), at).catch((e) => {
          throw new HttpError(e instanceof PageFrameError ? 404 : 422, String(e?.message ?? e));
        }));
      }
      if (what === 'probe') return json(res, 200, await probe(project.path, at));
      if (what === 'wave') return json(res, 200, await waveform(project.path, at));
      /* the loudness of a part of its sound (`from`, `to`: its own seconds): what "Normalize loudness" sets volumes by */
      if (what === 'loudness') {
        const to = url.searchParams.get('to');
        return json(res, 200, await loudness(project.path, at, Number(url.searchParams.get('from') ?? 0), to == null ? undefined : Number(to)));
      }
      /* a web page has no file to cut a frame from: it is drawn, as an export draws it (pageframes.mjs); a page clip's
         frame (`clip`, its id) with the person's changes in it, as the film shows them */
      const clipId = what === 'frame' ? url.searchParams.get('clip') : null;
      const look = clipId && isPage(at) ? await pageClipLook(project.path, clipId) : null;
      const page = isPage(at) && (what === 'poster' || what === 'frame')
        ? () => pageFrame(project.path, pages.folderUrl(project), at, what === 'poster' ? -1 : Number(url.searchParams.get('ms')), what === 'poster' ? 480 : Number(url.searchParams.get('w')), look?.overrides ?? null, look?.size ?? null).catch((e) => {
          throw new HttpError(e instanceof PageFrameError ? 404 : 422, String(e?.message ?? e));
        })
        : null;
      const jpeg = page ? await page()
        : what === 'poster' ? await poster(project.path, at)
        : what === 'frame' ? await frame(project.path, at, Number(url.searchParams.get('ms')), Number(url.searchParams.get('w')))
        : null;
      if (!jpeg) throw new HttpError(400, 'what: probe, poster, frame, wave or loudness');
      /* a media file's frame: the address names the file's version (the page adds its mtime), so the browser keeps
         it. A page's: it changes with any file the page loads, which the address cannot say, so it is asked again
         each time, an unchanged one answered in a word (304) */
      if (page) {
        const tag = `"${createHash('sha1').update(jpeg).digest('hex').slice(0, 16)}"`;
        if (req.headers['if-none-match'] === tag) { res.writeHead(304, { etag: tag, 'cache-control': 'private, no-cache' }); return res.end(); }
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, no-cache', etag: tag, 'content-length': jpeg.length });
        return res.end(jpeg);
      }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400', 'content-length': jpeg.length });
      return res.end(jpeg);
    }
    /* exports (what one asks: see exports.mjs). GET also says where they go by default, what this machine encodes and
       how many subtitle cues the film has (the subtitle choices need some), and how big the project and its parts are */
    if (rest === 'exports') {
      if (req.method === 'GET') {
        return json(res, 200, { exports: exports.list(project.id), folder: exportsRoot(), can: await exportCapabilities(), drafts: draftApps(), subtitles: await exports.subtitles(project.path), project: await projectSizes(project.path) });
      }
      if (req.method === 'POST') {
        exportRoots.set(project.id, project.path);
        const body = /** @type {any} */ (await readJson(req));
        /* several at once: `{ jobs: [ask…], folder? }` → `{ exports }`; one: the ask itself → `{ export }` */
        if (body && typeof body === 'object' && 'jobs' in body) return json(res, 200, { exports: exports.startAll(project, body) });
        return json(res, 200, { export: exports.start(project, body) });
      }
    }
    if (parts[2] === 'exports' && parts[3] && req.method === 'DELETE') {
      if (exports.list(project.id).some((j) => j.id === parts[3])) exports.cancel(parts[3]);
      return json(res, 200, {});
    }
    /* a finished export, shown where it is on the person's computer, or opened in its app */
    if (parts[2] === 'exports' && parts[3] && (parts[4] === 'reveal' || parts[4] === 'open') && req.method === 'POST') {
      const job = exports.list(project.id).find((j) => j.id === parts[3]);
      const file = job?.outputs[0];
      if (!file || !existsSync(file)) throw new HttpError(404, 'that export is not there any more');
      if (parts[4] === 'reveal') reveal(file);
      else openFile(file);
      return json(res, 200, {});
    }
    /* the project's own cover (cover.mjs): PUT a picture's bytes; POST `{ path }`, a picture of the project, or `{ ms }`,
       the film at that moment; DELETE, none of its own (the film's poster again). Answers when it was set (null: none) */
    if (rest === 'cover') {
      const set = (/** @type {{ at: number } | null} */ cover) => json(res, 200, { cover: cover?.at ?? null });
      try {
        if (req.method === 'PUT') return set(await setCover(project.path, await readCoverBody(req)));
        if (req.method === 'POST') {
          const { path: rel, ms } = /** @type {{ path?: unknown, ms?: unknown }} */ (await readJson(req));
          if (typeof rel === 'string' && rel) return set(await setCoverFromFile(project.path, readable(project.path, rel)));
          if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) {
            const jpeg = await pageFrame(project.path, pages.folderUrl(project), FILM_PAGE, ms, COVER_FRAME_W).catch((e) => {
              throw new HttpError(e instanceof PageFrameError ? 404 : 422, String(e?.message ?? e));
            });
            return set(await setCover(project.path, jpeg));
          }
          throw new HttpError(400, 'a picture of the project (path) or a moment of the film (ms)');
        }
        if (req.method === 'DELETE') {
          await clearCover(project.path);
          return set(null);
        }
      } catch (e) {
        if (e instanceof CoverError) throw new HttpError(e.status, e.message);
        throw e;
      }
    }
    /* the project's card in the projects list: its own cover, else the film's middle frame */
    if (rest === 'poster' && req.method === 'GET') {
      const cover = await readCover(project.path);
      if (cover) {
        const picture = await readFile(cover.path);
        res.writeHead(200, { 'content-type': cover.type, 'cache-control': 'private, max-age=60', 'content-length': picture.length });
        return res.end(picture);
      }
      /* a film with nothing in it yet has no picture to show (its card shows its own face, not a black frame) */
      const { doc } = await readProjectFilm(project.path);
      if (!doc?.tracks.some((t) => t.clips.length)) throw new HttpError(404, 'the film is empty');
      const jpeg = await filmPoster(project.path, pages.folderUrl(project)).catch((e) => {
        throw new HttpError(e instanceof PageFrameError ? 404 : 422, String(e?.message ?? e));
      });
      /* its first one is still being drawn: the card asks again in a while, rather than hold a connection meanwhile */
      if (!jpeg) {
        res.writeHead(503, { 'retry-after': '5', 'cache-control': 'no-store', 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'the film\'s poster is being drawn; ask again in a few seconds', code: 'drawing' }));
      }
      res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=60', 'content-length': jpeg.length });
      return res.end(jpeg);
    }
    /* a file or folder of the project, shown where it is on the person's computer */
    if (rest === 'reveal' && req.method === 'POST') {
      const { path: rel, original } = /** @type {{ path?: string, original?: boolean }} */ (await readJson(req));
      /* no path: the project's own folder; `original`: where a linked file is kept */
      const abs = !rel ? project.path : original === true ? realpathSync(readable(project.path, String(rel))) : readable(project.path, String(rel));
      if (!existsSync(abs)) throw new HttpError(404, 'that is not there any more');
      reveal(abs);
      return json(res, 200, {});
    }
    if (rest === 'folders' && req.method === 'POST') {
      const { path: folder } = /** @type {{ path?: string }} */ (await readJson(req));
      return json(res, 200, { path: await makeFolder(project.path, String(folder ?? '')) });
    }
    throw new HttpError(404, 'no such API');
  }

  const editor = createServer((req, res) => {
    if (!ownHost(req, /** @type {import('node:net').AddressInfo} */ (editor.address()).port)) { json(res, 403, { error: 'not this address' }); return; }
    route(req, res).catch((/** @type {unknown} */ e) => {
      const status = e instanceof HttpError || e instanceof ProjectError || e instanceof FileError || e instanceof HistoryError || e instanceof MediaError || e instanceof ExportError
        || e instanceof FetchError || e instanceof BrowseError ? e.status : 500;
      if (status === 500) console.error(e);
      if (res.headersSent) return res.end();
      json(res, status, { error: e instanceof Error ? e.message : String(e), ...(e instanceof HttpError ? e.extra : {}),
        ...((e instanceof ProjectError || e instanceof FetchError || e instanceof BrowseError) && e.code ? { code: e.code } : {}),
        ...(e instanceof HistoryError && e.code ? { code: e.code, ...('commits' in e ? { commits: e.commits } : {}) } : {}) });
    });
  });
  /* the streams: the key, as for the API, and only from the editor's own origin (another site's page could otherwise
     listen with the person's cookie) */
  /** the streams' sockets: not the server's connections once upgraded, so closing Studio ends them itself */
  /** @type {Set<import('node:stream').Duplex>} */
  const streamSockets = new Set();
  editor.on('upgrade', (req, socket) => {
    streamSockets.add(socket);
    socket.once('close', () => streamSockets.delete(socket));
    /* an upgraded socket is no longer the server's to watch: a page gone mid-request (a reset, a write after it left)
       would otherwise be an error no one hears, which ends Studio. That connection only is dropped */
    socket.on('error', () => socket.destroy());
    const refuse = (/** @type {string} */ status) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    if (!ownHost(req, /** @type {import('node:net').AddressInfo} */ (editor.address()).port)) return refuse('403 Forbidden');
    void (async () => {
      const path = new URL(req.url ?? '/', origin).pathname;
      const keyed = sameKey(/** @type {string | undefined} */ (req.headers['x-studio-key'])) || (sameKey(cookieKey(req)) && req.headers.origin === origin);
      if (!keyed) return refuse('401 Unauthorized');
      const parts = path.split('/').slice(1).map(decodeURIComponent);
      /** @type {() => void} */
      let stop = () => {};
      if (path === '/api/events') {
        /* in sight or not, as the page says when it connects and whenever that changes */
        const page = { visible: new URL(req.url ?? '/', origin).searchParams.get('visible') !== '0' };
        const send = acceptWebSocket(req, socket, () => stop(), (text) => {
          try { const said = JSON.parse(text); if (typeof said?.visible === 'boolean') page.visible = said.visible; } catch { /* not ours */ }
        });
        if (send) stop = editorStream(send, page);
        return;
      }
      if (parts.length === 4 && parts[0] === 'api' && parts[1] === 'projects' && parts[3] === 'events') {
        const project = await projectById(parts[2]).catch(() => null);
        if (!project || !existsSync(project.path)) return refuse('404 Not Found');
        const send = acceptWebSocket(req, socket, () => stop());
        if (send) stop = projectStream(project, send);
        return;
      }
      refuse('404 Not Found');
    })().catch(() => refuse('500 Internal Server Error'));
  });
  await new Promise((done, fail) => { editor.once('error', fail); editor.listen(port, '127.0.0.1', () => done(undefined)); });
  /* the examples index is asked for as Studio starts, so the Examples tab has GitHub's newest when it opens */
  void listExamples().catch(() => {});
  const address = /** @type {import('node:net').AddressInfo} */ (editor.address());
  origin = `http://127.0.0.1:${address.port}`;
  COOKIE = cookieName(address.port);
  FRAMED = framedCookieName(address.port);
  /* the film's port is the next one: when it is not free, the editor's is let go again, so a caller can try others */
  const pages = await startPages({ port: port ? address.port + 1 : 0, editorOrigin: () => origin, secret: key, projects: listProjects }).catch(async (e) => {
    watchers.closeAll();
    await new Promise((done) => editor.close(() => done(undefined)));
    throw e;
  });
  filmOrigin = pages.origin;
  if (advertise) {
    mkdirSync(studioHome(), { recursive: true });
    /* `supervisor`: the process that starts this one again if it ends unexpectedly (main.mjs), stopped with it */
    const supervisor = Number(process.env.OPENFILM_STUDIO_SUPERVISOR) || undefined;
    writeFileSync(runFile(), `${JSON.stringify({ pid: process.pid, ...(supervisor ? { supervisor } : {}), origin, filmOrigin: pages.origin, key })}\n`, { mode: 0o600 });
  }

  /** @type {Promise<void> | null} */
  let closing = null;
  const studio = {
    origin,
    filmOrigin: pages.origin,
    port: address.port,
    key,
    mcpKey,
    close() { return closing ??= shutDown(); },
  };
  async function shutDown() {
    /* the file is ours unless a later Studio has written its own (with the same key: it is the machine's) */
    if (advertise && advertised()?.pid === process.pid) rmSync(runFile(), { force: true });
    exports.stopAll();
    fetches.stopAll();
    semanticIndex.stop();
    await closePageFrames();
    watchers.closeAll();
    await pages.close();
    editor.closeAllConnections();
    for (const socket of streamSockets) socket.destroy();
    await new Promise((done) => editor.close(() => done(undefined)));
  }
  return studio;
}

/** Run from a checkout of the repository (the editor's source is beside its build), not from an installed package. */
const FROM_SOURCE = existsSync(new URL('../ui/src', import.meta.url));

/**
 * `npx -y openfilm@<version> update` in the background (its words in logs/update.log), as the person would run it: the
 * newest stops this Studio and starts itself in its place. `then` hears it failed later, with its last words, if this
 * Studio is still here to hear it; one that cannot start is said at once.
 * @param {string} version @param {(state: { status: 'failed', version: string, error: string }) => void} then
 * @returns {{ status: 'updating' | 'failed', version: string, error?: string }}
 */
function runUpdate(version, then) {
  const logs = join(studioHome(), 'logs');
  mkdirSync(logs, { recursive: true });
  const file = join(logs, 'update.log');
  writeFileSync(file, '');
  const failed = (/** @type {string} */ error) => then({ status: 'failed', version, error });
  try {
    const out = openSync(file, 'a');
    const child = spawn('npx', ['-y', `openfilm@${version}`, 'update'], {
      detached: true, stdio: ['ignore', out, out], windowsHide: true, shell: process.platform === 'win32', env: { ...process.env, OPENFILM_NO_BROWSER: '1' },
    });
    child.once('error', (e) => failed(`npx did not start (it comes with Node.js): ${e.message}`));
    child.once('exit', (code) => {
      if (code === 0) return;
      const said = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).pop() ?? '';
      failed(said || `npx stopped (${code})`);
    });
    child.unref();
  } catch (e) { return { status: 'failed', version, error: e instanceof Error ? e.message : String(e) }; }
  return { status: 'updating', version };
}

/** This package's version: the CLI replaces a Studio older than itself. */
export const VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

/**
 * Studio's home as /api/health says it: its SHA-256 (hex), so the CLI can tell its own home's Studio without anyone
 * asking learning where the home is (and with it the person's name).
 */
export const homeTag = () => createHash('sha256').update(studioHome()).digest('hex');

/** Where the Studio running on this machine says it listens (see `advertise`). */
export const runFile = () => join(studioHome(), 'run.json');

/** @returns {{ pid: number, origin: string, filmOrigin: string, key: string } | null} */
function advertised() {
  try { return JSON.parse(readFileSync(runFile(), 'utf8')); } catch { return null; }
}

/* the editor, built (`npm run build:ui`) into studio/ui/dist and shipped with the package */
const EDITOR_DIR = fileURLToPath(new URL('../ui/dist/', import.meta.url));
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

/** The editor's files: its assets as they are (named by their content, so kept for good), any other path its page. */
function sendEditor(/** @type {Res} */ res, /** @type {string} */ dir, /** @type {string} */ path, /** @type {Record<string, string | string[]>} */ headers = {}) {
  const root = dir.endsWith(sep) ? dir : dir + sep;
  if (path.startsWith('/assets/')) {
    const file = normalize(join(root, path));
    if (file.startsWith(root + 'assets' + sep) && existsSync(file) && statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': TYPES[/** @type {keyof typeof TYPES} */ (extname(file))] ?? 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' });
      return res.end(readFileSync(file));
    }
    res.writeHead(404).end();
    return;
  }
  const page = join(root, 'index.html');
  /* no referrer: the page's address holds the key, and a link it opens must not carry it to another site */
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...headers });
  res.end(existsSync(page) ? readFileSync(page) : '<!doctype html><meta charset="utf-8"><title>OpenFilm Studio</title><p>The editor is not built: run <code>npm run build:ui</code>.</p>');
}

/** A file in the system's file manager, selected. */
function reveal(/** @type {string} */ file) {
  /* Explorer takes `/select,"<path>"` as one argument, quoted inside: Node's own quoting of a path with spaces it
     does not read (export names always have spaces) */
  if (process.platform === 'win32') {
    try { spawn('explorer.exe', [`/select,"${file}"`], { stdio: 'ignore', detached: true, windowsVerbatimArguments: true }).on('error', () => {}).unref(); } catch { /* no file manager */ }
    return;
  }
  const [cmd, ...args] = process.platform === 'darwin' ? ['open', '-R', file] : ['xdg-open', join(file, '..')];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no file manager */ }
}

/**
 * The command that opens a file in its app, or an address in the person's browser. Never through a shell: on Windows
 * `cmd /c start` would read `&`, `|` or `^` in a file's name, or in an address's query, as commands of its own.
 * @param {string} target @param {NodeJS.Platform} [platform]
 */
export function opener(target, platform = process.platform) {
  if (platform === 'win32') return /^https?:\/\//i.test(target) ? ['rundll32', 'url.dll,FileProtocolHandler', target] : ['explorer.exe', target];
  return platform === 'darwin' ? ['open', target] : ['xdg-open', target];
}

/** What Saved is served by on the film's origin (pages.mjs): no project's id has a NUL in it. */
const SAVED_ORIGIN_ID = '\0saved';

/**
 * What saved.mjs answers, its refusals as the HTTP errors they are.
 * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
 */
async function savedCall(fn) {
  try { return await fn(); } catch (e) {
    if (e instanceof SavedError) throw new HttpError(/** @type {number} */ (e.status), e.message);
    throw e;
  }
}

/**
 * A saved clip's picture, from the middle of what it shows: a page drawn with the changes made in it, a video's frame,
 * a still's own; a sound has none.
 * @param {string} root @param {string} base the project's folder as the pages are served (pageframes.mjs)
 * @param {{ src: string, time?: unknown, overrides?: unknown, size?: unknown }} clip @param {number} durationMs
 * @returns {Promise<Buffer | null>}
 */
async function clipPoster(root, base, clip, durationMs) {
  const kind = clipKind(clip.src);
  const from = Array.isArray(clip.time) && typeof clip.time[0] === 'number' ? clip.time[0] * 1000 : 0;
  const ms = durationMs > 0 ? from + durationMs / 2 : -1;
  /* laid out at the clip's size, as the film lays it out (a page without one of its own is the clip's `size`) */
  const size = /** @type {{ w?: number, h?: number } | undefined} */ (clip.size);
  if (kind === 'page') return pageFrame(root, base, clip.src, ms, 480, Array.isArray(clip.overrides) ? clip.overrides : null, size?.w && size?.h ? { w: size.w, h: size.h } : null);
  if (kind === 'video') return frame(root, clip.src, Math.max(0, ms), 480);
  if (kind === 'still') return poster(root, clip.src);
  return null;
}

/** A file in the app the system opens it with. */
function openFile(/** @type {string} */ file) {
  const [cmd, ...args] = opener(file);
  /* never `windowsHide`: Explorer opens the folder's window, or the file's app, hidden as it was asked to start */
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* nothing opens it */ }
}

/** The person's browser, at `url`. */
function systemBrowser(/** @type {string} */ url) {
  const [cmd, ...args] = opener(url);
  try { spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref(); } catch { /* no browser to open */ }
}


/**
 * A picture or a video from this computer, a range answered as one (a preview is seeked in); none: 404.
 * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {string | null | undefined} file
 */
function sendMedia(req, res, file, { keep = false } = {}) {
  if (!file || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, 'no such file');
  const { size, mtimeMs } = statSync(file);
  /* `keep`: a picture that changes only with its file (a skill's cover, an example's poster) is kept by the browser
     an hour, and then only asked whether it changed */
  const tag = `"${size.toString(36)}-${Math.round(mtimeMs).toString(36)}"`;
  const kept = keep ? { etag: tag, 'cache-control': 'private, max-age=3600' } : {};
  if (keep && req.headers['if-none-match'] === tag) { res.writeHead(304, kept); res.end(); return undefined; }
  const type = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.svg': 'image/svg+xml',
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac',
  }[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  const [from, to] = range ? [range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2])), range[2] && range[1] ? Math.min(size - 1, Number(range[2])) : size - 1] : [0, size - 1];
  res.writeHead(range ? 206 : 200, { 'content-type': type, 'content-length': to - from + 1, 'accept-ranges': 'bytes', ...kept, ...(range ? { 'content-range': `bytes ${from}-${to}/${size}` } : {}) });
  /* A cancelled preview is normal: pipeline closes its file; its callback deliberately ignores the error. */
  pipeline(createReadStream(file, { start: from, end: to }), res, () => {});
  return undefined;
}
