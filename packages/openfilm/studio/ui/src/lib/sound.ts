/**
 * The sound stage's small shared facts: what each role is called and colored, lengths short enough to need a decimal,
 * and the native operations one clip's changes make. No UI here, so the panels agree without importing each other.
 */
import type { AudioClip, AudioRole, Op, SoundRole } from '@/api';
import { formatClipDuration } from './workspace-resources';

export const SOUND_ROLES: readonly SoundRole[] = ['voice', 'music', 'sfx'];
/** Every role on the audio panel, the film's own footage sound included. */
export const AUDIO_ROLES: readonly AudioRole[] = ['voice', 'music', 'sfx', 'footage'];

/** The timeline's own color for each kind of sound (globals.css `--tl-*`). */
export const AUDIO_ROLE_COLOR: Record<AudioRole, string> = {
  voice: 'var(--tl-voice)',
  music: 'var(--tl-music)',
  sfx: 'var(--tl-sfx)',
  footage: 'var(--tl-video)',
};

/** A length at the precision a sound is talked about in: `0.8s`, `12.4s`, `1:02:03`. */
export function formatSoundLength(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 10_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  return formatClipDuration(ms);
}

/** Seconds as the API takes them, to the millisecond. */
export const seconds = (ms: number) => Math.round(ms) / 1000;
/** Milliseconds back from a field in seconds. */
export const millis = (sec: number | null) => (sec == null || !Number.isFinite(sec) ? 0 : Math.round(sec * 1000));

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** The percentage a clip's volume is shown as (`100%`, `80%`), keeping a tenth when it is not whole. */
export function formatVolume(volume: number): string {
  const pct = volume * 100;
  return `${Number.isInteger(Math.round(pct * 10) / 10) ? Math.round(pct) : Math.round(pct * 10) / 10}%`;
}

/** Where a sound came from, in the person's language; a source this build does not know is shown as it was written. */
export function audioSourceLabel(source: string, t: (key: string) => string): string {
  return source === 'ai' || source === 'download' || source === 'local' ? t(`soundStage.source.${source}`) : source;
}

/** What a clip editor can change at once. Every field is the API's unit: ms in the film and in the file. */
export interface ClipPatch {
  atMs?: number;
  startMs?: number;
  endMs?: number;
  volume?: number;
  speed?: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  track?: number;
}

/**
 * One batch of native properties for a clip: its place, its trim, its mix, and the track it goes to. `start` before
 * `end`, since each reads the trim the other wrote; fades always as a pair, or one would erase the other.
 */
export function clipOps(clip: AudioClip, patch: ClipPatch): Op[] {
  const edits: { clip: string; prop: string; value: number | number[] }[] = [];
  if (patch.atMs != null) edits.push({ clip: clip.id, prop: 'at', value: seconds(patch.atMs) });
  if (patch.startMs != null) edits.push({ clip: clip.id, prop: 'start', value: seconds(patch.startMs) });
  if (patch.endMs != null) edits.push({ clip: clip.id, prop: 'end', value: seconds(patch.endMs) });
  if (patch.volume != null) edits.push({ clip: clip.id, prop: 'volume', value: Math.round(patch.volume * 1000) / 1000 });
  if (patch.speed != null) edits.push({ clip: clip.id, prop: 'speed', value: Math.round(patch.speed * 1000) / 1000 });
  if (patch.fadeInMs != null || patch.fadeOutMs != null) {
    edits.push({
      clip: clip.id,
      prop: 'fade',
      value: [
        seconds(patch.fadeInMs ?? clip.fadeInMs),
        seconds(patch.fadeOutMs ?? clip.fadeOutMs),
      ],
    });
  }
  if (patch.track != null) edits.push({ clip: clip.id, prop: 'track', value: patch.track });
  return edits.length ? [{ op: 'props', edits }] : [];
}

/** A track's flag (`muted`, `locked`) as the native operation takes it. */
export const trackFlagOp = (track: number, field: 'muted' | 'locked', value: boolean): Op => ({ op: 'track', track, field, value });
