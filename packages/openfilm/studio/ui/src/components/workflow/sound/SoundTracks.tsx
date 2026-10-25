/**
 * The film's sound as it stands: every track that carries sound, its clips, and where a new sound would go.
 *
 * It is a review strip, not the editor's timeline: clips are picked, moved and trimmed here because the sound stage is
 * where the mix is judged, but the picture's tracks are not shown and nothing is cut against them. The line is the
 * place a file from the library would be put; a click on the ruler or a lane moves it.
 */
import * as React from 'react';
import {
  AudioLines, AudioWaveform, ChevronsLeft, ChevronsRight, Loader2, Lock, LockOpen, Minus, Pause, Play, Plus, Scissors, SkipBack, SkipForward, Square, Sunrise, Sunset, Trash2, Volume2, VolumeX,
} from 'lucide-react';
import type { AudioClip, AudioState, AudioTrackView } from '@/api';
import { useT } from '@/i18n';
import { useKeyHint } from '@/lib/keymap-store';
import { formatTimecode, formatRulerLabel } from '@/lib/timecode';
import { audioTrimFence } from '@/lib/audio-edit';
import { AUDIO_ROLE_COLOR, clamp, formatSoundLength, formatVolume } from '@/lib/sound';
import { BlockWaveform } from '../../BlockWaveform';
import { Tooltip } from '../../Tooltip';
import { SoundRoleMark } from './SoundRoleMark';

/** The sound strip's own scale: one track a row, a clip's title and waveform inside its length. */
const HEAD_W = 136;
const ROW_H = 38;
const CLIP_H = 26;
/** The shortest a clip may be dragged to, in the file's ms. */
const MIN_SPAN_MS = 50;
const BAR_BTN = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:pointer-events-none disabled:opacity-30';

/** A library sound dropped on a lane: enough to place it without asking the library again. */
export interface DroppedSound { path: string; title?: string; durationMs: number | null }

type DragMode = 'move' | 'start' | 'end';

interface Drag {
  clip: AudioClip;
  mode: DragMode;
  startX: number;
  /** The change on the film's clock, after clamping (ms). */
  deltaMs: number;
  /** For a trim: the file's new in or out point (ms). */
  startMs: number;
  endMs: number;
  atMs: number;
}

