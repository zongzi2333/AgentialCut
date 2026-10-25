/**
 * The film's picture inside the sound step: the current frame, played from the same playhead the sound strip and the
 * placement fields use.
 *
 * It mounts the editor's own Preview (the film's page on its own origin), without the picture-editing layer: the step
 * is about hearing and placing sound, not about selecting what is on screen. The preview's own videos and audio are
 * muted (the page hands its sounds to Studio); this pane plays that sound mix with the editor's Player, so a video's
 * sound is heard here too. The picture follows this pane's own line on the page's clock while the sound plays.
 */
import * as React from 'react';
import {
  AlertTriangle, Eye, EyeOff, Film, Loader2, Pause, Play, Repeat2, SkipBack, SkipForward, Square,
} from 'lucide-react';
import type { Film as FilmValue } from '@/api';
import { Preview, type FilmInfo, type PreviewHandle } from '@/editor/Preview';
import { Player, anchorTime, type Anchor } from '@/editor/player';
import { useT } from '@/i18n';
import { useKeyHint } from '@/lib/keymap-store';
import { formatTimecode } from '@/lib/timecode';
import { Tooltip } from '../../Tooltip';

export interface SoundPictureHandle {
  /** Show the still moment, stopping playback. */
  seek(ms: number): void;
  /** Play from the playhead, or pause it. */
  toggle(): void;
  /** Stop and stay on the current moment. */
  stop(): void;
  playing(): boolean;
  loop(): boolean;
  toggleLoop(): void;
}

/** Playback updates the playhead about as often as the film itself draws (ms), not on every refresh. */
const TICK_MS = 30;

