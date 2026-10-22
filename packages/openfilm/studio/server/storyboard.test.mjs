// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperations, handoffClips, localProposal, localStoryboard, normalizeStoryboard, scaleDuration } from './storyboard.mjs';
import { parseJsonReply } from './agent-runtime.mjs';

const project = { name: 'Test film', path: 'C:/tmp/test-film' };

test('local storyboard: headings become scenes, the brief scales the shots', () => {
  const doc = localStoryboard(project, {
    text: '# Scene one\nRain on the city.\n\nHe hears a door.\n\n# Scene two\nLight under the door.',
    brief: { durationMs: 30_000, aspect: '16:9' },
  });
  assert.equal(doc.scenes.length, 2);
  assert.equal(doc.shots.length, 3);
  assert.equal(doc.shots.reduce((sum, shot) => sum + shot.targetMs, 0), 30_000);
  assert.ok(doc.shots.every((shot) => shot.targetMs >= 500));
  assert.equal(doc.shots[0].narration, 'Rain on the city.');
  assert.equal(doc.source, 'local');
});

test('storyboard operations validate locked shots and reorder every shot once', () => {
  const doc = localStoryboard(project, { text: 'One.\nTwo.', brief: { durationMs: 8_000 } });
  const [a, b] = doc.shots;
  const next = applyOperations(doc, [{ type: 'updateShot', shotId: a.id, patch: { locked: true, title: 'Locked' } }]);
  const locked = next.shots.find((shot) => shot.id === a.id);
  assert.equal(locked?.locked, true);
  assert.throws(() => applyOperations(next, [{ type: 'deleteShot', shotId: a.id }]), /locked/);
  assert.throws(() => applyOperations(next, [{ type: 'reorderShots', shotIds: [a.id] }]), /every shot/);
  const reordered = applyOperations(next, [{ type: 'reorderShots', shotIds: [b.id, a.id] }]);
  assert.deepEqual(reordered.shots.map((shot) => shot.id), [b.id, a.id]);
});

test('duration scaling and handoff keep the adopted clips and list gaps', () => {
  const doc = localStoryboard(project, { text: 'One.\nTwo.', brief: { durationMs: 10_000 } });
  scaleDuration(doc, 20_000);
  assert.equal(doc.shots.reduce((sum, shot) => sum + shot.targetMs, 0), 20_000);
  const first = doc.shots[0];
  first.match = {
    state: 'matched',
    candidates: [{
      id: 'c1', libraryId: 'p', libraryName: 'Project', assetId: 'assets/a.mp4', path: 'assets/a.mp4',
      name: 'a.mp4', kind: 'video', startMs: 1000, endMs: 3000, score: 1, thumbUrl: '', origin: 'library',
    }],
    selectedId: 'c1', confidence: 100,
  };
  const { clips, gaps } = handoffClips(doc);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].durationMs, 2000);
  assert.equal(gaps.length, 1);
});

test('director fallback makes a duration proposal without touching the document', () => {
  const doc = localStoryboard(project, { text: 'One.' });
  const proposal = localProposal(doc, '压到 20 秒');
  assert.deepEqual(proposal.operations, [{ type: 'setTargetDuration', durationMs: 20_000 }]);
  assert.equal(doc.brief.durationMs, 30_000);
});

test('model JSON can be fenced, and a broken reply is refused', () => {
  assert.deepEqual(parseJsonReply('```json\n{"reply":"ok","operations":[]}\n```'), { reply: 'ok', operations: [] });
  assert.throws(() => parseJsonReply('not JSON'), /有效的分镜 JSON/);
});

test('normalization keeps ids and clamps values', () => {
  const raw = {
    revision: 4,
    title: 'A',
    scenes: [{ id: 's', title: 'Scene' }],
    shots: [{ id: 'one', sceneId: 's', title: 'Shot', targetMs: 10, must: ['x'], match: { candidates: [{ id: 'c', path: 'assets/a.mp4', score: 4 }] } }],
  };
  const doc = normalizeStoryboard(raw, project);
  assert.equal(doc.revision, 4);
  assert.equal(doc.shots[0].id, 'one');
  assert.equal(doc.shots[0].targetMs, 500);
  assert.equal(doc.shots[0].match.candidates[0].score, 1);
});