export function SoundTracks({
  audio, durationMs, posMs, selectedClipId, onPos, onSelectClip, onToggleTrack, onMoveClip, onTrimClip, onDropSound,
  waveUrl, fileDurationMs, busy, playing, onTogglePlay, onStop, clip, onMuteTrack, onVolume, onFade, onNormalize, onSplit, onRemove, onClearSelection,
}: {
  audio: AudioState | null;
  /** The film's length (the strip's own scale may be longer when sound runs past the last picture). */
  durationMs: number;
  posMs: number;
  selectedClipId: string | null;
  onPos: (ms: number) => void;
  onSelectClip: (clip: AudioClip) => void;
  onToggleTrack: (track: number, field: 'muted' | 'locked', value: boolean) => void;
  onMoveClip: (clip: AudioClip, atMs: number) => void;
  onTrimClip: (clip: AudioClip, patch: { startMs?: number; endMs?: number; atMs?: number }) => void;
  onDropSound: (sound: DroppedSound, track: number, atMs: number) => void;
  waveUrl: (path: string) => string;
  /** A file's whole length, so a clip cannot be dragged past the end of what it plays. Null: not measured yet. */
  fileDurationMs: (path: string) => number | null;
  busy?: boolean;
  /** The picture is playing from this playhead. */
  playing: boolean;
  onTogglePlay: () => void;
  onStop: () => void;
  /** The selected audio clip, for the audio buttons in the bar. */
  clip: AudioClip | null;
  onMuteTrack: () => void;
  onVolume: (delta: number) => void;
  onFade: (edge: 'in' | 'out') => void;
  onNormalize: () => void;
  onSplit: () => void;
  onRemove: () => void;
  /** A press on an empty lane lets the selection go. */
  onClearSelection: () => void;
}) {
  const t = useT();
  const keyHint = useKeyHint();
  const laneRef = React.useRef<HTMLDivElement | null>(null);
  const [laneWidth, setLaneWidth] = React.useState(0);
  const [drag, setDrag] = React.useState<Drag | null>(null);
  const dragRef = React.useRef<Drag | null>(null);
  const [dropTrack, setDropTrack] = React.useState<number | null>(null);
  const [seeking, setSeeking] = React.useState(false);

  const tracks = audio?.tracks ?? [];
  const totalMs = Math.max(1000, durationMs, audio?.durationMs ?? 0);
  const pxPerMs = laneWidth > 0 ? laneWidth / totalMs : 0;
  const clampPos = (ms: number) => clamp(ms, 0, totalMs);
  const selectedTrack = clip ? tracks.find((track) => track.index === clip.track) : undefined;
  const cuts = React.useMemo(() => {
    const points = new Set<number>([0, Math.round(totalMs)]);
    for (const item of audio?.clips ?? []) {
      points.add(Math.round(item.atMs));
      points.add(Math.round(item.atMs + item.durationMs));
    }
    return [...points].filter((ms) => Number.isFinite(ms)).sort((a, b) => a - b);
  }, [audio, totalMs]);

  React.useLayoutEffect(() => {
    const lane = laneRef.current;
    if (!lane) return undefined;
    const measure = () => setLaneWidth(Math.max(0, Math.round(lane.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(lane);
    return () => observer.disconnect();
  }, [tracks.length]);

  const atOf = (clientX: number, element: HTMLElement) => {
    const box = element.getBoundingClientRect();
    return clamp((clientX - box.left) / Math.max(1, box.width), 0, 1) * totalMs;
  };

  const tickStep = React.useMemo(() => {
    if (!laneWidth) return 1000;
    const want = 64 / Math.max(1e-9, pxPerMs) / 1000;
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    return Math.round((steps.find((step) => step >= want) ?? 600) * 1000);
  }, [laneWidth, pxPerMs]);
  const ticks = React.useMemo(() => {
    const out: { ms: number; label: string }[] = [];
    for (let ms = 0; ms <= totalMs + 1; ms += tickStep) out.push({ ms, label: formatRulerLabel(ms) });
    return out;
  }, [totalMs, tickStep]);

  /* ── seeking on the ruler or a lane ── */
  const seekAt = (clientX: number, element: HTMLElement) => onPos(clampPos(atOf(clientX, element)));

  /* ── a clip dragged by its body or its edges ── */
  const beginDrag = (event: React.PointerEvent<HTMLElement>, clip: AudioClip, mode: DragMode, locked: boolean) => {
    if (event.button !== 0 || event.ctrlKey) return;
    event.preventDefault();
    event.stopPropagation();
    onSelectClip(clip);
    if (locked || clip.missing) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const next: Drag = { clip, mode, startX: event.clientX, deltaMs: 0, startMs: clip.startMs, endMs: clip.endMs, atMs: clip.atMs };
    dragRef.current = next;
    setDrag(next);
  };
  const moveDrag = (event: React.PointerEvent<HTMLElement>) => {
    const now = dragRef.current;
    if (!now || !pxPerMs) return;
    const filmDelta = (event.clientX - now.startX) / pxPerMs;
    const speed = now.clip.speed || 1;
    const fence = audio ? audioTrimFence(audio, now.clip) : {};
    if (now.mode === 'move') {
      const atMs = Math.max(0, now.clip.atMs + filmDelta);
      const next = { ...now, atMs, deltaMs: atMs - now.clip.atMs };
      dragRef.current = next;
      setDrag(next);
      return;
    }
    if (now.mode === 'start') {
      const rawStart = now.clip.startMs + filmDelta * speed;
      const wantedAt = now.clip.atMs + (rawStart - now.clip.startMs) / speed;
      /* a trimmed head stops at the source's beginning and at the neighbor before it (the editor's trimFence) */
      const atMs = Math.max(0, fence.startMs ?? 0, wantedAt);
      const startMs = clamp(now.clip.startMs + (atMs - now.clip.atMs) * speed, 0, now.clip.endMs - MIN_SPAN_MS);
      const landedAt = Math.max(0, now.clip.atMs + (startMs - now.clip.startMs) / speed);
      const next = { ...now, atMs: landedAt, startMs, deltaMs: (startMs - now.clip.startMs) / speed };
      dragRef.current = next;
      setDrag(next);
      return;
    }
    const currentEnd = now.clip.atMs + now.clip.durationMs;
    const fileMs = fileDurationMs(now.clip.path) || now.clip.endMs;
    const maxFilmEnd = Math.min(
      now.clip.atMs + (fileMs - now.clip.startMs) / speed,
      fence.endMs ?? Number.POSITIVE_INFINITY,
    );
    const endMs = Math.max(
      now.clip.startMs + MIN_SPAN_MS,
      Math.min(now.clip.startMs + (Math.min(currentEnd + filmDelta, maxFilmEnd) - now.clip.atMs) * speed, fileMs),
    );
    const next = { ...now, endMs, deltaMs: (endMs - now.clip.endMs) / speed };
    dragRef.current = next;
    setDrag(next);
  };
  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    const now = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!now) return;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* it was not captured */ }
    if (now.mode === 'move') {
      if (Math.abs(now.deltaMs) >= 10) onMoveClip(now.clip, Math.max(0, now.atMs));
      return;
    }
    if (now.mode === 'start') {
      if (Math.abs(now.startMs - now.clip.startMs) >= 10) onTrimClip(now.clip, { startMs: now.startMs, atMs: Math.max(0, now.atMs) });
      return;
    }
    if (Math.abs(now.endMs - now.clip.endMs) >= 10) onTrimClip(now.clip, { endMs: now.endMs });
  };

  /* a dragged clip is drawn where it would land: moving shifts it, trimming moves one edge */
  const geometry = (clip: AudioClip) => {
    let left = clip.atMs;
    let length = Math.max(1, clip.durationMs);
    if (drag?.clip.id === clip.id) {
      if (drag.mode === 'move') left = drag.atMs;
      else if (drag.mode === 'start') { left = drag.atMs; length = Math.max(1, (drag.endMs - drag.startMs) / (clip.speed || 1)); }
      else length = Math.max(1, (drag.endMs - clip.startMs) / (clip.speed || 1));
    }
    return { left: left * pxPerMs, width: Math.max(2, length * pxPerMs) };
  };

  const head = totalMs > 0 ? clamp(posMs / totalMs, 0, 1) : 0;
  const previousCut = [...cuts].reverse().find((ms) => ms < posMs - 1);
  const nextCutPoint = cuts.find((ms) => ms > posMs + 1);

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]" aria-label={t('soundStage.overview.title')}>
      <div className="flex h-[34px] shrink-0 items-center gap-0.5 border-b border-[var(--border-soft)] px-2">
        <AudioLines size={13} aria-hidden className="ml-1 shrink-0 text-[var(--text-faint)]" />
        <span className="ml-1 shrink-0 text-[11px] font-medium text-[var(--text-muted)]">{t('soundStage.overview.title')}</span>
        <span className="ml-1 hidden min-[880px]:flex min-w-0 items-center gap-1.5 overflow-hidden">
          {(['voice', 'music', 'sfx', 'footage'] as const).map((role) => {
            const count = audio?.summary[role]?.count ?? 0;
            return (
              <span key={role} title={t(`soundStage.role.${role}`)} className={`inline-flex shrink-0 items-center gap-1 text-[9.5px] tabular-nums ${count ? 'text-[var(--text-muted)]' : 'text-[var(--text-faint)]'}`}>
                <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: AUDIO_ROLE_COLOR[role] }} />
                {count}
              </span>
            );
          })}
        </span>
        <span className="min-w-0 flex-1" />
        <Tooltip label={t('soundStage.picture.start')} side="top" shortcut={keyHint('start') || undefined}>
          <button type="button" aria-label={t('soundStage.picture.start')} onClick={() => onPos(0)} className={BAR_BTN}><SkipBack size={12} /></button>
        </Tooltip>
        <Tooltip label={t('soundStage.keys.prevCut')} side="top" shortcut={keyHint('prev-cut') || undefined}>
          <button type="button" aria-label={t('soundStage.keys.prevCut')} onClick={() => previousCut != null && onPos(previousCut)} disabled={previousCut == null} className={BAR_BTN}><ChevronsLeft size={12} /></button>
        </Tooltip>
        <Tooltip label={t(playing ? 'soundStage.audition.pause' : 'soundStage.audition.play')} side="top" shortcut={keyHint('play-pause') || undefined}>
          <button type="button" aria-label={t(playing ? 'soundStage.audition.pause' : 'soundStage.audition.play')} onClick={onTogglePlay}
            className={`${BAR_BTN} ${playing ? 'bg-[var(--surface-3)] text-[var(--text)]' : ''}`}>{playing ? <Pause size={12} /> : <Play size={12} />}</button>
        </Tooltip>
        <Tooltip label={t('soundStage.audition.stop')} side="top" shortcut={keyHint('shuttle-stop') || undefined}>
          <button type="button" aria-label={t('soundStage.audition.stop')} onClick={onStop} disabled={!playing} className={BAR_BTN}><Square size={9} /></button>
        </Tooltip>
        <Tooltip label={t('soundStage.keys.nextCut')} side="top" shortcut={keyHint('next-cut') || undefined}>
          <button type="button" aria-label={t('soundStage.keys.nextCut')} onClick={() => nextCutPoint != null && onPos(nextCutPoint)} disabled={nextCutPoint == null} className={BAR_BTN}><ChevronsRight size={12} /></button>
        </Tooltip>
        <Tooltip label={t('soundStage.picture.end')} side="top" shortcut={keyHint('end') || undefined}>
          <button type="button" aria-label={t('soundStage.picture.end')} onClick={() => onPos(totalMs)} className={BAR_BTN}><SkipForward size={12} /></button>
        </Tooltip>
        <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-[var(--border)]" />
        <Tooltip label={t(selectedTrack?.muted ? 'soundStage.inspector.unmuteTrack' : 'soundStage.inspector.muteTrack')} side="top" shortcut={keyHint('audio-mute-track') || undefined}>
          <button type="button" aria-label={t(selectedTrack?.muted ? 'soundStage.inspector.unmuteTrack' : 'soundStage.inspector.muteTrack')} onClick={onMuteTrack} disabled={!clip}
            className={`${BAR_BTN} ${selectedTrack?.muted ? 'text-[var(--warn)]' : ''}`}>{selectedTrack?.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}</button>
        </Tooltip>
        <Tooltip label={t('soundStage.inspector.volumeDown')} side="top" shortcut={keyHint('audio-volume-down') || undefined}>
          <button type="button" aria-label={t('soundStage.inspector.volumeDown')} onClick={() => onVolume(-0.1)} disabled={!clip} className={BAR_BTN}><Minus size={12} /></button>
        </Tooltip>
        <Tooltip label={t('soundStage.inspector.volumeUp')} side="top" shortcut={keyHint('audio-volume-up') || undefined}>
          <button type="button" aria-label={t('soundStage.inspector.volumeUp')} onClick={() => onVolume(0.1)} disabled={!clip} className={BAR_BTN}><Plus size={12} /></button>
        </Tooltip>
        <Tooltip label={t('soundStage.inspector.fadeIn')} side="top" shortcut={keyHint('audio-fade-in') || undefined}>
          <button type="button" aria-label={t('soundStage.inspector.fadeIn')} onClick={() => onFade('in')} disabled={!clip} className={BAR_BTN}><Sunrise size={12} /></button>
        </Tooltip>
        <Tooltip label={t('soundStage.inspector.fadeOut')} side="top" shortcut={keyHint('audio-fade-out') || undefined}>
          <button type="button" aria-label={t('soundStage.inspector.fadeOut')} onClick={() => onFade('out')} disabled={!clip} className={BAR_BTN}><Sunset size={12} /></button>
        </Tooltip>
        <Tooltip label={t('soundStage.loudness.normalizeWeb')} side="top" shortcut={keyHint('audio-normalize') || undefined}>
          <button type="button" aria-label={t('soundStage.loudness.normalizeWeb')} onClick={onNormalize} disabled={!clip} className={BAR_BTN}><AudioWaveform size={12} /></button>
        </Tooltip>
        <Tooltip label={t('timeline.menuSplitHere')} side="top" shortcut={keyHint('split') || undefined}>
          <button type="button" aria-label={t('timeline.menuSplitHere')} onClick={onSplit} disabled={!clip} className={BAR_BTN}><Scissors size={12} /></button>
        </Tooltip>
        <Tooltip label={t('soundStage.inspector.remove')} side="top" shortcut={keyHint('remove') || undefined}>
          <button type="button" aria-label={t('soundStage.inspector.remove')} onClick={onRemove} disabled={!clip} className={`${BAR_BTN} hover:text-[var(--err)]`}><Trash2 size={12} /></button>
        </Tooltip>
        <span aria-hidden className="mx-0.5 h-4 w-px shrink-0 bg-[var(--border)]" />
        <span className="hidden shrink-0 text-[9.5px] text-[var(--text-faint)] min-[780px]:inline">{t('soundStage.overview.playhead')}</span>
        <span className="ml-1 shrink-0 font-mono text-[10.5px] tabular-nums text-[var(--text)">{formatTimecode(posMs)}</span>
        {busy ? <Loader2 size={11} className="ml-0.5 shrink-0 animate-spin text-[var(--text-faint)]" /> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* the ruler: a click, a drag, and the line follows */}
        <div className="sticky top-0 z-20 grid border-b border-[var(--border)] bg-[var(--dock-pane)]" style={{ gridTemplateColumns: `${HEAD_W}px minmax(0,1fr)` }}>
          <div className="flex items-center justify-end pr-2 text-[9px] text-[var(--text-faint)]">{audio?.tracks.length ? formatSoundLength(totalMs) : '—'}</div>
          <div
            ref={laneRef}
            role="slider"
            aria-label={t('soundStage.overview.playhead')}
            aria-valuemin={0}
            aria-valuemax={Math.round(totalMs)}
            aria-valuenow={Math.round(posMs)}
            aria-valuetext={formatTimecode(posMs)}
            tabIndex={0}
            className="relative h-5 cursor-ew-resize"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              setSeeking(true);
              seekAt(event.clientX, event.currentTarget);
            }}
            onPointerMove={(event) => { if (seeking) seekAt(event.clientX, event.currentTarget); }}
            onPointerUp={(event) => { if (!seeking) return; event.currentTarget.releasePointerCapture(event.pointerId); setSeeking(false); }}
            onPointerCancel={() => setSeeking(false)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault();
                onPos(clampPos(posMs + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 1000 : 100)));
              }
              if (event.key === 'Home') onPos(0);
              if (event.key === 'End') onPos(totalMs);
            }}
          >
            {ticks.map((tick) => (
              <span key={tick.ms} className="pointer-events-none absolute top-0 flex h-full flex-col justify-end" style={{ left: tick.ms * pxPerMs }}>
                <span className="absolute bottom-0 left-0 h-1.5 w-px" style={{ background: 'var(--tl-tick)' }} />
                {tick.label ? <span className="absolute bottom-[7px] left-0 whitespace-nowrap pl-0.5 text-[8.5px] tabular-nums text-[var(--text-faint)]">{tick.label}</span> : null}
              </span>
            ))}
            <span aria-hidden className="pointer-events-none absolute -top-px z-10 h-2.5 w-2.5 -translate-x-1/2 rotate-45 rounded-[1px]" style={{ left: `${head * 100}%`, background: 'var(--tl-playhead)' }} />
          </div>
        </div>

        {!audio ? (
          <div className="flex h-[112px] items-center justify-center gap-2 text-[11px] text-[var(--text-faint)]"><Loader2 size={13} className="animate-spin" />{t('soundStage.overview.loading')}</div>
        ) : tracks.length ? (
          tracks.map((track) => (
            <div key={track.index} className="grid border-b border-[var(--border-soft)] last:border-b-0" style={{ gridTemplateColumns: `${HEAD_W}px minmax(0,1fr)`, height: ROW_H }}>
              <TrackHead track={track} onToggle={onToggleTrack} />
              <Lane
                track={track}
                posMs={posMs}
                selectedClipId={selectedClipId}
                pxPerMs={pxPerMs}
                drag={drag}
                dropActive={dropTrack === track.index}
                onEmpty={(clientX, element) => { seekAt(clientX, element); onClearSelection(); }}
                onSelectClip={onSelectClip}
                onBeginDrag={beginDrag}
                onMoveDrag={moveDrag}
                onEndDrag={endDrag}
                onDragOver={() => setDropTrack(track.index)}
                onDragLeave={() => setDropTrack((now) => (now === track.index ? null : now))}
                onDrop={(event) => {
                  setDropTrack(null);
                  const raw = event.dataTransfer.getData('application/x-openfilm-sound');
                  if (!raw) return;
                  event.preventDefault();
                  let sound: DroppedSound | null = null;
                  try {
                    const parsed = JSON.parse(raw) as Partial<DroppedSound>;
                    if (typeof parsed.path === 'string') sound = { path: parsed.path, title: parsed.title, durationMs: typeof parsed.durationMs === 'number' ? parsed.durationMs : null };
                  } catch { /* not ours */ }
                  if (!sound) return;
                  onDropSound(sound, track.index, clampPos(atOf(event.clientX, event.currentTarget)));
                }}
                waveUrl={waveUrl}
                geometry={geometry}
              />
            </div>
          ))
        ) : (
          <div className="flex h-[112px] flex-col items-center justify-center gap-1.5 px-6 text-center">
            <AudioLines size={18} aria-hidden className="text-[var(--text-faint)]" />
            <p className="text-[12px] font-medium text-[var(--text-muted)]">{t('soundStage.overview.empty')}</p>
            <p className="max-w-[420px] text-[10.5px] leading-relaxed text-[var(--text-faint)]">{t('soundStage.overview.emptyHint')}</p>
          </div>
        )}
      </div>
    </section>
  );
}

