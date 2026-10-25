/**
 * The sound stage's editing rules, in one place: a clip moved, trimmed or a new sound put down never overlaps one
 * already on its track. This is the editor's own rule (lib/timeline-edit), so the plans are the editor's: `planMove`
 * for a move (insert mode: the clip is kept in order on its track, what follows moves on), `planRoom` for an insert,
 * and `trimFence` for a trim. Nothing here writes or draws; the panels and the stage share these pure answers.
 */
import type { AudioClip, AudioState, AudioTrackView, Op } from '@/api';
import type { ClipPatch } from './sound';
import { insertPointOn, planMove, planRoom, type EditClip, type EditModel } from './timeline-edit';
import { rangeOverlaps, trimFence, type TrimFence } from './timeline-drag';

/** The same track model the editor's plans take, made from the sound stage's clips (film ms, source ms in/out). */
export function audioEditModel(audio: AudioState): EditModel {
  return audio.tracks.map((track) => ({
    index: track.index,
    role: 'audio',
    ...(track.locked ? { locked: true } : {}),
    clips: track.clips.map((clip): EditClip => ({
      id: clip.id,
      startMs: clip.atMs,
      endMs: clip.atMs + clip.durationMs,
      inMs: clip.startMs,
      speed: clip.speed > 0 ? clip.speed : 1,
      /* the source's length; the file's end point is the furthest the stage knows it can read */
      sourceMs: Math.max(clip.endMs, clip.startMs + 1),
    })),
  }));
}

/** A clip's film range, as the collision helpers before the edit need it. */
const filmRange = (clip: AudioClip) => ({ startMs: clip.atMs, endMs: clip.atMs + clip.durationMs });

/** What else is on a track, in film ms. */
const clipsOn = (audio: AudioState, track: number, exceptId = '') => (
  (audio.tracks.find((item) => item.index === track)?.clips ?? [])
    .filter((item) => item.id !== exceptId)
    .map(filmRange)
);
const othersOn = (audio: AudioState, clip: AudioClip, track = clip.track) => clipsOn(audio, track, clip.id);

/**
 * The move the editor's insert mode makes: the clip leaves its place (the time closes), goes in at the hand's
 * insert point on its track, and what follows moves on. It never opens a track: on one sound track the clips are
 * kept in order, as they are on the edit stage's insert drag.
 */
export function planAudioMove(audio: AudioState, clip: AudioClip, atMs: number, track = clip.track): Op[] | null {
  const destination = track === clip.track ? undefined : new Map<string, number>([[clip.id, track]]);
  const plan = planMove(audioEditModel(audio), {
    ids: [clip.id],
    deltaMs: Math.max(0, atMs) - clip.atMs,
    pointerMs: Math.max(0, atMs),
    mode: 'insert',
    ...(destination ? { to: destination } : {}),
  });
  return plan?.ops ?? null;
}

/** The nearest edge a trim may reach on the clip's track; the editor's trim rule, not a second one. */
export function audioTrimFence(audio: AudioState, clip: AudioClip): TrimFence {
  return trimFence(filmRange(clip), othersOn(audio, clip));
}

/**
 * Whether the clip as `patch` leaves it would overlap another on its track. Used for the fields the inspector writes
 * (a position typed in, a speed, a track): those edits are not a drag, so a collision is refused rather than a new track
 * opened behind the person's back.
 */
export function audioPatchOverlaps(audio: AudioState, clip: AudioClip, patch: ClipPatch): boolean {
  const track = patch.track ?? clip.track;
  const startMs = patch.startMs ?? clip.startMs;
  const endMs = patch.endMs ?? clip.endMs;
  const speed = patch.speed != null && patch.speed > 0 ? patch.speed : clip.speed > 0 ? clip.speed : 1;
  const atMs = Math.max(0, patch.atMs ?? clip.atMs);
  const lengthMs = Math.max(0, (endMs - startMs) / speed);
  return rangeOverlaps({ startMs: atMs, endMs: atMs + lengthMs }, othersOn(audio, clip, track));
}

export interface AudioInsert {
  /** The track the insert goes on; null: let film.html open the first one. */
  track: number | null;
  /** Where it goes (film ms), moved to a clip's edge rather than into it. */
  atMs: number;
  /** What the insert has to make room with before it (the editor's insert ops); append the insert itself. */
  ops: Op[];
}

/**
 * A new sound on a track without stacking. A free place at `atMs` is kept; over a clip the point goes to that clip's
 * nearer edge; a gap too short for the sound makes room with `planRoom` (what follows moves on). With no track named,
 * the first track free for it is used, else the first unlocked sound track; no sound tracks: film.html opens one.
 */
export function planAudioInsert(
  audio: AudioState,
  how: { track: number | null; atMs: number; durationMs: number | null },
): AudioInsert | null {
  const atMs = Math.max(0, Math.round(how.atMs));
  const durationMs = Math.max(0, Math.round(how.durationMs ?? 0));
  const range = { startMs: atMs, endMs: atMs + durationMs };
  const named = how.track == null ? null : (audio.tracks.find((track) => track.index === how.track) ?? null);
  if (how.track != null && (!named || named.locked)) return null;

  const free = (track: AudioTrackView) => !track.locked && !rangeOverlaps(range, track.clips.map(filmRange));
  const track = named ?? audio.tracks.find(free) ?? audio.tracks.find((item) => !item.locked) ?? null;
  if (!track) return { track: null, atMs, ops: [] };

  const model = audioEditModel(audio);
  const lastEnd = Math.max(0, ...track.clips.map((clip) => clip.atMs + clip.durationMs));
  /* over a clip: the editor's insert point puts it before / after that clip; in a gap or past the end: where it was put */
  const point = atMs >= lastEnd ? atMs : insertPointOn(model, track.index, atMs, atMs);
  const at = { startMs: point, endMs: point + durationMs };
  if (!rangeOverlaps(at, clipsOn(audio, track.index))) {
    return { track: track.index, atMs: point, ops: [] };
  }
  const room = planRoom(model, [{ track: track.index, startMs: point, endMs: point + durationMs }], { mode: 'insert' });
  return { track: track.index, atMs: point, ops: room.ops };
}
