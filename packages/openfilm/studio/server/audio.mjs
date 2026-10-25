// @ts-check
/**
 * The sound stage's backend: what audio a project has, where more can come from (its own files, a
 * Freesound/Jamendo search, or a provider that makes it), and the timeline edits that place it.
 *
 * It does not keep a second edit of the film. Current sound is read from film.html; every write goes
 * through editProjectFilm/applyOps, the same native operations the editor and an agent use. The
 * endpoints under /audio are contracts for the sound UI, not a parallel editing model.
 */
import { mkdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { clipFade, clipKind, clipSpan, soundRole } from '../../src/film-doc.mjs';
import { EditError, editProjectFilm, readProjectFilm } from './film.mjs';
import { readProjectSettings } from './project-settings.mjs';
import { FileError, importFile, inside, listFiles } from './files.mjs';
import { MediaError, loudness, probe, waveform } from './derived.mjs';
import { catalog, runGet, GetError } from './get.mjs';
import { providerKey, readSettings } from './keys.mjs';
import { cardConnection, defaultCard, readProviderState } from './provider-cards.mjs';
import { listProviders } from './providers/index.mjs';
import { HttpError, json, readJson } from './http.mjs';
import { writeAtomic } from './atomic.mjs';

/** @typedef {import('./http.mjs').Req} Req @typedef {import('./http.mjs').Res} Res */
/** @typedef {'voice' | 'music' | 'sfx'} SoundKind */
/** @typedef {'voice' | 'music' | 'sfx' | 'footage'} SoundRole */

const KINDS = /** @type {const} */ (['voice', 'music', 'sfx']);
const DIRS = /** @type {Record<SoundKind, string>} */ ({ voice: 'vo', music: 'music', sfx: 'sfx' });
const NAMES = /** @type {Record<string, string>} */ ({ voice: 'Voice', music: 'Music', sfx: 'Sound effects', footage: 'Footage' });
/** Internal attribution and generation facts, by project path. Never shown as a project file. */
const META_FILE = '.film/audio.json';
/** The largest file a network import may bring in, before it is written. */
const MAX_REMOTE = 300 << 20;
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'aif', 'aiff', 'weba']);
const MIME_EXT = /** @type {Record<string, string>} */ ({
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
  'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff', 'audio/webm': 'weba',
});
const META_FIELDS = new Set(['source', 'id', 'title', 'credit', 'license', 'page', 'query', 'prompt', 'voice', 'provider', 'model', 'createdAt']);

/** A path's last part, as a title. */
const titleOf = (/** @type {string} */ path) => basename(path).replace(/\.[^.]+$/, '');
const ms = (/** @type {number} */ sec) => Math.round(sec * 1000);
const finite = (/** @type {unknown} */ value) => typeof value === 'number' && Number.isFinite(value);