function TrackHead({ track, onToggle }: { track: AudioTrackView; onToggle: (track: number, field: 'muted' | 'locked', value: boolean) => void }) {
  const t = useT();
  const role = track.role === 'mixed' ? (track.roles[0] ?? 'sfx') : track.role;
  return (
    <div className="flex min-w-0 items-center gap-1.5 border-r border-[var(--border-soft)] pl-2 pr-1" style={{ height: ROW_H }}>
      <SoundRoleMark role={role} size={12} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[10.5px] text-[var(--text-muted)]">{track.name || t('soundStage.overview.track').replace('{n}', String(track.index + 1))}</span>
        <span className="block truncate text-[8.5px] text-[var(--text-faint)]">
          {track.role === 'mixed' ? t('soundStage.role.mixed') : t(`soundStage.role.${role}`)}
        </span>
      </span>
      <button type="button" aria-label={track.muted ? t('soundStage.overview.unmute') : t('soundStage.overview.mute')}
        aria-pressed={Boolean(track.muted)} onClick={() => onToggle(track.index, 'muted', !track.muted)}
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded transition hover:bg-[var(--bg-hover)] ${track.muted ? 'text-[var(--warn)]' : 'text-[var(--text-faint)] hover:text-[var(--text)]'}`}>
        {track.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
      </button>
      <button type="button" aria-label={track.locked ? t('soundStage.overview.unlock') : t('soundStage.overview.lock')}
        aria-pressed={Boolean(track.locked)} onClick={() => onToggle(track.index, 'locked', !track.locked)}
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded transition hover:bg-[var(--bg-hover)] ${track.locked ? 'text-[var(--warn)]' : 'text-[var(--text-faint)] hover:text-[var(--text)]'}`}>
        {track.locked ? <Lock size={11} /> : <LockOpen size={11} />}
      </button>
    </div>
  );
}

