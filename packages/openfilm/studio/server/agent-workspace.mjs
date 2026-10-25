// @ts-check
/**
 * A project's agent workspace: a hidden folder beside the film where an agent can keep scratch files
 * and run small Node/Python programs without inventing a second project format.
 *
 * The workspace is project-scoped, so moving or removing the project moves it too. Each agent role
 * gets its own subfolder; code runs with that folder as its cwd. This is deliberately not a general
 * shell: there is no shell command string and no provider key in the environment. It is a local
 * convenience for the person's own project, not a security sandbox.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, lstat, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HttpError } from './http.mjs';

const ROLES = new Set(['planner', 'storyboard', 'material', 'edit', 'audio', 'qc', 'conversation', 'shared']);
const MAX_INPUT = 512 * 1024;
const MAX_OUTPUT = 64 * 1024;
const MAX_CODE = 200 * 1024;
const DEFAULT_TIMEOUT = 10_000;
const MAX_TIMEOUT = 30_000;
const WORKSPACE = join('.film', 'agent-workspace');

/** A role directory name that cannot escape the workspace. */
export function workspaceRole(/** @type {string} */ role) {
  return ROLES.has(role) ? role : 'shared';
}

/** The project-relative workspace root. */
export function workspaceRel(/** @type {{ path: string }} */ project) {
  return WORKSPACE.split(sep).join('/');
}

/** The project-relative directory for one role. */
export function roleWorkspaceRel(/** @type {{ path: string }} */ project, /** @type {string} */ role) {
  return `${workspaceRel(project)}/${workspaceRole(role)}`;
}

/** Create the role workspace and return its absolute path. */
export async function ensureWorkspace(/** @type {{ path: string }} */ project, /** @type {string} */ role) {
  const dir = join(project.path, WORKSPACE, workspaceRole(role));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Resolve a workspace-relative path, refusing anything that leaves the role folder. */
export async function safeWorkspacePath(/** @type {{ path: string }} */ project, /** @type {string} */ role, /** @type {unknown} */ rel, /** @type {{ create?: boolean }} */ options = {}) {
  const dir = await ensureWorkspace(project, role);
  const asked = typeof rel === 'string' ? rel : '.';
  if (asked.includes('\0')) throw new HttpError(400, 'workspace path contains a NUL');
  if (isAbsolute(asked) || /^[a-zA-Z]:/.test(asked)) throw new HttpError(400, 'workspace paths are relative to the agent workspace');
  const abs = resolve(dir, asked);
  const back = relative(dir, abs);
  if (back === '..' || back.startsWith(`..${sep}`)) throw new HttpError(400, 'workspace path leaves the agent workspace');
  if (!options.create) {
    try { await lstat(abs); } catch { throw new HttpError(404, 'that workspace file does not exist'); }
  }
  /* A link made by a script is not followed for reads/writes; it could point into the project. */
  try {
    const info = await lstat(abs);
    if (info.isSymbolicLink()) throw new HttpError(400, 'workspace tools do not follow symlinks');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    /* not there yet: a write may create it */
  }
  return abs;
}

/** Read a text file from the role workspace. */
export async function readWorkspaceFile(/** @type {{ path: string }} */ project, /** @type {string} */ role, /** @type {unknown} */ rel) {
  const abs = await safeWorkspacePath(project, role, rel);
  const info = await stat(abs);
  if (!info.isFile()) throw new HttpError(400, 'workspace path is not a file');
  if (info.size > MAX_INPUT) throw new HttpError(413, 'workspace file is too large to read');
  return { path: relative(project.path, abs).split(sep).join('/'), text: await readFile(abs, 'utf8'), size: info.size };
}

/** Write a text file into the role workspace, making parent folders inside it. */
export async function writeWorkspaceFile(/** @type {{ path: string }} */ project, /** @type {string} */ role, /** @type {unknown} */ rel, /** @type {unknown} */ content) {
  if (typeof content !== 'string') throw new HttpError(400, 'workspace content must be text');
  if (content.length > MAX_INPUT) throw new HttpError(413, 'workspace content is too large');
  const abs = await safeWorkspacePath(project, role, rel, { create: true });
  try {
    const info = await lstat(abs);
    if (info.isSymbolicLink()) throw new HttpError(400, 'workspace tools do not follow symlinks');
    if (info.isDirectory()) throw new HttpError(400, 'workspace path is a folder');
  } catch (error) {
    if (error instanceof HttpError) throw error;
  }
  await mkdir(resolve(abs, '..'), { recursive: true, mode: 0o700 });
  await writeFile(abs, content, { mode: 0o600 });
  return { path: relative(project.path, abs).split(sep).join('/'), size: Buffer.byteLength(content) };
}

/** List files and folders in a role workspace without following links. */
export async function listWorkspace(/** @type {{ path: string }} */ project, /** @type {string} */ role, /** @type {unknown} */ rel = '.') {
  const abs = await safeWorkspacePath(project, role, rel);
  const info = await stat(abs);
  if (!info.isDirectory()) throw new HttpError(400, 'workspace path is not a folder');
  const entries = await readdir(abs, { withFileTypes: true });
  const files = [];
  const folders = [];
  for (const entry of entries.slice(0, 500)) {
    if (entry.isSymbolicLink()) continue;
    const pathname = relative(project.path, join(abs, entry.name)).split(sep).join('/');
    if (entry.isDirectory()) folders.push(pathname);
    else if (entry.isFile()) {
      const at = await stat(join(abs, entry.name));
      files.push({ path: pathname, size: at.size, mtime: at.mtimeMs });
    }
  }
  return {
    workspace: relative(project.path, abs).split(sep).join('/'),
    files,
    folders,
    truncated: entries.length > 500,
  };
}

/** A tiny, key-free environment; the script can still use its own process APIs. */
function codeEnv(/** @type {{ path: string }} */ project, /** @type {string} */ role, /** @type {string} */ dir) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'SystemRoot', 'ComSpec', 'PATHEXT', 'LANG', 'LC_ALL']) {
    if (typeof process.env[key] === 'string') env[key] = String(process.env[key]);
  }
  env.OPENFILM_PROJECT = project.path;
  env.OPENFILM_WORKSPACE = dir;
  env.OPENFILM_AGENT_ROLE = workspaceRole(role);
  return env;
}

