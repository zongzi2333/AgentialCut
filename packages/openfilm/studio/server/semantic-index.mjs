// @ts-check
/**
 * The bridge between Studio and the local semantic-index sidecar.
 *
 * The sidecar owns extraction, encoding, chunking and vectors. This module owns the process, the
 * project/extra-library roots, the model-pack import, and the mapping back to Studio's files.
 *
 * One global catalog lives in the user's chosen vector folder (default OpenFilm's data folder):
 *   <vector-index>/catalog.sqlite, stores/<storeId>/...
 * Assets are keyed by absolute path; projects reference stores rather than owning them.
 * Nothing here writes media.
 */
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, cp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { listFiles } from './files.mjs';
import { HttpError } from './http.mjs';
import { listProjects, studioHome } from './projects.mjs';
import { moveToTrash } from './trash.mjs';
import { readProviderState, cardConnection } from './provider-cards.mjs';
import { writeAtomic } from './atomic.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SIDECAR = resolve(HERE, '..', 'index-sidecar', 'server.py');
const OPENFILM_ROOT = resolve(HERE, '..', '..', '..', '..');
/** In a checkout, VideoSeek sits beside openfilm; a packaged app names it in the environment. */
const defaultVideoSeekRoot = () => process.env.OPENFILM_VIDEOSEEK_ROOT || resolve(OPENFILM_ROOT, '..', 'VideoSeek');
const defaultPython = (/** @type {string} */ videosSeekRoot) => {
  const candidate = join(videosSeekRoot, '.venv', 'Scripts', 'python.exe');
  if (process.platform === 'win32' && existsSync(candidate)) return candidate;
  const posix = join(videosSeekRoot, '.venv', 'bin', 'python');
  if (existsSync(posix)) return posix;
  return process.platform === 'win32' ? 'python.exe' : 'python3';
};

const sha1 = (/** @type {string} */ value) => createHash('sha1').update(value).digest('hex');
const cleanName = (/** @type {unknown} */ value, /** @type {string} */ fallback) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
};

/** A model directory's provider folder, as VideoSeek names it. */
const providerDir = (/** @type {string} */ provider) => ({
  chinese_clip_onnx: 'chinese-clip',
  clip_onnx: 'openai-clip',
  siglip2_onnx: 'siglip2',
}[provider] ?? provider.replaceAll('_', '-'));

const VISUAL_FILE = /\.(mp4|m4v|mov|webm|mkv|avi|png|jpe?g|webp|gif|bmp|avif)$/i;

/** Whether `file` is inside `root` (both absolute). */
const inside = (/** @type {string} */ root, /** @type {string} */ file) => {
  const back = relative(resolve(root), resolve(file));
  return back === '' || (back !== '..' && !back.startsWith(`..${sep}`) && !isAbsolute(back));
};

/** The visual files of an external folder, relative to it; hidden folders (and index folders) are skipped. */
async function scanVisualMedia(/** @type {string} */ root) {
  /** @type {{ path: string, kind: string, size: number, mtime: number }[]} */
  const files = [];
  const walk = async (/** @type {string} */ dir, /** @type {string} */ prefix, /** @type {number} */ depth) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const at = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 8) await walk(at, rel, depth + 1);
        continue;
      }
      if (!entry.isFile() || !VISUAL_FILE.test(entry.name)) continue;
      const info = await stat(at).catch(() => null);
      if (!info) continue;
      files.push({ path: rel, kind: /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(entry.name) ? 'image' : 'video', size: info.size, mtime: Math.round(info.mtimeMs) });
    }
  };
  await walk(root, '', 0);
  return files;
}

export class SemanticIndexService {
  /**
   * @param {{ sidecar?: string, videosSeekRoot?: string, modelsRoot?: string, python?: string, configDir?: string }} [options]
   */
  constructor(options = {}) {
    this.sidecar = options.sidecar || SIDECAR;
    this.videosSeekRoot = options.videosSeekRoot || defaultVideoSeekRoot();
    this.modelsRoot = options.modelsRoot || process.env.OPENFILM_INDEX_MODELS || join(this.videosSeekRoot, 'models');
    this.python = options.python || process.env.OPENFILM_INDEX_PYTHON || defaultPython(this.videosSeekRoot);
    this.configDir = options.configDir || join(studioHome(), 'index-sidecar');
    this.child = null;
    this.port = 0;
    this.token = '';
    this.starting = null;
    this.stderr = '';
    this.lastError = '';
    this.preferredModel = process.env.OPENFILM_INDEX_MODEL || 'chinese_clip_vit_base_patch16';
    this.externalFile = join(studioHome(), 'index-libraries.json');
    this.externalScans = new Map();
    this.migrating = false;
    this.globalFile = join(studioHome(), 'vector-index.json');
    this.defaultGlobalRoot = join(studioHome(), 'vector-index');
    this.legacyChecked = false;
    this.jobSources = new Map();
  }

