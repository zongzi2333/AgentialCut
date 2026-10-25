import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listWorkspace, readWorkspaceFile, roleWorkspaceRel, runWorkspaceCode, writeWorkspaceFile,
} from './agent-workspace.mjs';

const project = () => ({ id: 'workspace_test', name: 'Workspace Test', path: mkdtempSync(join(tmpdir(), 'openfilm-workspace-')) });

test('the workspace is project- and role-scoped, and refuses to leave its folder', async () => {
  const p = project();
  const written = await writeWorkspaceFile(p, 'storyboard', 'notes/brief.txt', 'a tiny brief');
  assert.equal(written.path, '.film/agent-workspace/storyboard/notes/brief.txt');
  assert.equal((await readWorkspaceFile(p, 'storyboard', 'notes/brief.txt')).text, 'a tiny brief');

  const listed = await listWorkspace(p, 'storyboard', 'notes');
  assert.ok(listed.files.some((file) => file.path.endsWith('brief.txt')));

  const editFile = await writeWorkspaceFile(p, 'edit', 'brief.txt', 'other role');
  assert.notEqual(editFile.path, written.path);
  assert.equal(roleWorkspaceRel(p, 'edit'), '.film/agent-workspace/edit');

  await assert.rejects(() => readWorkspaceFile(p, 'storyboard', '../../film.html'), /leaves|does not exist/);
  await assert.rejects(() => writeWorkspaceFile(p, 'storyboard', '../outside.txt', 'no'), /leaves/);
});

test('run_code runs Node inside the role workspace with a key-free environment', async () => {
  const p = project();
  const result = await runWorkspaceCode(p, 'storyboard', {
    language: 'node',
    code: 'import { writeFileSync } from "node:fs";\nwriteFileSync("made.txt", "ok");\nconsole.log(process.env.OPENFILM_AGENT_ROLE);\nconsole.log(process.env.OPENFILM_WORKSPACE ? "workspace" : "missing");',
    timeoutMs: 5000,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /storyboard/);
  assert.match(result.stdout, /workspace/);
  assert.equal((await readWorkspaceFile(p, 'storyboard', 'made.txt')).text, 'ok');
});