/** Read the internal audio facts, ignoring a broken file: an edit is never stopped by them. */
async function readMeta(/** @type {string} */ root) {
  try {
    const value = JSON.parse(await readFile(join(root, META_FILE), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? /** @type {Record<string, any>} */ (value) : {};
  } catch { return {}; }
}

/** Keep a few named facts, never arbitrary request data. @param {unknown} raw */
function cleanMeta(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
  /** @type {Record<string, string | number>} */
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (!META_FIELDS.has(key)) continue;
    if (key === 'createdAt' && finite(value)) out[key] = Number(value);
    else if (typeof value === 'string' && value.trim()) out[key] = value.trim().slice(0, 1200);
  }
  return out;
}

/** Merge facts for one project path and write the file whole. @param {string} root @param {string} path @param {Record<string, any>} facts */
async function saveMeta(/** @type {string} */ root, /** @type {string} */ path, /** @type {Record<string, any>} */ facts) {
  const all = await readMeta(root);
  all[path] = { ...(all[path] ?? {}), ...cleanMeta(facts) };
  await mkdir(join(root, '.film'), { recursive: true });
  await writeAtomic(join(root, META_FILE), `${JSON.stringify(all, null, 2)}\n`);
}

/** What ffprobe says, or null when it cannot read the file. @param {string} root @param {string} path */
async function factsOf(/** @type {string} */ root, /** @type {string} */ path) {
  try { return await probe(root, path); } catch { return null; }
}

/** Whether a clip's file is still in the project; a probe failure alone is not a missing file. */
async function fileThere(/** @type {string} */ root, /** @type {string} */ path) {
  try { return (await stat(inside(root, path, { read: true }))).isFile(); } catch { return false; }
}

/**
 * One audio file as the sound UI sees it. Times are milliseconds (the UI's unit); editing still uses
 * seconds through applyOps.
 * @param {string} root @param {{ path: string, size?: number, mtime?: number }} file
 * @param {Record<string, any> | undefined} meta @param {{ duration?: number, audio?: boolean } | null} facts
 * @param {string} folderUrl @param {SoundRole} [role]
 */
function assetOf(root, file, meta, facts, folderUrl, role) {
  const path = file.path;
  /* The UI's source is one of local / download / ai; the provider that was downloaded from stays
     in credit/page, not in a source the interface cannot name. */
  const origin = typeof meta?.source === 'string' ? meta.source : 'local';
  const source = origin === 'ai' || origin === 'local' || origin === 'download' ? origin : 'download';
  return {
    id: path,
    path,
    name: basename(path),
    title: typeof meta?.title === 'string' && meta.title ? meta.title : titleOf(path),
    role: role ?? soundRole(path),
    roleName: NAMES[role ?? soundRole(path)],
    kind: 'audio',
    size: file.size ?? 0,
    mtime: file.mtime ?? 0,
    durationMs: finite(facts?.duration) ? ms(Number(facts?.duration)) : null,
    previewUrl: folderUrl ? `${folderUrl}${encodeURI(path)}` : null,
    source,
    ...(meta?.credit ? { credit: String(meta.credit) } : {}),
    ...(meta?.license ? { license: String(meta.license) } : {}),
    ...(meta?.page ? { page: String(meta.page) } : {}),
    ...(facts && facts.audio === false ? { unreadable: 'there is no sound in it' } : {}),
  };
}

/**
 * The project's own audio files under assets/, with attribution where a network or AI import left
 * some. `facts: false` answers at once without ffprobe (durations null).
 * @param {string} root @param {{ role?: SoundRole | 'all', q?: string, facts?: boolean, folderUrl: string }} how
 */
export async function listAudio(/** @type {string} */ root, { role = 'all', q = '', facts = true, folderUrl = '' }) {
  const [listing, meta] = await Promise.all([listFiles(root), readMeta(root)]);
  const needle = q.trim().toLowerCase();
  const files = listing.files.filter((file) => {
    if (file.kind !== 'audio') return false;
    if (role !== 'all' && soundRole(file.path) !== role) return false;
    return !needle || file.path.toLowerCase().includes(needle) || titleOf(file.path).toLowerCase().includes(needle);
  });
  const assets = await Promise.all(files.map(async (file) => {
    const detail = facts ? await factsOf(root, file.path) : null;
    return assetOf(root, file, meta[file.path], detail, folderUrl);
  }));
  return { role, q, files: assets, folderUrl };
}

/**
 * Current sound as it is on film.html's timeline: each track and audio clip, with native fields and
 * the facts a UI needs to draw them.
 * @param {string} root @param {string} folderUrl
 */
export async function readAudio(/** @type {string} */ root, /** @type {string} */ folderUrl = '') {
  const [film, meta, settings] = await Promise.all([readProjectFilm(root), readMeta(root), readProjectSettings(root)]);
  const value = film.value;
  if (!value) return { revision: film.rev, durationMs: 0, tracks: [], clips: [], summary: {} };
  const sources = new Set();
  for (const track of value.tracks) for (const clip of track.clips) {
    if (clipKind(clip.src) === 'sound' || clipKind(clip.src) === 'video') sources.add(clip.src);
  }
  const facts = new Map();
  const there = new Map();
  for (const src of sources) {
    facts.set(src, await factsOf(root, src));
    there.set(src, await fileThere(root, src));
  }
  /** @type {Record<string, { role: SoundRole, roleName: string, count: number, durationMs: number }>} */
  const summary = Object.fromEntries([...KINDS, 'footage'].map((role) => [role, { role: /** @type {SoundRole} */ (role), roleName: NAMES[role], count: 0, durationMs: 0 }]));
  const tracks = [];
  const clips = [];
  let durationMs = 0;
  for (const [index, track] of value.tracks.entries()) {
    const rows = [];
    for (const clip of track.clips) {
      const kind = clipKind(clip.src);
      if (kind !== 'sound' && kind !== 'video') continue;
      const fact = facts.get(clip.src) ?? null;
      if (kind === 'video' && fact && fact.audio === false) continue;
      const role = /** @type {SoundRole} */ (kind === 'video' ? 'footage' : soundRole(clip.src));
      const native = finite(fact?.duration) ? Number(fact?.duration) : undefined;
      let span = { from: 0, to: 0, speed: 1, length: 0 };
      try { span = clipSpan(clip, native); } catch { /* an unfinished clip still shows what it says */ }
      const startMs = ms(Number(clip.at ?? 0));
      const lengthMs = ms(span.length);
      const fade = clipFade(clip);
      const factsForAsset = fact ? { duration: native, audio: fact.audio } : null;
      const base = assetOf(root, { path: clip.src }, meta[clip.src], factsForAsset, folderUrl, role);
      const row = {
        ...base,
        id: clip.id,
        role,
        roleName: NAMES[role],
        track: index,
        atMs: startMs,
        startMs: ms(span.from),
        endMs: ms(span.to),
        durationMs: lengthMs,
        speed: span.speed,
        volume: finite(clip.volume) ? Number(clip.volume) : 1,
        ...(fade ? { fadeInMs: ms(fade[0]), fadeOutMs: ms(fade[1]) } : { fadeInMs: 0, fadeOutMs: 0 }),
        ...(track.muted ? { muted: true } : {}),
        ...(track.hidden ? { hidden: true } : {}),
        ...(track.locked ? { locked: true } : {}),
        ...(there.get(clip.src) === false ? { missing: true } : {}),
      };
      rows.push(row);
      clips.push(row);
      summary[role].count += 1;
      summary[role].durationMs += lengthMs;
      durationMs = Math.max(durationMs, startMs + lengthMs);
    }
    if (!rows.length) continue;
    const roles = [...new Set(rows.map((row) => row.role))];
    /* Track names are kept in .film/settings.json (a track has no id): the index first, then
       the clips it had when named, so a named track that moved keeps its name. */
    const ids = rows.map((row) => row.id);
    const named = (settings.trackNames ?? []).find((entry) => entry.index === index && (!entry.clips.length || entry.clips.some((id) => ids.includes(id))))
      ?? (settings.trackNames ?? []).find((entry) => entry.clips.length > 0 && entry.clips.every((id) => ids.includes(id)));
    tracks.push({
      index,
      name: named?.name ?? (typeof track.attrs?.title === 'string' ? track.attrs.title : `Track ${index + 1}`),
      role: roles.length === 1 ? roles[0] : 'mixed',
      roles,
      ...(track.muted ? { muted: true } : {}),
      ...(track.hidden ? { hidden: true } : {}),
      ...(track.locked ? { locked: true } : {}),
      clips: rows,
    });
  }
  return { revision: film.rev, durationMs, tracks, clips, summary };
}

/** The network client_id/key for a service, if this machine has one. */
async function networkKey(/** @type {string} */ id, /** @type {string} */ env) {
  const settings = await readSettings();
  return providerKey(/** @type {any} */ ({ id, env }), settings)?.key ?? null;
}

/** Freesound search: results point at their preview MP3, enough to hear and import. */
export async function searchFreesound(/** @type {string} */ query, /** @type {string} */ key, { limit = 20, fetchImpl = fetch } = {}) {
  if (!query.trim()) return [];
  if (!key) throw new HttpError(409, 'Freesound is not connected: set FREESOUND_API_KEY (or add a "freesound" key to providers.json).', { code: 'not-connected' });
  const params = new URLSearchParams({
    query: query.trim().slice(0, 200), token: key, page_size: String(Math.max(1, Math.min(50, limit))),
    fields: 'id,name,previews,duration,tags,license,username,url',
  });
  let response;
  try { response = await fetchImpl(`https://freesound.org/apiv2/search/text/?${params}`, { signal: AbortSignal.timeout(20_000) }); }
  catch (e) { throw new HttpError(502, `Freesound could not be reached: ${e instanceof Error ? e.message : String(e)}`); }
  if (!response.ok) throw new HttpError(502, `Freesound answered ${response.status}.`);
  let body;
  try { body = /** @type {any} */ (await response.json()); }
  catch { throw new HttpError(502, 'Freesound answered something that is not JSON.'); }
  const results = (Array.isArray(body?.results) ? body.results : []).flatMap((/** @type {any} */ item) => {
    const preview = item?.previews ?? {};
    const url = preview['preview-hq-mp3'] || preview['preview-lq-mp3'] || preview['preview-hq-ogg'];
    if (!url) return [];
    const id = String(item.id ?? '');
    return [{
      source: 'freesound', id, role: 'sfx', title: String(item.name ?? 'Sound effect'),
      durationMs: finite(item.duration) ? ms(Number(item.duration)) : null,
      downloadUrl: String(url), previewUrl: String(url),
      page: `https://freesound.org/s/${id}/`,
      credit: `${String(item.username ?? 'unknown')} on Freesound`,
      ...(item.license ? { license: String(item.license) } : {}),
      ...(Array.isArray(item.tags) ? { tags: item.tags.map(String).slice(0, 20) } : {}),
    }];
  });
  return results;
}

/** Jamendo search: a track's MP3 is the download, its page and CC licence travel with it. */
export async function searchJamendo(/** @type {string} */ query, /** @type {string} */ key, { limit = 20, fetchImpl = fetch } = {}) {
  if (!query.trim()) return [];
  if (!key) throw new HttpError(409, 'Jamendo is not connected: set JAMENDO_CLIENT_ID (or add a "jamendo" key to providers.json).', { code: 'not-connected' });
  const params = new URLSearchParams({
    client_id: key, format: 'json', limit: String(Math.max(1, Math.min(50, limit))), search: query.trim().slice(0, 200), audioformat: 'mp32',
  });
  let response;
  try { response = await fetchImpl(`https://api.jamendo.com/v3.0/tracks/?${params}`, { signal: AbortSignal.timeout(20_000) }); }
  catch (e) { throw new HttpError(502, `Jamendo could not be reached: ${e instanceof Error ? e.message : String(e)}`); }
  if (!response.ok) throw new HttpError(502, `Jamendo answered ${response.status}.`);
  let body;
  try { body = /** @type {any} */ (await response.json()); }
  catch { throw new HttpError(502, 'Jamendo answered something that is not JSON.'); }
  const results = (Array.isArray(body?.results) ? body.results : []).flatMap((/** @type {any} */ item) => {
    const url = item?.audiodownload || item?.audio;
    if (!url) return [];
    return [{
      source: 'jamendo', id: String(item.id ?? ''), role: 'music', title: String(item.name ?? 'Music'),
      ...(item.artist_name ? { artist: String(item.artist_name) } : {}),
      durationMs: finite(item.duration) ? ms(Number(item.duration)) : null,
      downloadUrl: String(url), previewUrl: String(url),
      ...(item.shareurl ? { page: String(item.shareurl) } : {}),
      credit: [item.artist_name, item.name].filter(Boolean).join(' · ') || 'Jamendo',
      ...(item.license_ccurl ? { license: String(item.license_ccurl) } : {}),
    }];
  });
  return results;
}

/** A host that is this machine, a private network, or otherwise not somewhere a public download lives. @param {string} host */
function privateHost(/** @type {string} */ host) {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name.endsWith('.internal')) return true;
  return isIP(name) ? privateIp(name) : false;
}