  /**
   * Publish the multimodal embedding cards to the sidecar as remote models. A text-only embedding
   * card is deliberately not published: it cannot live in the same vector space as video frames.
   */
  async syncRemoteModels() {
    let state;
    try { state = readProviderState(); } catch { return; }
    const models = [];
    for (const card of state.cards) {
      if (!card.enabled || card.category !== 'embedding') continue;
      if (!['openai-embeddings', 'openai-multimodal-embeddings'].includes(card.protocol)) continue;
      const connection = cardConnection(card, state);
      if (!connection) continue;
      const key = connection.key || (connection.keyEnv ? process.env[connection.keyEnv] : '') || '';
      if (connection.auth !== 'none' && !key) continue;
      for (const model of card.models) {
        if (!model.vision || !model.dimension) continue;
        models.push({
          id: `remote_${card.id}_${model.id}`.replace(/[^\w.-]+/g, '_').slice(0, 180),
          name: `${card.name} · ${model.name}`,
          provider: 'remote_embedding',
          variant: model.id,
          dimension: model.dimension,
          imageSize: 224,
          languages: ['zh', 'en'],
          cardId: card.id,
          protocol: card.protocol,
          baseUrl: connection.baseUrl,
          apiKey: key,
          remoteModel: model.remoteName || model.id,
          imageMode: card.options?.imageMode === 'object' ? 'object' : 'messages',
          imageField: String(card.options?.imageField || 'image_url'),
          imagePrompt: String(card.options?.imagePrompt || 'Represent the given image.'),
          textAsMessages: card.options?.textAsMessages !== false,
          options: card.options ?? {},
        });
      }
    }
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    await writeAtomic(join(this.configDir, 'remote-models.json'), `${JSON.stringify({ models }, null, 2)}\n`, { mode: 0o600 });
    if (this.child && this.port) await this.request('POST', '/v1/models/refresh').catch(() => {});
  }

  /** The global vector library root: chosen in Settings, else OpenFilm's own data folder. */
  globalRoot() {
    try {
      const value = JSON.parse(readFileSync(this.globalFile, 'utf8'))?.root;
      if (typeof value === 'string' && isAbsolute(value)) return resolve(value);
    } catch { /* none chosen yet */ }
    return resolve(this.defaultGlobalRoot);
  }

  setGlobalRoot(/** @type {string} */ root) {
    mkdirSync(studioHome(), { recursive: true });
    writeFileSync(this.globalFile, `${JSON.stringify({ root: resolve(root) }, null, 2)}\n`);
  }

  /** One sidecar library holds every source; assets are keyed by their absolute path. */
  globalLibrary() {
    const root = this.globalRoot();
    return { id: 'global', name: 'Global vector library', kind: 'project', mediaRoot: root, indexRoot: root };
  }

  async ensureGlobal() {
    const library = this.globalLibrary();
    mkdirSync(library.indexRoot, { recursive: true });
    await this.register(library);
    if (!this.legacyChecked) {
      this.legacyChecked = true;
      await this.importLegacy(library);
    }
    return library;
  }

  /** Bring old per-project catalogs into a fresh global library once. */
  async importLegacy(/** @type {{ id: string, mediaRoot: string, indexRoot: string }} */ global) {
    try {
      const current = await this.libraryStatus(global);
      if (current.stores?.length) return;
      const sources = [];
      for (const project of await listProjects()) {
        const indexRoot = join(project.path, '.film', 'index');
        if (existsSync(join(indexRoot, 'catalog.sqlite'))) sources.push({ root: project.path, indexRoot, kind: 'project' });
      }
      for (const external of this.externalLibraries()) {
        if (external.indexRoot && resolve(external.indexRoot) !== resolve(global.indexRoot) && existsSync(join(external.indexRoot, 'catalog.sqlite'))) {
          sources.push({ root: external.path, indexRoot: external.indexRoot, kind: 'external' });
        }
      }
      if (!sources.length) return;
      const result = await this.request('POST', `/v1/libraries/${encodeURIComponent(global.id)}/import-legacy`, { sources }, 120_000);
      if (result.importedStores || result.importedAssets) {
        /* The old folder is derived data and has been copied; keep it recoverable in the system trash. */
        for (const source of sources) {
          if (source.kind !== 'project') continue;
          await moveToTrash(source.indexRoot).catch(() => {});
        }
      }
    } catch {
      /* a failed import leaves the old indexes where they were; the next start can try again */
      this.legacyChecked = true;
    }
  }

