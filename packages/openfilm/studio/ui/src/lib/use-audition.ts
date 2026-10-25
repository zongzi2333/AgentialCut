/**
 * One sound audition for the sound stage: a single <audio> element shared by everything that plays there, so two
 * previews never run together. A clip is heard as the part it plays (its trim), not as the whole file; the file's own
 * length still comes from the element, which is what the waveform is drawn against.
 *
 * The element is made here rather than in a React node: it must outlive the pane that selected the sound (a clip
 * selected on the overview and shown in the preview is one sound), and one hidden element is easier to stop than two
 * players each with its own state.
 */
import * as React from 'react';

/** The part of a file to hear, in the file's own ms. */
export interface AuditionRange {
  fromMs: number;
  toMs: number | null;
}

interface AuditionState {
  /** The address now loaded (null: nothing has been played yet). */
  url: string | null;
  playing: boolean;
  /** Where the sound is, in the file's ms. */
  posMs: number;
  /** The file's whole length, as the element reads it (0 until its metadata is in). */
  durationMs: number;
  /** The sound could not be played (a missing file, a refused address). */
  failed: boolean;
}

const IDLE: AuditionState = { url: null, playing: false, posMs: 0, durationMs: 0, failed: false };

/** End of the played range: null means the file's own end. */
const endOf = (range: AuditionRange, durationMs: number) => (
  range.toMs != null && Number.isFinite(range.toMs) ? range.toMs : durationMs > 0 ? durationMs : Number.POSITIVE_INFINITY
);

