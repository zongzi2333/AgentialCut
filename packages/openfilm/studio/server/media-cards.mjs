// @ts-check
/**
 * Media cards that are not one of the built-in adapters: OpenAI-compatible speech, transcription,
 * image, and a generic asynchronous video job. The built-in providers still run through their own
 * modules; this is the "custom" or cross-vendor path.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

/** @typedef {import('./provider-cards.mjs').ProviderCard} ProviderCard */
/** @typedef {import('./provider-cards.mjs').Connection} Connection */
/** @typedef {import('./provider-cards.mjs').CardModel} CardModel */

const endpoint = (/** @type {string} */ base, /** @type {string} */ path) => {
  const clean = String(base || '').replace(/\/+$/, '');
  if (!clean) throw new Error('Base URL is empty');
  return clean.endsWith(path) ? clean : `${clean}${path}`;
};
const headersFor = (/** @type {Connection} */ connection, /** @type {string} */ key) => {
  /** @type {Record<string, string>} */
  const headers = { ...(connection.headers ?? {}) };
  if (key && connection.auth === 'bearer') headers.authorization = `Bearer ${key}`;
  else if (key && connection.auth === 'api-key') headers[connection.authHeader || 'x-api-key'] = key;
  return headers;
};
const keyOf = (/** @type {Connection} */ connection) => connection.key || (connection.keyEnv ? process.env[connection.keyEnv] ?? '' : '');

function outName(/** @type {any} */ args, /** @type {string} */ fallback) {
  const raw = String(args?.out || fallback).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 100);
  return raw || fallback;
}

async function save(/** @type {string} */ root, /** @type {string} */ relative, /** @type {Uint8Array | ArrayBuffer} */ bytes) {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes));
  return relative;
}

/** @param {string} root @param {string} relative */
async function readProjectFile(root, relative) {
  const path = join(root, relative);
  const bytes = await readFile(path);
  return { path, bytes, name: basename(path) };
}

async function fetchChecked(/** @type {string} */ url, /** @type {RequestInit} */ init, /** @type {number} */ timeout = 300_000) {
  let response;
  try { response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout), redirect: 'error' }); }
  catch (error) { throw new Error(`connection failed: ${error instanceof Error ? error.message : String(error)}`); }
  if (!response.ok) throw new Error(`service answered ${response.status}: ${(await response.text().catch(() => '')).slice(0, 400)}`);
  return response;
}

/**
 * Run a media capability through a custom card. Returns a receipt string in the same spirit as
 * `openfilm get`, so callers and agents can read what landed without knowing the provider.
 */