  /** Move the one global catalog to another folder, then remember the folder. */
  async changeGlobalRoot(/** @type {string} */ folder) {
    const next = resolve(folder);
    const old = this.globalRoot();
    if (next === old) return;
    const back = relative(old, next);
    const up = relative(next, old);
    if ((back && !back.startsWith(`..${sep}`) && !isAbsolute(back)) || (up && !up.startsWith(`..${sep}`) && !isAbsolute(up))) {
      throw new HttpError(400, 'the new vector folder cannot be inside the old one, or contain it');
    }
    if (await this.hasActiveJobs(['global'])) throw new HttpError(409, 'stop the running index job before moving the vector library');
    await mkdir(next, { recursive: true });
    const existing = await readdir(next).catch(() => []);
    if (existing.length) throw new HttpError(409, 'that folder already has files');
    await this.closeGlobalLibrary();
    this.beginMigration();
    try {
      if (existsSync(old)) {
        await rm(next, { recursive: true, force: true });
        try {
          await rename(old, next);
        } catch (error) {
          if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EXDEV') throw error;
          await cp(old, next, { recursive: true, errorOnExist: true, force: false });
          await rm(old, { recursive: true, force: true });
        }
      }
      this.setGlobalRoot(next);
    } finally {
      this.endMigration();
    }
  }

  async closeGlobalLibrary() {
    if (!this.child || !this.port) return;
    await this.request('DELETE', `/v1/libraries/${encodeURIComponent(this.globalLibrary().id)}`).catch(() => {});
  }

