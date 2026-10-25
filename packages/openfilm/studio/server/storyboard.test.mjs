// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOperations, distributeDurations, handoffClips, localProposal, localStoryboard, matchStoryboard, normalizeStoryboard, scaleDuration } from './storyboard.mjs';
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

test('durations follow content, not an equal split', () => {
  const doc = localStoryboard(project, {
    text: 'A very short beat.\n\nA much longer line of narration that needs room to breathe and a slow visual move.\n\nEnd.',
    brief: { durationMs: 30_000 },
  });
  distributeDurations(doc, 30_000);
  assert.equal(doc.shots.reduce((sum, shot) => sum + shot.targetMs, 0), 30_000);
  assert.ok(new Set(doc.shots.map((shot) => shot.targetMs)).size > 1);
});

test('storyboard operations accept missing types and direct timing aliases', () => {
  const doc = localStoryboard(project, { text: 'One.\nTwo.\nThree.', brief: { durationMs: 12_000 } });
  const [a, b] = doc.shots;
  const direct = applyOperations(doc, [{ shotId: a.id, durationMs: 6000 }]);
  assert.equal(direct.shots.find((shot) => shot.id === a.id)?.targetMs, 6000);
  const locked = applyOperations(doc, [{ type: 'lockShots', shotIds: [b.id] }]);
  assert.equal(locked.shots.find((shot) => shot.id === b.id)?.locked, true);
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

test('the displayed match confidence is the semantic score, even when a visual review exists', () => {
  const doc = normalizeStoryboard({
    title: 'Test',
    brief: { durationMs: 10_000, aspect: '16:9', tone: '', notes: '' },
    scenes: [{ id: 'sc1', title: 'Scene', order: 0 }],
    shots: [{
      id: 'sh1', sceneId: 'sc1', order: 0, title: 'Shot', narration: '', visualIntent: '',
      must: [], avoid: [], targetMs: 4000, locked: false, generated: false,
      match: {
        state: 'matched', selectedId: 'c1', confidence: 20, query: '',
        candidates: [{
          id: 'c1', libraryId: 'l', libraryName: 'L', assetId: 'a', path: 'a.mp4', name: 'a.mp4',
          kind: 'video', startMs: 0, endMs: 1000, score: 0.82, thumbUrl: '', origin: 'library',
          review: { verdict: 'uncertain', confidence: 0.2, reason: '' },
        }],
      },
    }],
  }, { name: 'Test', path: 'C:/tmp/test-film' });
  assert.equal(doc.shots[0].match.confidence, 82);
});

test('matching does not reuse a source already adopted by another shot when another candidate exists', async () => {
  const doc = localStoryboard(project, { text: 'First.\nSecond.', brief: { durationMs: 8000 } });
  const index = {
    search: async () => ({
      hits: [
        { libraryId: 'l', libraryName: 'L', assetId: 'a', path: 'a.mp4', name: 'a.mp4', kind: 'video', startMs: 0, endMs: 1000, score: 0.9, thumbUrl: '' },
        { libraryId: 'l', libraryName: 'L', assetId: 'b', path: 'b.mp4', name: 'b.mp4', kind: 'video', startMs: 0, endMs: 1000, score: 0.8, thumbUrl: '' },
      ],
    }),
  };
  const matched = await matchStoryboard(doc, { id: 'p', name: 'P', path: 'C:/tmp/p' }, index, { topK: 2 });
  const paths = matched.shots.map((shot) => shot.match.candidates.find((candidate) => candidate.id === shot.match.selectedId)?.path);
  assert.deepEqual(paths, ['a.mp4', 'b.mp4']);
  assert.equal(matched.shots[0].match.confidence, 90, 'confidence stays the semantic score');
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
      name: 'a.mp4', kind: 'video', startMs: 1000, endMs: 30_000, score: 1, thumbUrl: '', origin: 'library',
    }],
    selectedId: 'c1', confidence: 100,
  };
  const { clips, gaps } = handoffClips(doc);
  assert.equal(clips.length, 1);
  assert.equal(clips[0].durationMs, first.targetMs);
  assert.equal(clips[0].endMs, 1000 + first.targetMs);
  assert.equal(gaps.length, 1);
});

test('director fallback makes a duration proposal without touching the document', () => {
  const doc = localStoryboard(project, { text: 'One.' });
  const proposal = localProposal(doc, '压到 20 秒');
  assert.deepEqual(proposal.operations, [{ type: 'setTargetDuration', durationMs: 20_000 }]);
  assert.equal(doc.brief.durationMs, 30_000);
  const decide = localProposal(doc, '你根据内容自行决定各分镜时长');
  assert.deepEqual(decide.operations, [{ type: 'distributeDurations', durationMs: 30_000 }]);
  const keep = localProposal(doc, '保持开头三镜');
  assert.equal(keep.operations[0]?.type, 'lockShots');
  assert.equal(localProposal(doc, '减少重复镜头').operations.length, 0);
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
