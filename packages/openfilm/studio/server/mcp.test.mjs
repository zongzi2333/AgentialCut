import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProjectFilm, writeProjectFilm } from './film.mjs';
import { readStoryboard, saveStoryboard } from './storyboard.mjs';
import { handleMcpRequest } from './mcp.mjs';

function post(body) {
  let output = '';
  const req = { [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)); } };
  const res = { status: 0, writeHead(status) { this.status = status; }, end(chunk) { output = chunk ?? ''; } };
  return { req, res, get body() { return output ? JSON.parse(output) : null; } };
}

const project = () => ({ id: 'project_test', name: 'MCP Test', path: mkdtempSync(join(tmpdir(), 'openfilm-mcp-')) });
const context = (p) => ({ project: p, semanticIndex: { search: async () => ({ hits: [], meta: null }) } });

test('MCP initializes, lists the controlled tools, and never offers render/export', async () => {
  const request = post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  await handleMcpRequest(request.req, request.res, context(project()));
  assert.equal(request.res.status, 200);
  assert.equal(request.body.result.serverInfo.name, 'openfilm');

  const listed = post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await handleMcpRequest(listed.req, listed.res, context(project()));
  const names = listed.body.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('read_timeline'));
  assert.ok(names.includes('edit_timeline'));
  assert.ok(!names.some((name) => /render|export|tts|music/i.test(name)));
});

test('MCP edits a timeline by clip id, saves a snapshot, and undoes it', async () => {
  const p = project();
  await writeProjectFilm(p.path, { stage: { w: 1920, h: 1080 }, tracks: [{ clips: [{ src: 'assets/a.mp4', id: 'a', time: [0, 3] }] }] });
  const call = post({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'edit_timeline', arguments: { ops: [{ op: 'move', clipId: 'a', at: 2 }] } },
  });
  await handleMcpRequest(call.req, call.res, context(p));
  assert.equal(call.body.result.isError, false);
  const film = await readProjectFilm(p.path);
  assert.equal(film.doc.tracks[0].clips[0].at, 2);

  const undo = post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'undo_timeline', arguments: {} } });
  await handleMcpRequest(undo.req, undo.res, context(p));
  assert.equal(undo.body.result.isError, false);
  const restored = await readProjectFilm(p.path);
  assert.equal(restored.doc.tracks[0].clips[0].at, undefined);
});

test('MCP tool errors are reported as tool errors, not as a broken endpoint', async () => {
  const call = post({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'edit_timeline', arguments: { ops: [] } },
  });
  await handleMcpRequest(call.req, call.res, context(project()));
  assert.equal(call.res.status, 200);
  assert.equal(call.body.result.isError, true);
  assert.match(call.body.result.content[0].text, /non-empty/);
});

test('after storyboard handoff the MCP tools no longer expose the storyboard', async () => {
  const p = project();
  const doc = readStoryboard(p);
  await saveStoryboard(p, { ...doc, handedOffAt: Date.now() }, doc.revision);

  const listed = post({ jsonrpc: '2.0', id: 6, method: 'tools/list' });
  await handleMcpRequest(listed.req, listed.res, context(p));
  const names = listed.body.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('edit_timeline'));
  assert.ok(!names.includes('read_storyboard'));
  assert.ok(!names.includes('edit_storyboard'));

  const read = post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'read_project', arguments: {} } });
  await handleMcpRequest(read.req, read.res, context(p));
  const value = JSON.parse(read.body.result.content[0].text);
  assert.equal(value.phase, 'edit');
  assert.equal(value.storyboard, undefined);
});