export async function runCardMedia(/** @type {string} */ root, /** @type {string} */ verb, /** @type {Record<string, any>} */ args, /** @type {ProviderCard} */ card, /** @type {Connection} */ connection, /** @type {CardModel} */ model) {
  const key = keyOf(connection);
  if (connection.auth !== 'none' && !key) throw new Error(`“${card.name}”还没有设置 API Key`);
  const remote = model.remoteName || model.id;
  if (verb === 'tts' || verb === 'music' || verb === 'sfx') {
    const path = verb === 'tts' ? '/audio/speech' : '/audio/generations';
    const response = await fetchChecked(endpoint(connection.baseUrl, path), {
      method: 'POST', headers: { ...headersFor(connection, key), 'content-type': 'application/json' },
      body: JSON.stringify({ model: remote, input: args.text || args.prompt, voice: args.voice, response_format: 'mp3', ...(args.sec ? { duration: Number(args.sec) } : {}) }),
    });
    const name = outName(args, `${verb}-${Date.now()}`) + '.mp3';
    const relative = await save(root, `assets/audio/${verb}/${name}`, await response.arrayBuffer());
    return JSON.stringify({ src: relative, dur: null, note: `${verb} made by ${card.name}` });
  }
  if (verb === 'image') {
    const response = await fetchChecked(endpoint(connection.baseUrl, '/images/generations'), {
      method: 'POST', headers: { ...headersFor(connection, key), 'content-type': 'application/json' },
      body: JSON.stringify({ model: remote, prompt: args.prompt, n: Number(args.n) || 1, size: ratioSize(args.ratio) }),
    }, 300_000);
    const body = await response.json();
    const entries = Array.isArray(body?.data) ? body.data : [];
    const paths = [];
    for (const [index, item] of entries.entries()) {
      let bytes;
      if (typeof item?.b64_json === 'string') bytes = Buffer.from(item.b64_json, 'base64');
      else if (typeof item?.url === 'string') bytes = Buffer.from(await (await fetchChecked(item.url, { headers: headersFor(connection, key) }, 120_000)).arrayBuffer());
      if (!bytes) continue;
      const name = `${outName(args, `image-${Date.now()}`)}${entries.length > 1 ? `-${index + 1}` : ''}.png`;
      paths.push(await save(root, `assets/image/${name}`, bytes));
    }
    if (!paths.length) throw new Error('the image service returned no image');
    return JSON.stringify({ src: paths[0], files: paths, note: `images made by ${card.name}` });
  }
  if (verb === 'asr') {
    const source = await readProjectFile(root, String(args.src));
    const form = new FormData();
    form.set('model', remote);
    form.set('file', new Blob([source.bytes], { type: 'application/octet-stream' }), source.name);
    const response = await fetchChecked(endpoint(connection.baseUrl, '/audio/transcriptions'), {
      method: 'POST', headers: headersFor(connection, key), body: form,
    }, 900_000);
    const body = await response.json().catch(() => ({}));
    const text = typeof body?.text === 'string' ? body.text : '';
    if (!text) throw new Error('the transcription service returned no text');
    const rel = `assets/audio/asr/${outName(args, `asr-${Date.now()}`)}.txt`;
    await save(root, rel, Buffer.from(text, 'utf8'));
    return JSON.stringify({ text: text.slice(0, 400), transcript: rel, note: `transcribed by ${card.name}` });
  }
  if (verb === 'video') {
    const options = card.options ?? {};
    const submitPath = String(options.submitPath || '/videos');
    const statusPath = String(options.statusPath || '/videos/{id}');
    const submit = await fetchChecked(endpoint(connection.baseUrl, submitPath), {
      method: 'POST', headers: { ...headersFor(connection, key), 'content-type': 'application/json' },
      body: JSON.stringify({ model: remote, prompt: args.prompt, duration: Number(args.duration) || 5, aspect_ratio: args['aspect-ratio'] || '16:9', ...(options.submitBody && typeof options.submitBody === 'object' ? options.submitBody : {}) }),
    }, 120_000);
    const started = await submit.json().catch(() => ({}));
    const jobId = started?.id ?? started?.task_id ?? started?.request_id;
    if (!jobId) throw new Error('the video service returned no job id');
    let result = started;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (result?.status === 'failed' || result?.state === 'failed') throw new Error(String(result?.error || 'video job failed').slice(0, 400));
      const url = started?.output?.[0] || result?.output?.[0] || result?.video_url || result?.url || result?.result?.video_url;
      if (typeof url === 'string') {
        const response = await fetchChecked(url, { headers: headersFor(connection, key) }, 600_000);
        const name = outName(args, `video-${Date.now()}`) + (extname(new URL(url).pathname) || '.mp4');
        const relative = await save(root, `assets/video/${name}`, await response.arrayBuffer());
        return JSON.stringify({ src: relative, dur: Number(args.duration) || null, note: `video made by ${card.name}` });
      }
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      const poll = await fetchChecked(endpoint(connection.baseUrl, statusPath.replaceAll('{id}', String(jobId))), { headers: headersFor(connection, key) }, 60_000);
      result = await poll.json().catch(() => ({}));
    }
    throw new Error('the video service did not finish within 20 minutes');
  }
  throw new Error(`${verb} is not supported by this custom card`);
}

function ratioSize(/** @type {unknown} */ ratio) {
  switch (String(ratio || '')) {
    case '9:16': return '1024x1792';
    case '1:1': return '1024x1024';
    case '4:3': return '1365x1024';
    case '3:4': return '1024x1365';
    case '3:2': return '1536x1024';
    case '2:3': return '1024x1536';
    default: return '1792x1024';
  }
}