function Lane({
  track, posMs, selectedClipId, pxPerMs, drag, dropActive, onEmpty, onSelectClip, onBeginDrag, onMoveDrag, onEndDrag,
  onDragOver, onDragLeave, onDrop, waveUrl, geometry,
}: {
  track: AudioTrackView;
  posMs: number;
  selectedClipId: string | null;
  pxPerMs: number;
  drag: Drag | null;
  dropActive: boolean;
  onEmpty: (clientX: number, element: HTMLElement) => void;
  onSelectClip: (clip: AudioClip) => void;
  onBeginDrag: (event: React.PointerEvent<HTMLElement>, clip: AudioClip, mode: DragMode, locked: boolean) => void;
  onMoveDrag: (event: React.PointerEvent<HTMLElement>) => void;
  onEndDrag: (event: React.PointerEvent<HTMLElement>) => void;
  onDragOver: () => void;
  onDragLeave: () => void;
  onDrop: (event: React.DragEvent<HTMLElement>) => void;
  waveUrl: (path: string) => string;
  geometry: (clip: AudioClip) => { left: number; width: number };
}) {
  const t = useT();
  return (
    <div
      className={`relative min-w-0 ${dropActive ? 'bg-[var(--accent-soft)] ring-1 ring-inset ring-[var(--accent)]' : ''}`}
      style={{ height: ROW_H, background: track.hidden ? 'var(--tl-head)' : undefined }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        if ((event.target as Element).closest?.('[data-sound-clip]')) return;
        onEmpty(event.clientX, event.currentTarget);
      }}
      onDragOver={(event) => {
        if (track.locked) return;
        if (!event.dataTransfer.types.includes('application/x-openfilm-sound')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        onDragOver();
      }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onDragLeave(); }}
      onDrop={(event) => { if (!track.locked) onDrop(event); }}
    >
      {track.clips.map((clip) => {
        const box = geometry(clip);
        const invalid = clip.durationMs <= 0 || clip.endMs <= clip.startMs;
        const width = Math.max(4, box.width);
        const selected = clip.id === selectedClipId;
        const color = AUDIO_ROLE_COLOR[clip.role] ?? AUDIO_ROLE_COLOR.sfx;
        const dragging = drag?.clip.id === clip.id;
        return (
          <div
            key={clip.id}
            data-sound-clip={clip.id}
            role="button"
            tabIndex={0}
            aria-label={`${clip.title} ${formatTimecode(clip.atMs)}`}
            aria-pressed={selected}
            title={`${clip.title} · ${formatSoundLength(clip.durationMs)}${clip.volume !== 1 ? ` · ${formatVolume(clip.volume)}` : ''}`}
            onPointerDown={(event) => onBeginDrag(event, clip, 'move', Boolean(track.locked))}
            onPointerMove={onMoveDrag}
            onPointerUp={onEndDrag}
            onPointerCancel={onEndDrag}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              onSelectClip(clip);
            }}
            className={`group absolute top-[6px] flex items-center overflow-hidden rounded-[3px] text-left outline-none ${
              selected ? 'ring-2 ring-inset ring-[var(--tl-select)]' : invalid ? 'ring-2 ring-inset ring-[var(--err)]' : 'ring-1 ring-inset ring-black/20'
            } ${dragging ? 'z-10 cursor-grabbing opacity-90' : track.locked ? 'cursor-default opacity-70' : 'cursor-grab'} ${clip.missing ? 'opacity-50' : ''}`}
            style={{ left: box.left, width, height: CLIP_H, background: color }}
          >
            <BlockWaveform url={waveUrl(clip.path)} width={width} height={CLIP_H} color="rgba(255,255,255,0.5)"
              inMs={clip.startMs} durMs={Math.max(1, clip.endMs - clip.startMs)} visiblePx={{ from: 0, to: width }} />
            {clip.fadeInMs > 0 ? (
              <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0" style={{ width: `${clip.durationMs > 0 ? Math.min(100, (clip.fadeInMs / clip.durationMs) * 100) : 0}%`, background: 'linear-gradient(90deg, rgba(0,0,0,0.45), transparent)' }} />
            ) : null}
            {clip.fadeOutMs > 0 ? (
              <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0" style={{ width: `${clip.durationMs > 0 ? Math.min(100, (clip.fadeOutMs / clip.durationMs) * 100) : 0}%`, background: 'linear-gradient(270deg, rgba(0,0,0,0.45), transparent)' }} />
            ) : null}
            {width > 18 ? (
              <span className="pointer-events-none relative z-[1] min-w-0 flex-1 truncate px-1 text-[9.5px] font-medium leading-[26px] text-white/95">
                {clip.title}
                {clip.volume !== 1 && width > 70 ? <span className="ml-1 tabular-nums text-white/65">{formatVolume(clip.volume)}</span> : null}
              </span>
            ) : null}
            {!track.locked ? (
              <>
                <span aria-hidden title={t('soundStage.overview.trimStart')} onPointerDown={(event) => onBeginDrag(event, clip, 'start', false)}
                  className="absolute inset-y-0 left-0 w-[5px] cursor-ew-resize bg-white/0 transition group-hover:bg-white/30" />
                <span aria-hidden title={t('soundStage.overview.trimEnd')} onPointerDown={(event) => onBeginDrag(event, clip, 'end', false)}
                  className="absolute inset-y-0 right-0 w-[5px] cursor-ew-resize bg-white/0 transition group-hover:bg-white/30" />
              </>
            ) : null}
          </div>
        );
      })}
      {pxPerMs > 0 ? (
        <span aria-hidden className="pointer-events-none absolute inset-y-0 z-[5] w-px" style={{ left: posMs * pxPerMs, background: 'var(--tl-playhead)', opacity: 0.55 }} />
      ) : null}
      {track.muted ? <span aria-hidden className="pointer-events-none absolute inset-0 bg-[var(--dock-pane)]/45" /> : null}
      {track.hidden ? <span aria-hidden className="pointer-events-none absolute inset-0 bg-[var(--dock-pane)]/60" /> : null}
    </div>
  );
}