export const SoundPicture = React.forwardRef<SoundPictureHandle, {
  folder: string;
  stage: { w: number; h: number };
  film: FilmValue | null;
  fps: number;
  posMs: number;
  totalMs: number;
  onPos: (ms: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  onKey?: (event: KeyboardEvent) => void;
  /** The audition below is in sight: this pane's toggle hides it for now. */
  auditionShown: boolean;
  onToggleAudition: () => void;
  /** A press on the picture itself (no control) lets the selection go. */
  onClearSelection?: () => void;
}>(function SoundPicture({ folder, stage, film, fps, posMs, totalMs, onPos, onPlayingChange, onKey, auditionShown, onToggleAudition, onClearSelection }, ref) {
  const t = useT();
  const keyHint = useKeyHint();
  const preview = React.useRef<PreviewHandle | null>(null);
  const player = React.useRef(new Player());
  const [info, setInfo] = React.useState<FilmInfo | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const [loop, setLoop] = React.useState(false);
  const posRef = React.useRef(posMs);
  posRef.current = posMs;
  const playingRef = React.useRef(playing);
  playingRef.current = playing;
  const loopRef = React.useRef(loop);
  loopRef.current = loop;
  const anchor = React.useRef<Anchor | null>(null);
  const frame = React.useRef(0);
  const lastTick = React.useRef(0);
  const endMs = Math.max(1, totalMs, info?.duration ? info.duration * 1000 : 0);
  const playingCb = React.useRef(onPlayingChange);
  playingCb.current = onPlayingChange;

  const tellPlaying = (next: boolean) => {
    playingRef.current = next;
    setPlaying(next);
    playingCb.current?.(next);
  };

  const stopTicks = () => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    anchor.current = null;
  };

  /** The film's sounds (the sound mix, not the preview page's muted videos) are loaded with its picture. */
  const loadFilm = React.useCallback((next: FilmInfo) => {
    setInfo(next);
    setFailed(null);
    try {
      player.current.load(new URL(folder).origin, next.sounds, next.duration);
    } catch {
      /* the folder is not an absolute URL: the picture still shows, silently */
    }
  }, [folder]);

  /* a browser that held the sound back lets it start on the next click or key anywhere on the page */
  React.useEffect(() => {
    const wake = () => player.current.wake();
    window.addEventListener('pointerdown', wake, true);
    window.addEventListener('keydown', wake, true);
    return () => {
      window.removeEventListener('pointerdown', wake, true);
      window.removeEventListener('keydown', wake, true);
    };
  }, []);

  const stop = React.useCallback(() => {
    stopTicks();
    tellPlaying(false);
    player.current.pause();
    player.current.seek(posRef.current / 1000);
    preview.current?.seek(posRef.current / 1000);
  }, []);

  const seek = React.useCallback((ms: number) => {
    stopTicks();
    tellPlaying(false);
    const at = Math.max(0, Math.min(endMs, Math.round(ms)));
    player.current.pause();
    player.current.seek(at / 1000);
    onPos(at);
    preview.current?.seek(at / 1000);
  }, [endMs, onPos]);

  const play = React.useCallback(() => {
    let at = Math.round(posRef.current);
    if (at >= endMs - 1) at = 0;
    const now = performance.now();
    const a: Anchor = { t: at / 1000, at: now, rate: 1 };
    anchor.current = a;
    lastTick.current = now;
    onPos(at);
    preview.current?.seek(at / 1000);
    preview.current?.play?.(a);
    player.current.setRate(1);
    if (player.current.duration > 0) {
      player.current.seek(at / 1000);
      player.current.play();
    }
    tellPlaying(true);
    const tick = (time: number) => {
      const live = anchor.current;
      if (!live) return;
      if (time - lastTick.current >= TICK_MS) {
        lastTick.current = time;
        const ms = Math.min(endMs, anchorTime(live, time) * 1000);
        onPos(Math.round(ms));
        if (ms >= endMs - 1) {
          if (loopRef.current) {
            const restart = performance.now();
            const again: Anchor = { t: 0, at: restart, rate: 1 };
            anchor.current = again;
            onPos(0);
            preview.current?.play?.(again);
            if (player.current.duration > 0) {
              player.current.pause();
              player.current.seek(0);
              player.current.play(0);
            }
            frame.current = requestAnimationFrame(tick);
            return;
          }
          stopTicks();
          tellPlaying(false);
          player.current.pause();
          player.current.seek(endMs / 1000);
          preview.current?.seek(endMs / 1000);
          return;
        }
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
  }, [endMs, onPos]);

  React.useImperativeHandle(ref, () => ({
    seek,
    toggle: () => { if (playingRef.current) stop(); else play(); },
    stop,
    playing: () => playingRef.current,
    loop: () => loopRef.current,
    toggleLoop: () => setLoop((on) => !on),
  }), [seek, stop, play]);

  React.useEffect(() => () => {
    stopTicks();
    playingCb.current?.(false);
    player.current.close();
  }, []);

  /* the film as it is now, applied in place (a moved clip, a new volume): the frame does not reload */
  React.useEffect(() => {
    if (!film) return;
    preview.current?.update(film);
  }, [film]);

  /* a new moment from outside (a click on the sound strip, an arrow key): show it still */
  React.useEffect(() => {
    if (playingRef.current) return;
    preview.current?.seek(posMs / 1000);
  }, [posMs]);

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]" aria-label={t('soundStage.picture.title')}>
      <div className="flex h-[34px] shrink-0 items-center gap-1.5 border-b border-[var(--border-soft)] px-2">
        <Film size={13} aria-hidden className="shrink-0 text-[var(--text-faint)]" />
        <span className="shrink-0 text-[11px] font-medium text-[var(--text-muted)]">{t('soundStage.picture.title')}</span>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-[10.5px] tabular-nums text-[var(--text-faint)]">
          {formatTimecode(posMs)} <span className="text-[var(--text-faint)]/70">/ {formatTimecode(endMs)}</span>
        </span>
        <Tooltip label={t('soundStage.picture.start')} side="top" shortcut={keyHint('start')}>
          <button type="button" aria-label={t('soundStage.picture.start')} onClick={() => seek(0)}
            className={PICTURE_BTN}><SkipBack size={12} /></button>
        </Tooltip>
        <Tooltip label={t(playing ? 'soundStage.audition.pause' : 'soundStage.audition.play')} side="top" shortcut={keyHint('play-pause')}>
          <button type="button" aria-label={t(playing ? 'soundStage.audition.pause' : 'soundStage.audition.play')}
            onClick={() => { if (playing) stop(); else play(); }} className={PICTURE_BTN}>
            {playing ? <Pause size={12} /> : <Play size={12} />}
          </button>
        </Tooltip>
        <Tooltip label={t('soundStage.audition.stop')} side="top" shortcut={keyHint('shuttle-stop')}>
          <button type="button" aria-label={t('soundStage.audition.stop')} onClick={stop} disabled={!playing} className={PICTURE_BTN}><Square size={10} /></button>
        </Tooltip>
        <Tooltip label={t('soundStage.audition.loop')} side="top" shortcut={keyHint('loop')}>
          <button type="button" aria-label={t('soundStage.audition.loop')} aria-pressed={loop} onClick={() => setLoop((on) => !on)}
            className={`${PICTURE_BTN} ${loop ? 'bg-[var(--surface-3)] text-[var(--text)]' : ''}`}><Repeat2 size={12} /></button>
        </Tooltip>
        <Tooltip label={t('soundStage.picture.end')} side="top" shortcut={keyHint('end')}>
          <button type="button" aria-label={t('soundStage.picture.end')} onClick={() => seek(endMs)}
            className={PICTURE_BTN}><SkipForward size={12} /></button>
        </Tooltip>
        <Tooltip label={t(auditionShown ? 'soundStage.picture.hideAudition' : 'soundStage.picture.showAudition')} side="top">
          <button type="button" aria-label={t(auditionShown ? 'soundStage.picture.hideAudition' : 'soundStage.picture.showAudition')}
            aria-pressed={!auditionShown} onClick={onToggleAudition} className={PICTURE_BTN}>
            {auditionShown ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        </Tooltip>
      </div>
      <div className="relative min-h-0 flex-1 bg-black"
        onPointerDown={(event) => { if (event.button === 0) onClearSelection?.(); }}>
        {film ? (
          <div className="absolute inset-0">
            <Preview
              ref={preview}
              folder={folder}
              stage={stage}
              time={() => posRef.current / 1000}
              fps={fps}
              onInfo={loadFilm}
              onError={(why) => setFailed(why)}
              onKey={onKey}
            />
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center">
            <Film size={18} aria-hidden className="text-white/35" />
            <p className="text-[11px] text-white/45">{t('soundStage.picture.empty')}</p>
          </div>
        )}
        {!info && film && !failed ? (
          <span className="pointer-events-none absolute inset-x-0 bottom-2 flex items-center justify-center gap-1.5 text-[10px] text-white/45">
            <Loader2 size={11} className="animate-spin" />{t('soundStage.picture.loading')}
          </span>
        ) : null}
        {failed ? (
          <p role="status" className="absolute inset-x-2 bottom-2 flex items-start gap-1.5 rounded-md bg-black/70 px-2 py-1.5 text-[10px] leading-relaxed text-white/75">
            <AlertTriangle size={11} aria-hidden className="mt-px shrink-0 text-[var(--warn)]" />
            <span className="min-w-0">{failed}</span>
          </p>
        ) : null}
        {/* the film itself is an iframe: a transparent layer lets a press on the picture (not just the letterbox) let the
            selection go, which is what a press on empty space means in this step */}
        <div className="absolute inset-0" aria-hidden
          onPointerDown={(event) => { if (event.button === 0) onClearSelection?.(); }} />
      </div>
    </section>
  );
});

const PICTURE_BTN = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-30';