export function useAudition() {
  const element = React.useRef<HTMLAudioElement | null>(null);
  const [state, setState] = React.useState<AuditionState>(IDLE);
  const [loop, setLoopState] = React.useState(false);
  const [volume, setVolumeState] = React.useState(0.9);
  const range = React.useRef<AuditionRange>({ fromMs: 0, toMs: null });
  const url = React.useRef<string | null>(null);
  const loopRef = React.useRef(loop);
  const volumeRef = React.useRef(volume);
  loopRef.current = loop;
  volumeRef.current = volume;
  /** a seek asked for before the metadata was in, made then */
  const pendingSeek = React.useRef<number | null>(null);
  /** play() asked for before the metadata was in */
  const wantsPlay = React.useRef(false);

  React.useEffect(() => {
    const el = new Audio();
    el.preload = 'metadata';
    el.volume = volumeRef.current;
    element.current = el;

    const time = () => {
      const end = endOf(range.current, Number.isFinite(el.duration) ? el.duration * 1000 : 0);
      let pos = el.currentTime * 1000;
      /* playing a clip: its in point is where it starts, even if the waveform was clicked before it */
      if (!el.paused && pos < range.current.fromMs - 5) {
        el.currentTime = range.current.fromMs / 1000;
        pos = range.current.fromMs;
      }
      /* the end of a clip is where hearing it stops, not where the playhead may not go: paused, a click on the file
         outside the clip shows that part, and play then starts the clip again from its in point */
      if (!el.paused && pos >= end - 5) {
        if (loopRef.current && Number.isFinite(end)) {
          el.currentTime = range.current.fromMs / 1000;
          pos = range.current.fromMs;
        } else {
          el.pause();
          if (Number.isFinite(end)) el.currentTime = end / 1000;
          pos = Number.isFinite(end) ? end : pos;
        }
      }
      setState((now) => (Math.abs(now.posMs - pos) < 2 ? now : { ...now, posMs: pos }));
    };
    const play = () => setState((now) => ({ ...now, playing: true, failed: false }));
    const pause = () => setState((now) => (now.playing ? { ...now, playing: false } : now));
    const ended = () => {
      if (loopRef.current) {
        el.currentTime = range.current.fromMs / 1000;
        void el.play().catch(() => setState((now) => ({ ...now, playing: false, failed: true })));
      } else {
        setState((now) => ({ ...now, playing: false }));
      }
    };
    const meta = () => {
      const durationMs = Number.isFinite(el.duration) ? el.duration * 1000 : 0;
      setState((now) => ({ ...now, durationMs: durationMs || now.durationMs }));
      const seek = pendingSeek.current;
      pendingSeek.current = null;
      if (seek != null) {
        try { el.currentTime = Math.max(0, seek) / 1000; } catch { /* not seekable yet: it starts at 0 */ }
        setState((now) => ({ ...now, posMs: Math.max(0, seek) }));
      }
      if (wantsPlay.current) {
        wantsPlay.current = false;
        void el.play().catch(() => setState((now) => ({ ...now, playing: false, failed: true })));
      }
    };
    const failed = () => {
      wantsPlay.current = false;
      pendingSeek.current = null;
      setState((now) => ({ ...now, playing: false, failed: true }));
    };
    el.addEventListener('timeupdate', time);
    el.addEventListener('seeked', time);
    el.addEventListener('play', play);
    el.addEventListener('playing', play);
    el.addEventListener('pause', pause);
    el.addEventListener('ended', ended);
    el.addEventListener('loadedmetadata', meta);
    el.addEventListener('durationchange', meta);
    el.addEventListener('error', failed);
    return () => {
      el.removeEventListener('timeupdate', time);
      el.removeEventListener('seeked', time);
      el.removeEventListener('play', play);
      el.removeEventListener('playing', play);
      el.removeEventListener('pause', pause);
      el.removeEventListener('ended', ended);
      el.removeEventListener('loadedmetadata', meta);
      el.removeEventListener('durationchange', meta);
      el.removeEventListener('error', failed);
      el.pause();
      el.removeAttribute('src');
      el.load();
      element.current = null;
    };
  }, []);

  /**
   * Have a sound ready without playing it: its metadata (the file's length) is read, its place in the range is shown,
   * and a click on the waveform can move it before the person first presses play.
   */
  const load = React.useCallback((address: string, part: AuditionRange) => {
    const el = element.current;
    if (!el) return;
    range.current = part;
    if (url.current === address) {
      try { el.currentTime = part.fromMs / 1000; } catch { /* it starts where it is */ }
      setState((now) => ({ ...now, url: address, posMs: part.fromMs, failed: false }));
      return;
    }
    el.pause();
    url.current = address;
    wantsPlay.current = false;
    pendingSeek.current = part.fromMs;
    setState({ url: address, playing: false, posMs: part.fromMs, durationMs: 0, failed: false });
    try {
      el.src = address;
      el.load();
    } catch {
      setState((now) => ({ ...now, failed: true }));
    }
  }, []);

  /** Load a sound, or go on with the one in hand, and play from the range's start (or from where it is, when asked). */
  const play = React.useCallback((address: string, part: AuditionRange, { resume = false } = {}) => {    const el = element.current;
    if (!el) return;
    range.current = part;
    const end = endOf(part, Number.isFinite(el.duration) ? el.duration * 1000 : 0);
    if (url.current !== address) {
      url.current = address;
      wantsPlay.current = true;
      pendingSeek.current = part.fromMs;
      setState({ url: address, playing: false, posMs: part.fromMs, durationMs: 0, failed: false });
      try {
        el.src = address;
        el.load();
      } catch {
        setState((now) => ({ ...now, failed: true }));
      }
      return;
    }
    const now = el.currentTime * 1000;
    const at = resume && now >= part.fromMs && now < end - 5 ? now : part.fromMs;
    try { el.currentTime = at / 1000; } catch { /* it starts where the element is */ }
    setState((old) => ({ ...old, url: address, posMs: at, failed: false }));
    void el.play().catch(() => setState((old) => ({ ...old, playing: false, failed: true })));
  }, []);

  const pause = React.useCallback(() => element.current?.pause(), []);

  /** Play or pause what is in hand: a new address always starts at its range's head. */
  const toggle = React.useCallback((address: string, part: AuditionRange) => {
    const el = element.current;
    if (!el) return;
    if (url.current === address && !el.paused) {
      el.pause();
      return;
    }
    const same = url.current === address;
    play(address, part, { resume: same });
  }, [play]);

  const seek = React.useCallback((ms: number, address?: string, part?: AuditionRange) => {
    const el = element.current;
    if (!el) return;
    if (address && url.current !== address) {
      play(address, part ?? { fromMs: ms, toMs: null });
      return;
    }
    try { el.currentTime = Math.max(0, ms) / 1000; } catch { /* not seekable yet */ }
    setState((now) => ({ ...now, posMs: Math.max(0, ms) }));
  }, [play]);

  const stop = React.useCallback(() => {
    const el = element.current;
    if (!el) return;
    el.pause();
    try { el.currentTime = range.current.fromMs / 1000; } catch { /* not seekable */ }
    setState((now) => ({ ...now, playing: false, posMs: range.current.fromMs }));
  }, []);

  const setVolume = React.useCallback((value: number) => {
    const next = Math.min(1, Math.max(0, value));
    setVolumeState(next);
    if (element.current) element.current.volume = next;
  }, []);

  return { ...state, loop, setLoop: setLoopState, volume, setVolume, load, play, pause, toggle, seek, stop };
}

/** What `useAudition` gives: one player, its place, and the ways to move it. */
export type Audition = ReturnType<typeof useAudition>;