/** @param {string} ip */
function privateIp(/** @type {string} */ ip) {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return true;
    if (v.startsWith('::ffff:')) return privateIp(v.slice(7));
    return false;
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** A URL from a request, or a 400 that says so. @param {string} address */
function urlOf(/** @type {string} */ address) {
  try { return new URL(address); } catch { throw new HttpError(400, 'that is not a complete web address'); }
}

/** Refuse a URL that is not a public HTTP(S) address. @param {URL} url */
async function publicUrl(/** @type {URL} */ url) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new HttpError(400, 'a download is http or https');
  if (url.username || url.password) throw new HttpError(400, 'a download address carries no user name or password');
  if (url.port && url.port !== '80' && url.port !== '443') throw new HttpError(400, 'a download uses port 80 or 443');
  if (privateHost(url.hostname)) throw new HttpError(400, 'that address is on this machine or a private network');
  if (!isIP(url.hostname.replace(/^\[|\]$/g, ''))) {
    let addresses;
    try { addresses = await lookup(url.hostname, { all: true, verbatim: true }); }
    catch (e) { throw new HttpError(400, `that address does not resolve: ${e instanceof Error ? e.message : String(e)}`); }
    if (!addresses.length || addresses.some((one) => privateIp(one.address))) throw new HttpError(400, 'that address is on this machine or a private network');
  }
}