/** Run one Node or Python source file inside the role workspace. */
export async function runWorkspaceCode(
  /** @type {{ path: string }} */ project,
  /** @type {string} */ role,
  /** @type {{ language?: unknown, code?: unknown, timeoutMs?: unknown, signal?: AbortSignal }} */ input,
) {
  const language = input?.language === 'python' ? 'python' : input?.language === 'node' ? 'node' : '';
  if (!language) throw new HttpError(400, 'language must be node or python');
  const code = typeof input?.code === 'string' ? input.code : '';
  if (!code.trim()) throw new HttpError(400, 'code is required');
  if (code.length > MAX_CODE) throw new HttpError(413, 'code is too large');
  const timeoutMs = Math.max(250, Math.min(MAX_TIMEOUT, Number(input?.timeoutMs) || DEFAULT_TIMEOUT));
  const dir = await ensureWorkspace(project, role);
  const scripts = join(dir, 'scripts');
  await mkdir(scripts, { recursive: true, mode: 0o700 });
  const id = randomBytes(5).toString('hex');
  const file = join(scripts, `run-${id}.${language === 'node' ? 'mjs' : 'py'}`);
  await writeFile(file, code, { mode: 0o600 });

  const executable = language === 'node' ? process.execPath : (process.env.OPENFILM_PYTHON || 'python');
  const startedAt = Date.now();
  const child = spawn(executable, [file], {
    cwd: dir,
    env: codeEnv(project, role, dir),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let truncated = false;
  let timedOut = false;
  const append = (/** @type {'stdout'|'stderr'} */ kind, /** @type {Buffer} */ chunk) => {
    const next = (kind === 'stdout' ? stdout : stderr) + chunk.toString('utf8');
    const limited = next.slice(0, MAX_OUTPUT);
    if (next.length > MAX_OUTPUT) truncated = true;
    if (kind === 'stdout') stdout = limited;
    else stderr = limited;
  };
  child.stdout.on('data', (chunk) => append('stdout', chunk));
  child.stderr.on('data', (chunk) => append('stderr', chunk));
  const stop = () => { if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL'); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  const abort = () => stop();
  input?.signal?.addEventListener('abort', abort, { once: true });

  try {
    const result = await new Promise((done, fail) => {
      child.once('error', fail);
      child.once('close', (exitCode, signal) => done({ exitCode, signal }));
    });
    return {
      language,
      path: relative(project.path, file).split(sep).join('/'),
      workspace: relative(project.path, dir).split(sep).join('/'),
      exitCode: result.exitCode,
      signal: result.signal,
      stdout,
      stderr,
      truncated: truncated || stdout.length >= MAX_OUTPUT || stderr.length >= MAX_OUTPUT,
      timedOut,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const code = /** @type {{ code?: string }} */ (error)?.code;
    if (code === 'ENOENT') throw new HttpError(409, language === 'python' ? 'Python 不可用：请安装 Python 或设置 OPENFILM_PYTHON。' : 'Node 可执行文件不可用。');
    throw new HttpError(502, `代码执行失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    input?.signal?.removeEventListener('abort', abort);
  }
}
