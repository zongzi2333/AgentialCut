// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('the audio routes read, place, and edit through the same film', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'openfilm-audio-api-'));
  const previousHome = process.env.OPENFILM_HOME;
  const previousLibrary = process.env.OPENFILM_LIBRARY;
  process.env.OPENFILM_HOME = join(scratch, 'home');
  process.env.OPENFILM_LIBRARY = join(scratch, 'library');
  const { startStudio } = await import('./server.mjs');
  const studio = await startStudio({ port: 0, openBrowser: () => {}, advertise: false });
  const api = (path, init = {}) => fetch(`${studio.origin}${path}`, {
    ...init,
    headers: { 'x-studio-key': studio.key, ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });
  try {
    const made = await (await api('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'Sound API' }) })).json();
    const project = made.project;
    await mkdir(join(project.path, 'assets', 'audio', 'sfx'), { recursive: true });
    await writeFile(join(project.path, 'assets', 'audio', 'sfx', 'hit.wav'), 'not really a wav');

    const listing = await (await api(`/api/projects/${project.id}/audio/library?facts=0`)).json();
    assert.deepEqual(listing.files.map((file) => [file.path, file.role]), [['assets/audio/sfx/hit.wav', 'sfx']]);
    const catalog = await (await api(`/api/projects/${project.id}/audio/catalog`)).json();
    assert.equal(catalog.kinds.sfx.kind, 'sfx');
    const search = await (await api(`/api/projects/${project.id}/audio/search?source=freesound&q=rain`)).json();
    assert.equal(search.sources[0].id, 'freesound');

    /* search-only keys are in /api/providers and have the same key routes as a media provider */
    const before = await (await api('/api/providers')).json();
    assert.deepEqual(before.providers.filter((item) => ['freesound', 'jamendo'].includes(item.id)).map((item) => item.id), ['freesound', 'jamendo']);
    const key = 'freesound-test-key-0123456789';
    assert.equal((await api('/api/providers/freesound/key', { method: 'PUT', body: JSON.stringify({ key }) })).status, 200);
    const saved = await (await api('/api/providers')).json();
    assert.equal(saved.providers.find((item) => item.id === 'freesound').last4, key.slice(-4));
    const available = await (await api(`/api/projects/${project.id}/audio/search?source=freesound&q=`)).json();
    assert.equal(available.sources.find((item) => item.id === 'freesound').available, true);
    assert.equal((await api('/api/providers/freesound/key', { method: 'DELETE' })).status, 200);

    const placed = await (await api(`/api/projects/${project.id}/audio/place`, {
      method: 'POST', body: JSON.stringify({ path: 'assets/audio/sfx/hit.wav', at: 2, time: [0, 1], volume: 0.5 }),
    })).json();
    assert.ok(placed.clipId);
    const current = await (await api(`/api/projects/${project.id}/audio`)).json();
    assert.equal(current.clips[0].id, placed.clipId);
    assert.equal(current.clips[0].atMs, 2000);
    assert.equal(current.summary.sfx.count, 1);

    const edited = await (await api(`/api/projects/${project.id}/audio/ops`, {
      method: 'POST', body: JSON.stringify({ ops: [{ op: 'set', clip: placed.clipId, field: 'volume', value: 0.2 }] }),
    })).json();
    assert.equal(edited.value.tracks[0].clips[0].volume, 0.2);

    const noProvider = await api(`/api/projects/${project.id}/audio/generate`, {
      method: 'POST', body: JSON.stringify({ kind: 'sfx', prompt: 'a click' }),
    });
    assert.ok([409, 502].includes(noProvider.status), 'an unconnected provider is a clear error, not a crash');
  } finally {
    await studio.close();
    if (previousHome === undefined) delete process.env.OPENFILM_HOME; else process.env.OPENFILM_HOME = previousHome;
    if (previousLibrary === undefined) delete process.env.OPENFILM_LIBRARY; else process.env.OPENFILM_LIBRARY = previousLibrary;
    await rm(scratch, { recursive: true, force: true });
  }
});