/** The extension a download gets, from its address or its content type. */
function extensionOf(/** @type {URL} */ url, /** @type {string | null} */ type) {
  const fromUrl = extname(url.pathname).slice(1).toLowerCase();
  if (AUDIO_EXT.has(fromUrl)) return fromUrl;
  return MIME_EXT[(type ?? '').toLowerCase().split(';')[0].trim()] ?? null;
}

/**
 * Fetch a public audio address as a stream, following a few redirects and refusing a body over the
 * limit. Returns the final address, its type and the stream to hand to importFile.
 * @param {string} address @param {{ fetchImpl?: typeof fetch, max?: number }} [how]
 */
export async function fetchAudio(/** @type {string} */ address, { fetchImpl = fetch, max = MAX_REMOTE } = {}) {
  let url = urlOf(address);
  for (let hop = 0; hop <= 5; hop++) {
    await publicUrl(url);
    let response;
    try {
      response = await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
    } catch (e) {
      throw new HttpError(502, `the audio download failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new HttpError(502, 'the audio download redirected without a place to go');
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new HttpError(response.status === 404 ? 404 : 502, `the audio download answered ${response.status}`);
    const length = Number(response.headers.get('content-length'));
    if (finite(length) && length > max) throw new HttpError(413, `that audio is larger than ${Math.round(max / 1e6)} MB`);
    const type = response.headers.get('content-type');
    const ext = extensionOf(url, type);
    if (!ext) throw new HttpError(415, 'that address does not say it is a sound file');
    if (!response.body) throw new HttpError(502, 'the audio download was empty');
    let seen = 0;
    const limit = new Transform({
      transform(chunk, _encoding, done) {
        seen += chunk.length;
        if (seen > max) done(new HttpError(413, `that audio is larger than ${Math.round(max / 1e6)} MB`));
        else done(null, chunk);
      },
    });
    return { url, type, ext, stream: Readable.fromWeb(/** @type {any} */ (response.body)).pipe(limit) };
  }
  throw new HttpError(502, 'the audio download redirected too many times');
}

/** A request name for a download: no folders, no extension yet. @param {unknown} name @param {URL} url */
function downloadName(name, url) {
  const last = url.pathname.split('/').pop() ?? '';
  let fromUrl = last;
  try { fromUrl = decodeURIComponent(last); } catch { /* a malformed escape is only a bad name */ }
  const asked = typeof name === 'string' && name.trim() ? name.trim() : fromUrl;
  const stem = basename(asked).replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 90);
  return stem || `download-${Date.now()}`;
}

/**
 * Keep a remote sound in the project, under the role's folder, and remember who made it. The same
 * importFile the media pane uses picks a free name and writes whole.
 * @param {string} root @param {Record<string, any>} body @param {{ folderUrl: string, fetchImpl?: typeof fetch }} how
 */
export async function importAudio(/** @type {string} */ root, /** @type {Record<string, any>} */ body, { folderUrl, fetchImpl = fetch }) {
  const address = typeof body.url === 'string' ? body.url.trim() : '';
  if (!address) throw new HttpError(400, 'url is required');
  const askedRole = KINDS.includes(body.role) ? /** @type {SoundKind} */ (body.role) : null;
  const url = urlOf(address);
  let pathName = url.pathname;
  try { pathName = decodeURIComponent(pathName); } catch { /* the name is only a hint */ }
  const role = askedRole ?? /** @type {SoundKind} */ (soundRole(pathName));
  const fetched = await fetchAudio(address, { fetchImpl });
  const name = `${downloadName(body.name, fetched.url)}.${fetched.ext}`;
  const { path } = await importFile(root, `assets/audio/${DIRS[role]}/${name}`, fetched.stream);
  const fact = await factsOf(root, path);
  const meta = cleanMeta({ ...(body.meta && typeof body.meta === 'object' ? body.meta : {}), source: body.source ?? 'download', createdAt: Date.now() });
  await saveMeta(root, path, meta);
  return {
    asset: assetOf(root, { path }, await readMeta(root).then((all) => all[path]), fact, folderUrl, role),
    ...(fact && fact.audio === false ? { unreadable: 'there is no sound in it' } : {}),
  };
}

/** A simple name not taken in the role's folder, so a generation never overwrites another take. */
async function freeOut(/** @type {string} */ root, /** @type {SoundKind} */ kind, /** @type {unknown} */ asked) {
  const requested = typeof asked === 'string' && asked.trim() ? asked.trim() : `${kind}-${Date.now().toString(36)}`;
  const base = requested.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 90) || `${kind}-${Date.now().toString(36)}`;
  try {
    const files = new Set((await listFiles(root)).files.map((file) => file.path.toLowerCase()));
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      if (![...files].some((path) => path.startsWith(`assets/audio/${DIRS[kind]}/${name.toLowerCase()}.`))) return name;
    }
  } catch { return base; }
}

/** Parse what `openfilm get` prints: its receipt is JSON, but a provider may answer prose. */
function receiptOf(/** @type {string} */ text) {
  try { return JSON.parse(text); } catch { return { text }; }
}

/**
 * Make a voice-over, a score or an effect through the same `openfilm get` pipeline the CLI and an
 * agent use, then return the asset the UI can place.
 * @param {string} root @param {Record<string, any>} body @param {{ folderUrl: string }} how
 */
export async function generateAudio(/** @type {string} */ root, /** @type {Record<string, any>} */ body, { folderUrl }) {
  const asked = body.kind === 'tts' ? 'voice' : body.kind;
  const kind = KINDS.includes(asked) ? /** @type {SoundKind} */ (asked) : null;
  if (!kind) throw new HttpError(400, 'kind is voice, music or sfx');
  const out = await freeOut(root, kind, body.out);
  /** @type {Record<string, unknown>} */
  const args = { out };
  if (kind === 'voice') {
    if (typeof body.text !== 'string' || !body.text.trim()) throw new HttpError(400, 'a voice-over needs text');
    const voice = typeof body.voice === 'string' ? body.voice : typeof body.voiceId === 'string' ? body.voiceId : '';
    if (!voice.trim()) throw new HttpError(400, 'a voice-over needs voice');
    args.text = body.text.trim();
    args.voice = voice.trim();
  } else {
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new HttpError(400, `${kind} needs prompt`);
    args.prompt = body.prompt.trim();
    if (body.sec != null) {
      if (!finite(body.sec) || Number(body.sec) <= 0) throw new HttpError(400, 'sec is seconds from 0');
      args.sec = String(Number(body.sec));
    }
  }
  let text;
  try {
    /* `voice` is the stage's role; the media verb that makes one is `tts`. */
    text = await runGet(root, kind === 'voice' ? 'tts' : kind, args, {
      ...(typeof body.via === 'string' && body.via ? { via: body.via } : {}),
      ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
      yes: true,
    });
  } catch (e) {
    if (e instanceof GetError) throw new HttpError(e.code === 2 ? 400 : 409, e.message, { code: 'get' });
    throw new HttpError(502, e instanceof Error ? e.message : String(e), { code: 'provider' });
  }
  const receipt = /** @type {Record<string, any>} */ (receiptOf(text));
  const src = typeof receipt.src === 'string' ? receipt.src : '';
  if (!src) throw new HttpError(502, 'the service made no file Studio can place');
  const fact = await factsOf(root, src);
  await saveMeta(root, src, {
    source: 'ai', ...(receipt.provider ? { provider: String(receipt.provider) } : {}), ...(receipt.model ? { model: String(receipt.model) } : {}),
    ...(kind === 'voice' ? { title: args.text, voice: String(receipt.voiceId ?? receipt.voice ?? args.voice) } : { title: args.prompt, prompt: String(args.prompt ?? '') }),
    createdAt: Date.now(),
  });
  return { asset: assetOf(root, { path: src }, await readMeta(root).then((all) => all[src]), fact, folderUrl, kind), receipt, output: text };
}

/**
 * A native timeline edit, exactly the one /edit makes. All applyOps operations are accepted: insert,
 * move, set, split, props, fields, remove, track, reorder and stage. The audio UI should use this
 * rather than a second set of edit rules.
 * @param {string} root @param {Record<string, any>} body @param {{ emit?: (event: unknown) => void }} [how]
 */
export async function editAudio(/** @type {string} */ root, /** @type {Record<string, any>} */ body, { emit } = {}) {
  if (!Array.isArray(body.ops) || !body.ops.length) throw new HttpError(400, 'ops is a non-empty array of native operations');
  try {
    const result = await editProjectFilm(root, body.base ?? null, body.ops);
    emit?.({ type: 'film', rev: result.rev });
    return result;
  } catch (e) {
    if (!(e instanceof EditError)) throw e;
    const now = await readProjectFilm(root);
    throw new HttpError(e.kind === 'conflict' ? 409 : 422, e.message, { rev: now.rev, doc: now.doc });
  }
}

/**
 * A convenience for the sound UI: one insert with the common audio fields, still applied by the
 * native insert operation (and therefore readable and undoable like any other edit). For anything
 * else, use /audio/ops.
 * @param {string} root @param {Record<string, any>} body @param {{ emit?: (event: unknown) => void }} [how]
 */
export async function placeAudio(/** @type {string} */ root, /** @type {Record<string, any>} */ body, { emit } = {}) {
  const src = typeof body.path === 'string' ? body.path : typeof body.src === 'string' ? body.src : '';
  if (!src) throw new HttpError(400, 'path is required');
  inside(root, src, { read: true });
  if (!(await fileThere(root, src))) throw new HttpError(404, 'that sound is not in the project');
  if (clipKind(src) !== 'sound') throw new HttpError(400, 'this endpoint places a sound file; use ops for a video or a page');
  const at = body.at == null ? 0 : Number(body.at);
  if (!(Number.isFinite(at) && at >= 0)) throw new HttpError(400, 'at is seconds from the film start');
  let time = Array.isArray(body.time) ? body.time.map(Number) : null;
  if (time && !(time.length === 2 && time.every(Number.isFinite) && time[1] > time[0])) throw new HttpError(400, 'time is [start, end] in the file’s seconds');
  if (!time) {
    const start = body.start == null ? 0 : Number(body.start);
    let end = body.end == null ? null : Number(body.end);
    if (!(Number.isFinite(start) && start >= 0)) throw new HttpError(400, 'start is seconds in the file');
    if (end == null) {
      const fact = await factsOf(root, src);
      if (!finite(fact?.duration)) throw new HttpError(422, 'the file has no length Studio can read: pass end');
      end = Number(fact?.duration);
    }
    if (!(Number.isFinite(end) && end > start)) throw new HttpError(400, 'end is after start, in the file’s seconds');
    time = [start, end];
  }
  const volume = body.volume == null ? 1 : Number(body.volume);
  if (!(Number.isFinite(volume) && volume >= 0)) throw new HttpError(400, 'volume is 0 or more (1 is the original level)');
  const speed = body.speed == null ? 1 : Number(body.speed);
  if (!(Number.isFinite(speed) && speed >= 0.25 && speed <= 4)) throw new HttpError(400, 'speed is 0.25 to 4');
  let fade = null;
  if (body.fade != null) {
    if (!Array.isArray(body.fade) || body.fade.length !== 2 || !body.fade.every((v) => Number.isFinite(Number(v)) && Number(v) >= 0)) {
      throw new HttpError(400, 'fade is [in, out] in seconds');
    }
    fade = body.fade.map(Number);
  }
  const clip = /** @type {Record<string, any>} */ ({ src, at, time, volume, speed });
  if (fade && (fade[0] || fade[1])) clip.overrides = [{ fade }];
  if (typeof body.id === 'string' && body.id.trim()) clip.id = body.id.trim();
  /** @type {Record<string, any>} */
  const op = { op: 'insert', clip };
  if (typeof body.link === 'string' || body.link === null) op.link = body.link;
  if (body.track != null) op.track = body.track;
  if (body.newTrack != null) op.newTrack = body.newTrack;
  if (body.after != null) op.after = body.after;
  const before = await readProjectFilm(root);
  const beforeIds = new Set((before.value?.tracks ?? []).flatMap((track) => track.clips.map((item) => item.id)));
  const result = await editAudio(root, { base: body.base ?? null, ops: [op] }, { emit });
  const landed = (result.value?.tracks ?? []).flatMap((track) => track.clips).filter((item) => item.src === src && !beforeIds.has(item.id));
  return { ...result, clipId: landed.at(-1)?.id ?? null };
}

/**
 * TTS voices from the connected service; the same `openfilm get voice` an agent runs.
 * @param {string} root @param {Record<string, any>} body
 */
export async function listVoices(/** @type {string} */ root, /** @type {Record<string, any>} */ body) {
  /** @type {Record<string, unknown>} */
  const args = {};
  if (typeof body.q === 'string' && body.q.trim()) args.prompt = body.q.trim();
  if (typeof body.language === 'string' && body.language.trim()) args.language = body.language.trim();
  if (typeof body.gender === 'string' && body.gender.trim()) args.gender = body.gender.trim();
  args.limit = String(Math.max(1, Math.min(100, Math.round(Number(body.limit) || 20))));
  let text;
  try {
    text = await runGet(root, 'voice', args, {
      ...(typeof body.via === 'string' && body.via ? { via: body.via } : {}),
      ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
      yes: true,
    });
  } catch (e) {
    if (e instanceof GetError) throw new HttpError(e.code === 2 ? 400 : 409, e.message, { code: 'get' });
    throw new HttpError(502, e instanceof Error ? e.message : String(e), { code: 'provider' });
  }
  return receiptOf(text);
}

/** A search of local files and, when asked, the two stock services. */
export async function searchAll(/** @type {string} */ root, /** @type {Record<string, any>} */ query, /** @type {string} */ folderUrl) {
  const role = KINDS.includes(query.role) ? /** @type {SoundKind} */ (query.role) : 'all';
  const source = ['all', 'local', 'freesound', 'jamendo'].includes(query.source) ? String(query.source) : 'all';
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  const limit = Math.max(1, Math.min(50, Math.round(Number(query.limit) || 20)));
  /** @type {any[]} */
  const results = [];
  /** @type {{ id: string, available: boolean, count?: number, note?: string }[]} */
  const sources = [];
  if (source === 'all' || source === 'local') {
    const local = await listAudio(root, { role, q, facts: true, folderUrl });
    results.push(...local.files.map((file) => ({ ...file, source: file.source || 'local' })));
    sources.push({ id: 'local', available: true, count: local.files.length });
  }
  const network = async (/** @type {'freesound' | 'jamendo'} */ id, /** @type {'sfx' | 'music'} */ wanted) => {
    if (role !== 'all' && role !== wanted) return;
    const key = await networkKey(id, id === 'freesound' ? 'FREESOUND_API_KEY' : 'JAMENDO_CLIENT_ID');
    if (!key) { sources.push({ id, available: false, note: `${id === 'freesound' ? 'FREESOUND_API_KEY' : 'JAMENDO_CLIENT_ID'} is not set` }); return; }
    if (!q) { sources.push({ id, available: true, count: 0, note: 'a query is needed' }); return; }
    try {
      const found = id === 'freesound' ? await searchFreesound(q, key, { limit }) : await searchJamendo(q, key, { limit });
      results.push(...found);
      sources.push({ id, available: true, count: found.length });
    } catch (e) {
      sources.push({ id, available: true, count: 0, note: e instanceof Error ? e.message : String(e) });
    }
  };
  if (source === 'all' || source === 'freesound') await network('freesound', 'sfx');
  if (source === 'all' || source === 'jamendo') await network('jamendo', 'music');
  return { query: q, role, results: results.slice(0, limit), sources };
}

/**
 * The project's /audio API. Returns false when `rest` is not one. Every write goes through the
 * native film edit; the sound layer never invents a second timeline.
 * @param {Req} req @param {Res} res @param {{ id: string, path: string }} project @param {string} rest
 * @param {{ folderUrl: string, emit: (event: unknown) => void }} how
 */
export async function audioRoutes(req, res, project, rest, { folderUrl, emit }) {
  if (rest !== 'audio' && !rest.startsWith('audio/')) return false;
  const sub = rest.slice('audio'.length).replace(/^\/+/, '');
  const url = new URL(req.url ?? '/', 'http://studio');
  const body = () => readJson(req);
  try {
    if (!sub && req.method === 'GET') return json(res, 200, await readAudio(project.path, folderUrl)), true;
    if (sub === 'catalog' && req.method === 'GET') {
      const all = await catalog();
      const state = readProviderState();
      const settings = await readSettings();
      const kinds = Object.fromEntries(KINDS.map((kind) => {
        const verb = kind === 'voice' ? 'tts' : kind;
        const found = all.verbs.find((item) => item.verb === verb);
        /* A provider card may be the one that makes this kind; catalog() lists the built-in providers. */
        const card = defaultCard(state, /** @type {any} */ (verb));
        const custom = card && !card.builtin && !String(card.protocol ?? '').startsWith('builtin')
          && cardConnection(card, state) && card.models.length ? card : null;
        const chosen = settings.use[verb];
        const builtin = listProviders().find((item) => item.id === chosen && /** @type {readonly string[]} */ (item.verbs).includes(verb));
        return [kind, {
          kind, verb, available: Boolean(found || custom),
          ...(found ? { options: found.options, dir: found.dir } : {}),
          ...(custom ? { provider: custom.name, model: custom.defaultModelId ?? custom.models[0]?.id } : {}),
          ...(builtin ? { provider: builtin.name } : {}),
        }];
      }));
      return json(res, 200, { kinds, note: all.note, services: all.services }), true;
    }
    if (sub === 'library' && req.method === 'GET') {
      const asked = url.searchParams.get('role') ?? '';
      const role = KINDS.includes(/** @type {SoundKind} */ (asked)) ? /** @type {SoundKind} */ (asked) : 'all';
      return json(res, 200, await listAudio(project.path, {
        role, q: url.searchParams.get('q') ?? '', facts: url.searchParams.get('facts') !== '0', folderUrl,
      })), true;
    }
    if (sub === 'asset' && req.method === 'GET') {
      const path = url.searchParams.get('path') ?? '';
      inside(project.path, path, { read: true });
      const what = url.searchParams.get('what') ?? 'probe';
      if (what === 'probe') return json(res, 200, await probe(project.path, path)), true;
      if (what === 'wave') return json(res, 200, await waveform(project.path, path)), true;
      if (what === 'loudness') {
        const to = url.searchParams.get('to');
        return json(res, 200, await loudness(project.path, path, Number(url.searchParams.get('from') ?? 0), to == null ? undefined : Number(to))), true;
      }
      throw new HttpError(400, 'what: probe, wave or loudness');
    }
    if (sub === 'voices' && req.method === 'GET') {
      return json(res, 200, await listVoices(project.path, Object.fromEntries(url.searchParams))), true;
    }
    if (sub === 'search' && req.method === 'GET') {
      return json(res, 200, await searchAll(project.path, Object.fromEntries(url.searchParams), folderUrl)), true;
    }
    if (sub === 'generate' && req.method === 'POST') {
      const made = await generateAudio(project.path, await body(), { folderUrl });
      emit({ type: 'files' });
      return json(res, 200, made), true;
    }
    if (sub === 'import' && req.method === 'POST') {
      const made = await importAudio(project.path, await body(), { folderUrl });
      emit({ type: 'files' });
      return json(res, 200, made), true;
    }
    if (sub === 'ops' && req.method === 'POST') return json(res, 200, await editAudio(project.path, await body(), { emit })), true;
    if (sub === 'place' && req.method === 'POST') return json(res, 200, await placeAudio(project.path, await body(), { emit })), true;
    throw new HttpError(404, 'no such audio API');
  } catch (e) {
    if (e instanceof FileError || e instanceof MediaError) throw new HttpError(e.status, e.message);
    throw e;
  }
}
