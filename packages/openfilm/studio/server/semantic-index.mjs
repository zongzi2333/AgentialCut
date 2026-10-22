// @ts-check
/**
 * The bridge between Studio and the local semantic-index sidecar.
 *
 * The sidecar owns extraction, encoding, chunking and vectors. This module owns the process, the
 * project/extra-library roots, the model-pack import, and the mapping back to Studio's files.
 *
 * Indexes are derived data and live beside the media:
 *   <project>/.film/index/
 *   <external library>/.openfilm/index/
 * Nothing here writes media.
 */
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile, cp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { listFiles } from './files.mjs';
import { HttpError } from './http.mjs';
import { studioHome } from './projects.mjs';

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
    return {
      id: project.id,
      name: project.name,
      kind: 'project',
      mediaRoot: project.path,
      indexRoot: join(project.path, '.film', 'index'),
    };
  }

  async register(/** @type {{ id: string, name: string, kind: string, mediaRoot: string, indexRoot: string }} */ library) {
    await this.request('POST', '/v1/libraries', library);
    return library;
  }

  async ensureProject(/** @type {{ id: string, name: string, path: string }} */ project) {
    const library = this.projectLibrary(project);
    await this.register(library);
    return library;
  }

  async ensureExternal() {
    const libraries = this.externalLibraries();
    for (const library of libraries) {
      if (!existsSync(library.path)) continue;
      await this.register({
        id: library.id,
        name: library.name,
        kind: 'external',
        mediaRoot: library.path,
        indexRoot: library.indexRoot,
      }).catch(() => {});
    }
    return libraries;
  }

  async addExternal(/** @type {{ name?: string, path?: string, indexRoot?: string }} */ input) {
    const mediaRoot = typeof input.path === 'string' ? resolve(input.path) : '';
    if (!mediaRoot || !isAbsolute(mediaRoot)) throw new HttpError(400, 'a folder is required');
    if (!existsSync(mediaRoot)) throw new HttpError(404, 'that folder is not there');
    const libraries = this.externalLibraries();
    const found = libraries.find((item) => resolve(item.path) === mediaRoot);
    if (found) return found;
    const indexRoot = typeof input.indexRoot === 'string' && input.indexRoot
      ? resolve(input.indexRoot)
      : join(mediaRoot, '.openfilm', 'index');
    const library = {
      id: `ext_${sha1(mediaRoot.toLowerCase()).slice(0, 12)}`,
      name: cleanName(input.name, basename(mediaRoot)),
      path: mediaRoot,
      indexRoot,
    };
    await this.register({ ...library, kind: 'external', mediaRoot: library.path });
    this.writeExternalLibraries([...libraries, library]);
    return library;
  }

  async removeExternal(/** @type {string} */ id) {
    const libraries = this.externalLibraries();
    const found = libraries.find((item) => item.id === id);
    if (!found) throw new HttpError(404, 'no such library');
    this.writeExternalLibraries(libraries.filter((item) => item.id !== id));
    await this.request('DELETE', `/v1/libraries/${encodeURIComponent(id)}`).catch(() => {});
  }

  async libraryStatus(/** @type {{ id: string, name: string, kind: string, mediaRoot: string, indexRoot: string }} */ library) {
    const result = await this.request('GET', `/v1/libraries/${encodeURIComponent(library.id)}/status`);
    return result.library;
  }

  async reconcileLibrary(/** @type {{ id: string, name: string, kind: string, mediaRoot: string, indexRoot: string }} */ library) {
    const assets = await this.assets(library.mediaRoot);
    const result = await this.request('POST', `/v1/libraries/${encodeURIComponent(library.id)}/reconcile`, { assets });
    return result.library;
  }

  async reconcileExternal(/** @type {{ id: string, name: string, kind: string, mediaRoot: string, indexRoot: string }} */ library) {
    const cached = this.externalScans.get(library.id);
    const assets = cached && Date.now() - cached.at < 1000 ? cached.assets : await this.assets(library.mediaRoot, {}, true);
    if (!cached || assets !== cached.assets) this.externalScans.set(library.id, { at: Date.now(), assets });
    const result = await this.request('POST', `/v1/libraries/${encodeURIComponent(library.id)}/reconcile`, { assets });
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
      .map((file) => ({ path: file.path, name: basename(file.path), kind: file.kind, size: file.size, mtimeMs: file.mtime, durationMs: 0 }));
  }

  async status(/** @type {{ id: string, name: string, path: string }} */ project) {
    const health = this.migrating ? this.state() : await this.health();
    if (health.state !== 'ready' || this.migrating) {
      return { sidecar: health, project: null, libraries: [], models: [] };
    }
    await this.ensureExternal();
    const projectLibrary = await this.ensureProject(project);
    const projectStatus = await this.reconcileLibrary(projectLibrary).catch(async () => this.libraryStatus(projectLibrary));
    const libraries = [];
    for (const external of this.externalLibraries()) {
      try {
        libraries.push(await this.reconcileExternal({
          id: external.id,
          name: external.name,
          kind: 'external',
          mediaRoot: external.path,
          indexRoot: external.indexRoot,
        }));
      } catch (error) {
        libraries.push({ id: external.id, name: external.name, kind: 'external', mediaRoot: external.path, indexRoot: external.indexRoot, offline: true, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return {
      sidecar: health,
      project: projectStatus,
      libraries,
      models: await this.models(),
    };
  }

  async defaultModel() {
    const models = await this.models();
    return models.find((/** @type {any} */ model) => model.id === this.preferredModel)?.id ?? models[0]?.id ?? null;
  }

  async startProjectJob(/** @type {{ id: string, name: string, path: string }} */ project, /** @type {{ modelId?: string, mode?: string, assetIds?: string[], folders?: string[] }} */ input) {
    if (this.migrating) throw new HttpError(503, 'the projects folder is moving; try again in a moment');
    await this.ensureProject(project);
    const assets = await this.assets(project.path, input);
    if (!assets.length) throw new HttpError(409, 'there are no unindexed video or image files in that scope');
    const modelId = input.modelId || await this.defaultModel();
    if (!modelId) throw new HttpError(409, 'no local model is installed');
    const result = await this.request('POST', '/v1/index/jobs', {
      libraryId: project.id,
      modelId,
      mode: input.mode || 'update',
      assets,
    }, 30_000);
    return result;
  }

  async startExternalJob(/** @type {string} */ libraryId, /** @type {{ modelId?: string, mode?: string, assetIds?: string[], folders?: string[] }} */ input) {
    await this.ensureExternal();
    const external = this.externalLibraries().find((item) => item.id === libraryId);
    if (!external) throw new HttpError(404, 'no such external library');
    const assets = await this.assets(external.path, input, true);
    await this.request('POST', `/v1/libraries/${encodeURIComponent(libraryId)}/reconcile`, { assets }).catch(() => {});
    if (!assets.length) throw new HttpError(409, 'there are no video or image files in that scope');
    const modelId = input.modelId || await this.defaultModel();
    if (!modelId) throw new HttpError(409, 'no local model is installed');
    return this.request('POST', '/v1/index/jobs', {
      libraryId,
      modelId,
      mode: input.mode || 'update',
      assets,
    }, 30_000);
  }

  async job(/** @type {string} */ libraryId, /** @type {string} */ jobId) {
    return this.request('GET', `/v1/index/jobs/${encodeURIComponent(jobId)}?libraryId=${encodeURIComponent(libraryId)}`);
  }

  async cancelJob(/** @type {string} */ libraryId, /** @type {string} */ jobId) {
    return this.request('POST', `/v1/index/jobs/${encodeURIComponent(jobId)}/cancel?libraryId=${encodeURIComponent(libraryId)}`);
  }

  async removeProjectIndex(/** @type {{ id: string, name: string, path: string }} */ project) {
    if (!this.child || !this.port) return;
    const library = this.projectLibrary(project);
    await this.removeStore(library.id);
  }

  /** Delete one vector store (and its vectors) from a library, or every store when no id is given. */
  async removeStore(/** @type {string} */ libraryId, /** @type {string} */ storeId = '') {
    if (!this.child || !this.port) return;
    const query = storeId ? `?storeId=${encodeURIComponent(storeId)}` : '';
    await this.request('DELETE', `/v1/libraries/${encodeURIComponent(libraryId)}/index${query}`);
  }

  async removeProjectLibrary(/** @type {{ id: string, name: string, path: string }} */ project) {
    if (!this.child || !this.port) return;
    await this.request('DELETE', `/v1/libraries/${encodeURIComponent(project.id)}`).catch(() => {});
  }

  async search(/** @type {{ id: string, name: string, path: string }} */ project, /** @type {any} */ input) {
    if (this.migrating) throw new HttpError(503, 'the projects folder is moving; try again in a moment');
    await this.ensureProject(project);
    await this.ensureExternal();
    const all = [...new Set([project.id, ...this.externalLibraries().map((item) => item.id)])];
    const libraryIds = Array.isArray(input.libraryIds) && input.libraryIds.length ? input.libraryIds.filter((/** @type {string} */ id) => all.includes(id)) : [project.id];
    const body = {
      libraryIds,
      query: input.query,
      mode: input.mode === 'frame' ? 'frame' : 'chunk',
      topK: Math.max(1, Math.min(500, Number(input.topK) || 100)),
      filters: input.filters || {},
    };
    const result = await this.request('POST', '/v1/search', body, 120_000);
    const listing = await listFiles(project.path);
    const files = new Map(listing.files.map((/** @type {any} */ file) => [file.path, file]));
    const projectName = project.name;
    const externalNames = new Map(this.externalLibraries().map((item) => [item.id, item.name]));
    result.hits = (result.hits || []).map((/** @type {any} */ hit) => {
      const file = hit.libraryId === project.id ? files.get(hit.path) : null;
      return {
        ...hit,
        libraryName: hit.libraryId === project.id ? projectName : (externalNames.get(hit.libraryId) || hit.libraryName),
        kind: file?.kind ?? hit.kind ?? 'video',
        size: file?.size ?? hit.size ?? 0,
        dir: file?.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '',
        thumbUrl: `/api/index/thumb?libraryId=${encodeURIComponent(hit.libraryId)}&path=${encodeURIComponent(hit.path)}&ms=${Math.round(hit.anchorMs || 0)}&w=480`,
      };
    });
    return result;
  }

  async thumb(/** @type {URLSearchParams} */ query) {
    const libraryId = query.get('libraryId') || '';
    const path = query.get('path') || '';
    const ms = Number(query.get('ms') || 0);
    const w = Number(query.get('w') || 480);
    if (!libraryId || !path) throw new HttpError(400, 'libraryId and path are required');
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
