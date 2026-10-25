// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editProjectFilm, readProjectFilm } from './film.mjs';
import { editAudio, fetchAudio, listAudio, placeAudio, readAudio, searchFreesound, searchJamendo } from './audio.mjs';

const project = async () => {
  const root = await mkdtemp(join(tmpdir(), 'openfilm-audio-'));
  await mkdir(join(root, 'assets', 'audio', 'sfx'), { recursive: true });
  await mkdir(join(root, 'assets', 'audio', 'music'), { recursive: true });
  await writeFile(join(root, 'assets', 'audio', 'sfx', 'hit.wav'), 'hit');
  await writeFile(join(root, 'assets', 'audio', 'music', 'bed.mp3'), 'bed');
  return root;
};

test('local audio is listed by role, and the current timeline is read without a second edit', async () => {
  const root = await project();
  try {
    const listing = await listAudio(root, { facts: false });
    assert.deepEqual(listing.files.map((file) => [file.path, file.role]), [
      ['assets/audio/music/bed.mp3', 'music'], ['assets/audio/sfx/hit.wav', 'sfx'],
    ]);
    await editProjectFilm(root, null, [{ op: 'insert', clip: { src: 'assets/audio/sfx/hit.wav', id: 'hit', at: 1, time: [0, 2], volume: 0.5 } }]);
    const current = await readAudio(root);
    assert.equal(current.revision.length > 0, true);
    assert.equal(current.tracks[0].clips[0].id, 'hit');
    assert.equal(current.tracks[0].clips[0].atMs, 1000);
    assert.equal(current.tracks[0].clips[0].durationMs, 2000);
    assert.equal(current.summary.sfx.count, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('placing a sound uses the native insert, with trim, volume and fades', async () => {
  const root = await project();
  try {
    const made = await placeAudio(root, {
      path: 'assets/audio/sfx/hit.wav', at: 3, time: [0.25, 1.25], volume: 0.7, fade: [0.1, 0.2],
    });
    assert.ok(made.clipId);
    const { value } = await readProjectFilm(root);
    const clip = value?.tracks[0].clips[0];
    assert.equal(clip.at, 3);
    assert.deepEqual(clip.time, [0.25, 1.25]);
    assert.equal(clip.volume, 0.7);
    assert.deepEqual(clip.overrides?.[0]?.fade, [0.1, 0.2]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the audio ops endpoint accepts every native operation and refuses an invalid one', async () => {
  const root = await project();
  try {
    const inserted = await editAudio(root, { ops: [
      { op: 'insert', clip: { src: 'assets/audio/sfx/hit.wav', id: 'hit', at: 0, time: [0, 1] } },
      { op: 'insert', clip: { src: 'assets/audio/music/bed.mp3', id: 'bed', at: 1, time: [0, 2] } },
      { op: 'set', clip: 'hit', field: 'volume', value: 0.4 },
      { op: 'move', clip: 'bed', at: 4 },
      { op: 'track', track: 0, field: 'muted', value: true },
    ] });
    assert.equal(inserted.value.tracks[0].clips.find((clip) => clip.id === 'hit').volume, 0.4);
    assert.equal(inserted.value.tracks[0].muted, true);
    await assert.rejects(() => editAudio(root, { ops: [{ op: 'set', clip: 'nope', field: 'volume', value: 1 }] }), (e) => e.status === 409);
    await assert.rejects(() => editAudio(root, { ops: [] }), (e) => e.status === 400);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Freesound results carry the preview and attribution the UI needs', async () => {
  const found = await searchFreesound('rain', 'key', {
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ results: [{
        id: 7, name: 'Rain', duration: 2.5, license: 'CC0', username: 'Ann',
        previews: { 'preview-hq-mp3': 'https://cdn.example/rain.mp3' }, tags: ['rain'],
      }] }),
    }),
  });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], {
    source: 'freesound', id: '7', role: 'sfx', title: 'Rain', durationMs: 2500,
    downloadUrl: 'https://cdn.example/rain.mp3', previewUrl: 'https://cdn.example/rain.mp3',
    page: 'https://freesound.org/s/7/', credit: 'Ann on Freesound', license: 'CC0', tags: ['rain'],
  });
});

test('Jamendo results keep the artist, page and licence', async () => {
  const found = await searchJamendo('night', 'key', {
    fetchImpl: async () => ({
      ok: true, status: 200,
      json: async () => ({ results: [{
        id: 3, name: 'Night', artist_name: 'Ann', duration: 12, audio: 'https://cdn.example/night.mp3',
        shareurl: 'https://jamendo.com/track/3', license_ccurl: 'https://creativecommons.org/licenses/by/4.0/',
      }] }),
    }),
  });
  assert.equal(found[0].role, 'music');
  assert.equal(found[0].durationMs, 12_000);
  assert.equal(found[0].artist, 'Ann');
  assert.equal(found[0].page, 'https://jamendo.com/track/3');
  assert.match(found[0].credit, /Ann/);
  assert.match(found[0].license, /creativecommons/);
});

test('a download never reaches this machine or a private network', async () => {
  await assert.rejects(() => fetchAudio('http://127.0.0.1/a.mp3'), (e) => e.status === 400);
  await assert.rejects(() => fetchAudio('http://localhost/a.mp3'), (e) => e.status === 400);
});