  /** A project's chosen stores, in its own `.film/index.json`; all stores when nothing was chosen yet. */
  projectStores(/** @type {{ id: string, path: string }} */ project, /** @type {readonly { id: string }[]} */ available) {
    const file = join(project.path, '.film', 'index.json');
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(value?.stores)) {
        const known = new Set(available.map((store) => store.id));
        return value.stores.map((/** @type {unknown} */ id) => String(id)).filter((/** @type {string} */ id) => known.has(id));
      }
    } catch { /* no choice yet */ }
    return available.map((store) => store.id);
  }

  setProjectStores(/** @type {{ id: string, path: string }} */ project, /** @type {readonly string[]} */ storeIds) {
    const dir = join(project.path, '.film');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.json'), `${JSON.stringify({ stores: [...new Set(storeIds)] }, null, 2)}\n`);
  }

  /** A source's absolute path, and whether a hit belongs to it. */
  sourceFor(/** @type {string} */ file, /** @type {{ id: string, name: string, path: string }[]} */ projects, /** @type {{ id: string, name: string, path: string }[]} */ externals) {
    const at = resolve(file);
    for (const source of [...projects, ...externals.map((item) => ({ id: item.id, name: item.name, path: item.path }))]) {
      const root = resolve(source.path);
      const rel = relative(root, at);
      if (rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) return { ...source, relPath: rel.replaceAll('\\', '/') };
    }
    return null;
  }

  state() {
    return this.child && this.port
      ? { state: 'ready', port: this.port, python: this.python, modelsRoot: this.modelsRoot, videoSeekRoot: this.videosSeekRoot }
      : { state: this.starting ? 'starting' : this.lastError ? 'error' : 'off', reason: this.lastError || undefined, python: this.python, modelsRoot: this.modelsRoot, videoSeekRoot: this.videosSeekRoot };
  }

  stop() {
    if (this.child) {
      try {
        if (process.platform === 'win32' && this.child.pid) spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else this.child.kill();
      } catch { /* already gone */ }
      this.child = null;
      this.port = 0;
    }
  }

  /** Stop the sidecar, wait for its files to be let go, and start it again (the Settings retry). */
  async restart() {
    if (this.migrating) throw new Error('the projects folder is moving; try again in a moment');
    const old = this.child;
    this.stop();
    if (old) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(undefined); } };
        const timer = setTimeout(finish, 3000);
        old.once('exit', finish);
        old.once('error', finish);
      });
    }
    this.starting = null;
    this.lastError = '';
    await this.ensure();
    return this.health();
  }

  async ensure() {
    if (this.child && this.port) return;
    if (this.starting) return this.starting;
    this.starting = this.startSidecar().finally(() => { this.starting = null; });
    return this.starting;
  }

  /** A library move on disk: close the catalogs that live in it first, and let no status call open them again. */
  beginMigration() { this.migrating = true; }
  endMigration() { this.migrating = false; }

  async closeProjectLibraries(/** @type {readonly string[]} */ ids) {
    if (!this.child || !this.port) return;
    await Promise.all([...new Set(ids)].map((id) =>
      this.request('DELETE', `/v1/libraries/${encodeURIComponent(id)}`).catch(() => {}),
    ));
  }

  /** Whether any of these libraries has a job queued or running (which a move would interrupt). */
  async hasActiveJobs(/** @type {readonly string[]} */ ids) {
    if (!this.child || !this.port) return false;
    for (const id of new Set(ids)) {
      const result = await this.request('GET', `/v1/libraries/${encodeURIComponent(id)}/status`).catch(() => null);
      const state = result?.library?.job?.state;
      if (state === 'queued' || state === 'running') return true;
    }
    return false;
  }

  async startSidecar() {
    this.lastError = '';
    this.stderr = '';
    if (!existsSync(this.sidecar)) throw new Error(`index sidecar not found: ${this.sidecar}`);
    mkdirSync(this.modelsRoot, { recursive: true });
    mkdirSync(this.configDir, { recursive: true });
    this.token = randomBytes(24).toString('hex');
    const args = [
      this.sidecar,
      '--videos-eek-root', this.videosSeekRoot,
      '--models-root', this.modelsRoot,
      '--config-dir', this.configDir,
      '--token', this.token,
    ];
    if (process.env.OPENFILM_INDEX_PREFER_GPU === '1') args.push('--prefer-gpu');
    const child = spawn(this.python, args, { cwd: this.configDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (/** @type {Buffer | string} */ chunk) => { this.stderr = `${this.stderr}${chunk}`.slice(-16_000); });
    child.once('exit', (code) => {
      this.child = null;
      this.port = 0;
      if (code !== 0) this.lastError = this.stderr.trim() || `index sidecar stopped (${code})`;
    });
    const ready = await new Promise((resolveReady, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error(`index sidecar did not start: ${this.stderr.trim() || 'timeout'}`)), 25_000);
      const onData = (/** @type {Buffer | string} */ chunk) => {
        buffer += chunk.toString();
        const line = buffer.split(/\r?\n/)[0];
        if (!line?.trim().startsWith('{')) return;
        try {
          const hello = JSON.parse(line);
          if (!hello.port) return;
          clearTimeout(timer);
          child.stdout?.off('data', onData);
          this.port = Number(hello.port);
          resolveReady(undefined);
        } catch {
          /* the line is not the handshake yet */
        }
      };
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', onData);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(this.stderr.trim() || `index sidecar exited (${code})`)); });
    });
    await ready;
    let lastError = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        await this.request('GET', '/v1/health', undefined, 2_000);
        return;
      } catch (error) {
        lastError = error;
        await new Promise((done) => setTimeout(done, 250));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError || 'index sidecar did not answer'));
  }

  async request(/** @type {string} */ method, /** @type {string} */ path, /** @type {unknown} */ body = undefined, /** @type {number} */ timeout = 60_000) {
    await this.ensure();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const target = new URL(path, `http://127.0.0.1:${this.port}`);
      const response = await fetch(target, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        let message = text;
        try { message = JSON.parse(text).detail || text; } catch { /* plain */ }
        throw new HttpError(response.status, String(message || `index sidecar answered ${response.status}`));
      }
      const type = response.headers.get('content-type') || '';
      return type.includes('application/json') ? response.json() : response;
    } finally {
      clearTimeout(timer);
    }
  }

  async health() {
    try {
      await this.ensure();
      return { ...this.state(), ...(await this.request('GET', '/v1/health', undefined, 10_000)) };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return { ...this.state(), state: 'error', reason: this.lastError };
    }
  }

  async models() {
    try {
      await this.syncRemoteModels();
      return (await this.request('GET', '/v1/models')).models ?? [];
    } catch {
      return [];
    }
  }

  async refreshModels() {
    try { await this.request('POST', '/v1/models/refresh'); } catch { /* sidecar will scan next start */ }
  }

  externalLibraries() {
    try {
      const raw = JSON.parse(readFileSync(this.externalFile, 'utf8'));
      return Array.isArray(raw) ? raw.filter((item) => item && typeof item.id === 'string' && typeof item.path === 'string') : [];
    } catch {
      return [];
    }
  }

  writeExternalLibraries(/** @type {any[]} */ libraries) {
    mkdirSync(studioHome(), { recursive: true });
    writeFileSync(this.externalFile, `${JSON.stringify(libraries, null, 2)}\n`);
  }

  /** The project's index root, beside its film and hidden from git. */
  projectLibrary(/** @type {{ id: string, name: string, path: string }} */ project) {
    /* Kept as a compatibility alias: the global library is what the sidecar now registers. */
    return this.globalLibrary();
  }

  async register(/** @type {{ id: string, name: string, kind: string, mediaRoot: string, indexRoot: string }} */ library) {
    await this.request('POST', '/v1/libraries', library);
    return library;
  }

  async ensureProject(/** @type {{ id: string, name: string, path: string }} */ project) {
    return this.ensureGlobal();
  }

  async ensureExternal() {
    return this.externalLibraries().filter((library) => existsSync(library.path));
  }

  async addExternal(/** @type {{ name?: string, path?: string, indexRoot?: string }} */ input) {
    const mediaRoot = typeof input.path === 'string' ? resolve(input.path) : '';
    if (!mediaRoot || !isAbsolute(mediaRoot)) throw new HttpError(400, 'a folder is required');
    if (!existsSync(mediaRoot)) throw new HttpError(404, 'that folder is not there');
    const libraries = this.externalLibraries();
    const found = libraries.find((item) => resolve(item.path) === mediaRoot);
    if (found) return found;
    const indexRoot = this.globalRoot();
    const library = {
      id: `ext_${sha1(mediaRoot.toLowerCase()).slice(0, 12)}`,
      name: cleanName(input.name, basename(mediaRoot)),
      path: mediaRoot,
      indexRoot,
    };
    this.writeExternalLibraries([...libraries, library]);
    return library;
  }

  async removeExternal(/** @type {string} */ id) {
    const libraries = this.externalLibraries();
    const found = libraries.find((item) => item.id === id);
    if (!found) throw new HttpError(404, 'no such library');
    this.writeExternalLibraries(libraries.filter((item) => item.id !== id));
  }

  async libraryStatus(/** @type {{ id: string }} */ library) {
    const result = await this.request('GET', `/v1/libraries/${encodeURIComponent(library.id)}/status`);
    return result.library;
  }

  async libraryStores() {
    const library = await this.libraryStatus(this.globalLibrary());
    return library.stores ?? [];
  }

  async reconcileLibrary(/** @type {{ id: string, name: string, kind: string, mediaRoot: string, indexRoot: string }} */ library, /** @type {string[]} */ scope = []) {
    const assets = await this.assets(library.mediaRoot);
    const result = await this.request('POST', `/v1/libraries/${encodeURIComponent(library.id)}/reconcile`, { assets, scope });
    return result.library;
  }

  /** Reconcile one source (a project or an external folder) inside the global library. */
  async reconcileSource(/** @type {string} */ root) {
    const assets = await this.assets(root);
    const global = this.globalLibrary();
    const result = await this.request('POST', `/v1/libraries/${encodeURIComponent(global.id)}/reconcile`, { assets, scope: [resolve(root)] });
    return result.library;
  }

  async reconcileExternal(/** @type {{ id: string, name: string, kind: string, mediaRoot: string, indexRoot: string }} */ library) {
    const root = this.globalLibrary();
    const cached = this.externalScans.get(library.id);
    const assets = cached && Date.now() - cached.at < 1000 ? cached.assets : await this.assets(library.mediaRoot, {}, true);
    if (!cached || assets !== cached.assets) this.externalScans.set(library.id, { at: Date.now(), assets });
    const result = await this.request('POST', `/v1/libraries/${encodeURIComponent(root.id)}/reconcile`, { assets, scope: [resolve(library.mediaRoot)] });
    return result.library;
  }

  async assets(/** @type {string} */ mediaRoot, /** @type {{ assetIds?: string[], folders?: string[] }} */ input = {}, /** @type {boolean} */ external = false) {
    const listing = external ? await scanVisualMedia(mediaRoot) : await listFiles(mediaRoot);
    const files = /** @type {any[]} */ (external ? listing : /** @type {{ files: any[] }} */ (listing).files);
    const wanted = new Set(Array.isArray(input.assetIds) ? input.assetIds : []);
    const folders = Array.isArray(input.folders) ? input.folders.map((folder) => String(folder).replace(/^\/+|\/+$/g, '')) : [];
    return files
      .filter((file) => file.kind === 'video' || file.kind === 'image')
      .filter((file) => (!wanted.size || wanted.has(file.path)) && (!folders.length || folders.some((folder) => file.path === folder || file.path.startsWith(`${folder}/`))))
      .map((file) => ({ path: join(mediaRoot, file.path), name: basename(file.path), kind: file.kind, size: file.size, mtimeMs: file.mtime, durationMs: 0 }));
  }

  async status(/** @type {{ id: string, name: string, path: string } | null} */ project = null) {
    const health = this.migrating ? this.state() : await this.health();
    if (health.state !== 'ready' || this.migrating) {
      return { sidecar: health, project: null, libraries: [], models: [], root: this.globalRoot() };
    }
    const global = await this.ensureGlobal();
    const external = await this.ensureExternal();
    /* Reconcile only this project's source; the sidecar's scope keeps other projects' rows untouched.
       With no project open the global catalog and external libraries are still readable. */
    const globalStatus = project
      ? (await this.reconcileSource(project.path).catch(() => this.libraryStatus(global))) ?? await this.libraryStatus(global)
      : await this.libraryStatus(global);
    const jobSource = globalStatus.job?.id ? this.jobSources.get(globalStatus.job.id) : null;
    const projectStatus = project
      ? this.libraryView(globalStatus, project, Object.fromEntries(Object.entries(globalStatus.assetStates ?? {}).filter(([file]) => inside(project.path, file))), undefined, jobSource === project.id ? globalStatus.job : null)
      : null;
    const libraries = external.map((item) => {
      const states = Object.fromEntries(Object.entries(globalStatus.assetStates ?? {}).filter(([file]) => inside(item.path, file)));
      return this.libraryView(globalStatus, { id: item.id, name: item.name, path: item.path }, states, item, jobSource === item.id ? globalStatus.job : null);
    });
    const globalView = this.libraryView(globalStatus, { id: 'global', name: '全局向量库', path: this.globalRoot() }, globalStatus.assetStates ?? {}, undefined, null);
    return {
      sidecar: health,
      project: projectStatus,
      global: globalView,
      libraries,
      models: await this.models(),
      root: this.globalRoot(),
    };
  }

  /** A source's view of the one global catalog: its own counts, but the shared store list. */
  libraryView(/** @type {any} */ globalStatus, /** @type {{ id: string, name: string, path: string }} */ source, /** @type {Record<string, string>} */ states, /** @type {{ id: string, name: string, path: string, indexRoot?: string } | undefined} */ external = undefined, /** @type {any} */ job = null) {
    const counts = Object.values(states).reduce((all, state) => { all[state] = (all[state] ?? 0) + 1; return all; }, /** @type {Record<string, number>} */ ({}));
    const relativeStates = Object.fromEntries(Object.entries(states).map(([file, state]) => {
      const rel = relative(source.path, file);
      return [rel && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel.replaceAll('\\', '/') : file, state];
    }));
    const available = globalStatus.stores ?? [];
    const storeIds = external ? available.map((/** @type {any} */ store) => store.id) : this.projectStores(source, available);
    return {
      id: source.id,
      name: source.name,
      kind: external ? 'external' : 'project',
      mediaRoot: source.path,
      indexRoot: this.globalRoot(),
      assets: {
        total: Object.keys(states).length,
        ready: counts.ready ?? 0,
        stale: counts.stale ?? 0,
        missing: counts.missing ?? 0,
        error: counts.error ?? 0,
        notIndexed: (counts['not-indexed'] ?? 0) + (counts.idle ?? 0),
        unsupported: counts.unsupported ?? 0,
        excluded: 0,
      },
      stores: available,
      storeIds,
      assetStates: relativeStates,
      job,
    };
  }

  async defaultModel() {
    const models = await this.models();
    return models.find((/** @type {any} */ model) => model.id === this.preferredModel)?.id ?? models[0]?.id ?? null;
  }

  async startProjectJob(/** @type {{ id: string, name: string, path: string }} */ project, /** @type {{ modelId?: string, mode?: string, assetIds?: string[], folders?: string[] }} */ input) {
    if (this.migrating) throw new HttpError(503, 'the projects folder is moving; try again in a moment');
    const global = await this.ensureGlobal();
    const assets = await this.assets(project.path, input);
    if (!assets.length) throw new HttpError(409, 'there are no unindexed video or image files in that scope');
    const modelId = input.modelId || await this.defaultModel();
    if (!modelId) throw new HttpError(409, 'no local model is installed');
    const result = await this.request('POST', '/v1/index/jobs', {
      libraryId: global.id,
      modelId,
      mode: input.mode || 'update',
      assets,
    }, 30_000);
    if (result.job?.id) this.jobSources.set(result.job.id, project.id);
    if (result.storeId) {
      const chosen = this.projectStores(project, await this.libraryStores());
      this.setProjectStores(project, [...chosen, result.storeId]);
    }
    return result;
  }

  async startExternalJob(/** @type {string} */ libraryId, /** @type {{ modelId?: string, mode?: string, assetIds?: string[], folders?: string[] }} */ input) {
    const global = await this.ensureGlobal();
    await this.ensureExternal();
    const external = this.externalLibraries().find((item) => item.id === libraryId);
    if (!external) throw new HttpError(404, 'no such external library');
    const assets = await this.assets(external.path, input, true);
    await this.request('POST', `/v1/libraries/${encodeURIComponent(global.id)}/reconcile`, { assets, scope: [resolve(external.path)] }).catch(() => {});
    if (!assets.length) throw new HttpError(409, 'there are no video or image files in that scope');
    const modelId = input.modelId || await this.defaultModel();
    if (!modelId) throw new HttpError(409, 'no local model is installed');
    const result = await this.request('POST', '/v1/index/jobs', {
      libraryId: global.id,
      modelId,
      mode: input.mode || 'update',
      assets,
    }, 30_000);
    if (result.job?.id) this.jobSources.set(result.job.id, libraryId);
    return result;
  }

  async job(/** @type {string} */ libraryId, /** @type {string} */ jobId) {
    return this.request('GET', `/v1/index/jobs/${encodeURIComponent(jobId)}?libraryId=${encodeURIComponent(this.globalLibrary().id)}`);
  }

  async cancelJob(/** @type {string} */ libraryId, /** @type {string} */ jobId) {
    return this.request('POST', `/v1/index/jobs/${encodeURIComponent(jobId)}/cancel?libraryId=${encodeURIComponent(this.globalLibrary().id)}`);
  }

  async removeProjectIndex(/** @type {{ id: string, name: string, path: string }} */ project) {
    if (!this.child || !this.port) return;
    const global = this.globalLibrary();
    await this.request('POST', `/v1/libraries/${encodeURIComponent(global.id)}/remove-source`, { root: resolve(project.path) }).catch(() => {});
  }

  /** Delete one vector store (and its vectors) from a library, or every store when no id is given. */
  async removeStore(/** @type {string} */ libraryId, /** @type {string} */ storeId = '') {
    if (!this.child || !this.port) return;
    const query = storeId ? `?storeId=${encodeURIComponent(storeId)}` : '';
    await this.request('DELETE', `/v1/libraries/${encodeURIComponent(libraryId)}/index${query}`);
  }

  async removeProjectLibrary(/** @type {{ id: string, name: string, path: string }} */ project) {
    /* The global library outlives the project; nothing to unregister by project id. */
    void project;
  }

  async search(/** @type {{ id: string, name: string, path: string }} */ project, /** @type {any} */ input) {
    if (this.migrating) throw new HttpError(503, 'the projects folder is moving; try again in a moment');
    const global = await this.ensureGlobal();
    const available = await this.libraryStores();
    const selected = this.projectStores(project, available);
    if (!selected.length) {
      return { hits: [], meta: { returned: 0, elapsedMs: 0, mode: input.mode === 'frame' ? 'frame' : 'chunk', storeIds: [], modelIds: [], indexState: 'ready' } };
    }
    const requested = Array.isArray(input.libraryIds) && input.libraryIds.length ? input.libraryIds.map(String) : [];
    const body = {
      libraryIds: [global.id],
      storeIds: selected,
      query: input.query,
      mode: input.mode === 'frame' ? 'frame' : 'chunk',
      topK: Math.max(1, Math.min(500, Number(input.topK) || 100)),
      filters: input.filters || {},
    };
    const result = await this.request('POST', '/v1/search', body, 120_000);
    const projects = await listProjects();
    const externals = this.externalLibraries();
    result.hits = (result.hits || []).map((/** @type {any} */ hit) => {
      const source = this.sourceFor(hit.path, projects, externals);
      const relativePath = source?.relPath ?? basename(hit.path);
      return {
        ...hit,
        libraryId: source?.id ?? hit.libraryId,
        libraryName: source?.name ?? hit.libraryName,
        path: relativePath,
        assetId: hit.path,
        dir: relativePath.includes('/') ? relativePath.slice(0, relativePath.lastIndexOf('/')) : '',
        thumbUrl: `/api/index/thumb?libraryId=${encodeURIComponent(global.id)}&path=${encodeURIComponent(hit.path)}&ms=${Math.round(hit.anchorMs || 0)}&w=480`,
      };
    });
    /* The old search scope still means something: this project only, one external library, or all shared stores. */
    if (requested.length) {
      const allow = new Set(requested);
      result.hits = result.hits.filter((/** @type {any} */ hit) => allow.has(hit.libraryId));
    }
    return result;
  }

  async thumb(/** @type {URLSearchParams} */ query) {
    const libraryId = query.get('libraryId') || '';
    const path = query.get('path') || '';
    const ms = Number(query.get('ms') || 0);
    const w = Number(query.get('w') || 480);
    if (!libraryId || !path) throw new HttpError(400, 'libraryId and path are required');
    /* a page can show a cached storyboard before it asks for the index status: register the one global library
       first, so its thumbnails do not fail after a sidecar restart */
    if (libraryId === 'global') await this.ensureGlobal();
    const response = await this.request('GET', `/v1/thumb?libraryId=${encodeURIComponent(libraryId)}&path=${encodeURIComponent(path)}&ms=${Math.round(ms)}&w=${Math.round(w)}`, undefined, 45_000);
    return response;
  }

  /** Import a model package zip into the shared models folder. */
  async importModel(/** @type {Buffer} */ bytes, /** @type {string} */ filename) {
    if (!bytes.length) throw new HttpError(400, 'the model zip is empty');
    const temporary = await mkdtemp(join(tmpdir(), 'openfilm-model-'));
    const zip = join(temporary, filename || 'model.zip');
    await writeFile(zip, bytes);
    const unpacked = join(temporary, 'unpacked');
    await mkdir(unpacked, { recursive: true });
    try {
      await run(this.python, ['-c', 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, unpacked], { windowsHide: true });
    } catch (error) {
      throw new HttpError(400, `the model zip could not be opened: ${error instanceof Error ? error.message : String(error)}`);
    }
    let manifestFile = '';
    const walk = async (/** @type {string} */ dir) => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const at = join(dir, entry.name);
        if (entry.isDirectory()) await walk(at);
        else if (entry.name === 'model_manifest.json') manifestFile = at;
      }
    };
    await walk(unpacked);
    if (!manifestFile) throw new HttpError(400, 'model_manifest.json is missing from the zip');
    const manifest = JSON.parse((await readFile(manifestFile, 'utf8')).replace(/^\uFEFF/, ''));
    const provider = String(manifest.provider || '').trim();
    const variant = String(manifest.variant || manifest.model_variant || '').trim();
    if (!provider || !variant) throw new HttpError(400, 'model_manifest.json needs provider and variant');
    const required = Array.isArray(manifest.required_files) ? manifest.required_files.map(String) : [];
    const source = dirname(manifestFile);
    for (const name of required) {
      if (!existsSync(join(source, name))) throw new HttpError(400, `the model package is missing ${name}`);
    }
    const target = join(this.modelsRoot, providerDir(provider), variant);
    await mkdir(dirname(target), { recursive: true });
    const old = `${target}.old-${Date.now()}`;
    if (existsSync(target)) await rename(target, old);
    await rename(source, target).catch(async (error) => {
      if (error?.code === 'EXDEV') {
        await cp(source, target, { recursive: true });
        return;
      }
      if (existsSync(old)) await rename(old, target);
      throw error;
    });
    await rm(old, { recursive: true, force: true }).catch(() => {});
    await this.refreshModels();
    await rm(temporary, { recursive: true, force: true }).catch(() => {});
    return { model: String(manifest.id || `${provider}_${variant}`), path: target };
  }
}
