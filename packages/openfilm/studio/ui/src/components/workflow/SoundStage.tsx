/**
 * Step 4, the sound: the film's voice-overs, score and effects, and the ways to get more of them.
 *
 * The backend owns one timeline (`film.html`); this page reads it through `GET audio` and writes through the editor's
 * own edit path (the same native operations, in the same undo history) or `audio/place` when it is used on its own.
 * Three panes hold the work: where sound comes from, the picture and the sound heard, and the sound placed or changed.
 * The strip at the bottom is the film's own mix, with the playhead the picture follows.
 */
import * as React from 'react';
import {
  AudioLines, Captions, ChevronRight, FolderOpen, RefreshCw, Scissors,
} from 'lucide-react';
import { api, ApiError, projectEvents } from '@/api';
import type {
  AudioAsset, AudioCatalog, AudioClip, AudioSearchResponse, AudioSearchResult, AudioSourceState, AudioState, AudioVoice, Clip, Film, Op, SoundRole,
} from '@/api';
import { useT } from '@/i18n';
import { clipOps, trackFlagOp, type ClipPatch } from '@/lib/sound';
import { AUDIO_ROLE_COLOR } from '@/lib/sound';
import { audioPatchOverlaps, planAudioInsert, planAudioMove } from '@/lib/audio-edit';
import { keyAction, useKeyHint } from '@/lib/keymap-store';
import { normalizeVolume } from '@/lib/loudness';
import { useProviders } from '@/lib/providers';
import { useAudition } from '@/lib/use-audition';
import type { MediaResult } from '@/lib/workspace-resources';
import { formatClipDuration } from '@/lib/workspace-resources';
import { isTypingTarget } from '../typing-target';
import { ConfirmDialog } from '../ConfirmDialog';
import { ContextMenu, TEXT_FIELD, type ContextMenuEntry } from '../ContextMenu';
import { DockPaneDivider, PaneDivider, usePaneSize } from '../PaneDivider';
import { PANE_BAR, PANE_TITLE } from '../dock-pane-bar';
import { EditChatPanel } from '../ai/EditChatPanel';
import { SoundAudition } from './sound/SoundAudition';
import { SoundInspector, emptyDraft, type PlaceDraft } from './sound/SoundInspector';
import { SoundLibrary, type SoundForm, type SoundView } from './sound/SoundLibrary';
import { SoundPicture, type SoundPictureHandle } from './sound/SoundPicture';
import { SoundTracks, type DroppedSound } from './sound/SoundTracks';

const DIRS: Record<SoundRole, string> = { voice: 'vo', music: 'music', sfx: 'sfx' };
const BTN = 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--text)]/30';
const SECONDARY = `${BTN} text-[var(--text)] ring-1 ring-inset ring-[var(--border)] hover:bg-[var(--bg-hover)]`;

const unavailableCatalog = (message: string): AudioCatalog => ({
  kinds: {
    voice: { kind: 'voice', verb: 'tts', available: false },
    music: { kind: 'music', verb: 'music', available: false },
    sfx: { kind: 'sfx', verb: 'sfx', available: false },
  },
  note: message,
  services: '',
});

export function SoundStage({
  projectId, durationMs, initialPosMs = 0, folder, stage, film, fps, onNext, onManageMedia, onImport, onDelete, onReveal,
  onSettings, onEditOps, onUndo, onRedo, subtitleLines, notify, error, chatOpen = false, onCloseChat, onAgentSettings, onOpenSubtitles,
}: {
  projectId: string;
  durationMs: number;
  initialPosMs?: number;
  /** The film's own address, size and frame rate: the picture is drawn from them. */
  folder: string;
  stage: { w: number; h: number };
  film: Film | null;
  fps: number;
  onNext: () => void;
  onManageMedia?: () => void;
  onImport: (files: File[], into: string, onProgress: (index: number, ratio: number, path?: string) => void) => Promise<string[]>;
  onDelete: (path: string) => Promise<MediaResult>;
  onReveal: (path: string) => void;
  onSettings?: () => void;
  /** Settings → Agents, for the sound specialist's model and card. */
  onAgentSettings?: () => void;
  /** Open the shared subtitle inspector while staying in the sound step. */
  onOpenSubtitles?: () => void;
  /** The editor's own edit path: the same native operations, the same undo history, the picture told at once. */
  onEditOps?: (ops: Op[], label: string) => Promise<string | null>;
  onUndo?: () => void;
  onRedo?: () => void;
  /** The sound specialist's conversation, in the right pane. */
  chatOpen?: boolean;
  onCloseChat?: () => void;
  subtitleLines: readonly string[];
  notify: (message: string) => void;
  error: (message: string) => void;
}) {
  const t = useT();
  const keyHint = useKeyHint();
  const audition = useAudition();
  const [view, setView] = React.useState<SoundView>('project');
  const [role, setRole] = React.useState<SoundRole | 'all'>('all');
  const [uploadRole, setUploadRole] = React.useState<SoundRole>('sfx');
  const [library, setLibrary] = React.useState<AudioAsset[] | null>(null);
  const [libraryLoading, setLibraryLoading] = React.useState(false);
  const [audio, setAudio] = React.useState<AudioState | null>(null);
  const [catalog, setCatalog] = React.useState<AudioCatalog | null>(null);
  const legacyProviders = useProviders();
  const [contextMenu, setContextMenu] = React.useState<{ x: number; y: number; clipId: string | null; assetPath: string | null } | null>(null);
  const [asset, setAsset] = React.useState<AudioAsset | null>(null);
  const [remote, setRemote] = React.useState<AudioSearchResult | null>(null);
  const [clipId, setClipId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<PlaceDraft | null>(null);
  const [posMs, setPosMs] = React.useState(() => Math.max(0, Math.round(initialPosMs)));
  const [busy, setBusy] = React.useState<'place' | 'ops' | 'upload' | 'generate' | 'refresh' | null>(null);
  const [networkQuery, setNetworkQuery] = React.useState('');
  const [networkResults, setNetworkResults] = React.useState<AudioSearchResult[] | null>(null);
  const [networkSources, setNetworkSources] = React.useState<AudioSourceState[]>([]);
  const [networkLoading, setNetworkLoading] = React.useState(false);
  const [networkChecked, setNetworkChecked] = React.useState(false);
  const [importingRemote, setImportingRemote] = React.useState<string | null>(null);
  const [form, setForm] = React.useState<SoundForm>({
    kind: 'sfx', text: '', voice: '', musicPrompt: '', musicSec: 30, sfxPrompt: '', sfxSec: 5, provider: '', model: '',
  });
  const [voices, setVoices] = React.useState<AudioVoice[] | null>(null);
  const [voicesLoading, setVoicesLoading] = React.useState(false);
  const [voicesNote, setVoicesNote] = React.useState<string | null>(null);
  /** The voice route the current list belongs to; a provider/model change asks that provider again. */
  const voiceRoute = React.useRef<string | null>(null);
  const [peaks, setPeaks] = React.useState<number[] | null>(null);
  const [waveDurationMs, setWaveDurationMs] = React.useState<number | null>(null);
  const [peaksLoading, setPeaksLoading] = React.useState(false);
  /** Each file's whole length, by path: a clip only knows the part it plays, and a trim must not run past the end. */
  const [fileDurations, setFileDurations] = React.useState<Record<string, number>>({});
  const [confirm, setConfirm] = React.useState<{ kind: 'asset'; asset: AudioAsset } | { kind: 'clip'; clip: AudioClip } | null>(null);
  const pictureRef = React.useRef<SoundPictureHandle | null>(null);
  const [picturePlaying, setPicturePlaying] = React.useState(false);
  /** The audio agent card and its model: the panel says what is missing until both are set. */
  const [audioAgentReady, setAudioAgentReady] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    let live = true;
    void Promise.all([api.agentCards(), api.providerCards()]).then(([agents, providers]) => {
      if (!live) return;
      const agent = agents.state.agents.find((item) => item.role === 'audio' && item.enabled);
      const card = providers.state.cards.find((item) => item.id === agent?.cardId && item.enabled);
      setAudioAgentReady(Boolean(agent && agent.modelId && card));
    }).catch(() => { if (live) setAudioAgentReady(false); });
    return () => { live = false; };
  }, []);

  const rowRef = React.useRef<HTMLDivElement | null>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);
  const centerRef = React.useRef<HTMLDivElement | null>(null);
  const { width: libraryWidth, commit: commitLibraryWidth } = usePaneSize('openfilm.soundStage.libraryW', 300, 240);
  const { width: inspectorWidth, commit: commitInspectorWidth } = usePaneSize('openfilm.soundStage.inspectorW', 320, 268);
  const { width: chatWidth, commit: commitChatWidth } = usePaneSize('openfilm.soundStage.chatW', 330, 280);
  const { width: tracksHeight, commit: commitTracksHeight } = usePaneSize('openfilm.soundStage.tracksH', 190, 112);
  const { width: auditionHeight, commit: commitAuditionHeight } = usePaneSize('openfilm.soundStage.auditionH', 210, 140);
  const [showPicture, setShowPicture] = React.useState(true);
  const [showAudition, setShowAudition] = React.useState(true);
  /* the three panes share the row: on a narrow window the sides give room to the picture and the sound, down to their
     own minimums, rather than squeezing the middle to a sliver */
  const [rowWidth, setRowWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    const measure = () => setRowWidth(Math.max(0, Math.round(row.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  const preferredLibrary = libraryWidth ?? 300;
  const preferredInspector = inspectorWidth ?? 320;
  const chatShownWidth = chatOpen ? Math.max(280, chatWidth ?? 330) : 0;
  const sidesRoom = rowWidth ? Math.max(460, rowWidth - 300 - 18 - chatShownWidth) : preferredLibrary + preferredInspector;
  const sidesShown = preferredLibrary + preferredInspector;
  const sidesScale = sidesShown > sidesRoom ? sidesRoom / sidesShown : 1;
  const libraryShownWidth = Math.max(220, Math.round(preferredLibrary * sidesScale));
  const inspectorShownWidth = Math.max(240, Math.round(preferredInspector * sidesScale));

  const clip = audio?.clips.find((item) => item.id === clipId) ?? null;
  const totalMs = Math.max(1000, durationMs, audio?.durationMs ?? 0);
  /** The latest read, for writes planned a moment ago (a drag, a probe): a stale base would be a needless conflict. */
  const audioRef = React.useRef<AudioState | null>(null);
  audioRef.current = audio;
  /** Reads can overlap (a nudge, another key): only the latest one becomes the strip's state. */
  const audioSeq = React.useRef(0);

  /* the callbacks the page was given may be new on every render: the readers below stay the same, so the project's
     event stream is not torn down and put back for a new wrapper */
  const errorRef = React.useRef(error);
  errorRef.current = error;
  const tRef = React.useRef(t);
  tRef.current = t;

  const loadAudio = React.useCallback(async (): Promise<AudioState | null> => {
    const seq = ++audioSeq.current;
    try {
      const next = await api.audio(projectId);
      if (seq === audioSeq.current) setAudio(next);
      return next;
    } catch (e) {
      if (seq === audioSeq.current) errorRef.current(e instanceof Error ? e.message : tRef.current('soundStage.errors.load'));
      return null;
    }
  }, [projectId]);

  const loadLibrary = React.useCallback(async (): Promise<AudioAsset[]> => {
    setLibraryLoading(true);
    try {
      const answer = await api.audioLibrary(projectId, { role: 'all', facts: false });
      setLibrary(answer.files);
      return answer.files;
    } catch (e) {
      errorRef.current(e instanceof Error ? e.message : tRef.current('soundStage.errors.load'));
      return [];
    } finally {
      setLibraryLoading(false);
    }
  }, [projectId]);

  React.useEffect(() => {
    let alive = true;
    setAudio(null);
    setLibrary(null);
    setCatalog(null);
    setAsset(null);
    setRemote(null);
    setClipId(null);
    setDraft(null);
    setPosMs(Math.max(0, Math.round(initialPosMs)));
    /* the page is its own reader: a failure to read the project's sound is said once, not on every refresh */
    void api.audio(projectId).then((next) => { if (alive) setAudio(next); }, (e) => { if (alive) error(e instanceof Error ? e.message : t('soundStage.errors.load')); });
    void api.audioLibrary(projectId, { role: 'all', facts: false }).then((answer) => { if (alive) setLibrary(answer.files); }, (e) => { if (alive) error(e instanceof Error ? e.message : t('soundStage.errors.load')); });
    void api.audioCatalog(projectId).then((next) => { if (alive) setCatalog(next); }, (e) => {
      if (alive) setCatalog(unavailableCatalog(e instanceof Error ? e.message : t('soundStage.errors.load')));
    });
    return () => { alive = false; };
    /* the project in hand decides everything; a refresh has its own buttons */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  /* the film or its files changed (our own writes included): read them again, once the burst is over. A film edit
     (a clip moved, a track muted) never changes the material list, so only a files event reads that again. */
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let needFiles = false;
    const stop = projectEvents(projectId, (event) => {
      if (event.type !== 'film' && event.type !== 'files') return;
      if (event.type === 'files') needFiles = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void loadAudio();
        if (needFiles) { needFiles = false; void loadLibrary(); }
      }, 220);
    });
    return () => { stop(); if (timer) clearTimeout(timer); };
  }, [projectId, loadAudio, loadLibrary]);

  /* a clip that is gone (another window removed it) is no selection */
  React.useEffect(() => {
    if (clipId && audio && !audio.clips.some((item) => item.id === clipId)) setClipId(null);
  }, [audio, clipId]);

  /* the selected file's waveform, for the preview and nothing else */
  const wavePath = clip?.path ?? asset?.path ?? null;
  React.useEffect(() => {
    if (!wavePath) { setPeaks(null); setWaveDurationMs(null); return undefined; }
    let alive = true;
    setPeaks(null);
    setWaveDurationMs(null);
    setPeaksLoading(true);
    void api.audioWave(projectId, wavePath).then((answer) => {
      if (!alive) return;
      setPeaks(answer.peaks ?? null);
      const duration = answer.duration && answer.duration > 0 ? Math.round(answer.duration * 1000) : null;
      setWaveDurationMs(duration);
      if (duration) setFileDurations((now) => (now[wavePath] === duration ? now : { ...now, [wavePath]: duration }));
    }, () => { /* no waveform: the preview says so by itself */ }).finally(() => { if (alive) setPeaksLoading(false); });
    return () => { alive = false; };
  }, [projectId, wavePath]);

  /* a clip knows only the part it plays; each file's own length is measured once, so a trim cannot run past its end */
  const askedDurations = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (!audio) return undefined;
    const paths = [...new Set(audio.clips.map((item) => item.path))].filter((path) => !askedDurations.current.has(path));
    if (!paths.length) return undefined;
    for (const path of paths) askedDurations.current.add(path);
    let alive = true;
    void Promise.all(paths.map(async (path) => {
      try {
        const probe = await api.audioProbe(projectId, path);
        return [path, probe.duration && probe.duration > 0 ? Math.round(probe.duration * 1000) : 0] as const;
      } catch { return [path, 0] as const; }
    })).then((rows) => {
      if (!alive) return;
      setFileDurations((now) => {
        const next = { ...now };
        for (const [path, duration] of rows) next[path] = duration;
        return next;
      });
    });
    return () => { alive = false; };
  }, [audio, projectId]);

  const waveUrl = React.useCallback((path: string) => (
    `/api/projects/${encodeURIComponent(projectId)}/audio/asset?what=wave&path=${encodeURIComponent(path)}`
  ), [projectId]);

  const setPos = React.useCallback((ms: number) => {
    setPosMs(Math.max(0, Math.min(totalMs, Math.round(ms))));
  }, [totalMs]);
  /** Move the film playhead: the picture stops and shows the moment, the strip follows. */
  const seekFilm = React.useCallback((ms: number) => {
    const at = Math.max(0, Math.min(totalMs, Math.round(ms)));
    if (pictureRef.current) pictureRef.current.seek(at);
    else setPosMs(at);
  }, [totalMs]);

  const patchDraft = React.useCallback((patch: Partial<PlaceDraft>) => {
    setDraft((now) => (now ? { ...now, ...patch } : now));
  }, []);

  const selectAsset = React.useCallback((next: AudioAsset) => {
    audition.pause();
    setAsset(next);
    setRemote(null);
    setClipId(null);
    setDraft(emptyDraft(next));
    /* the list answers at once without ffprobe: measure this one for the placement form and the preview's length */
    if (next.durationMs == null) {
      void api.audioProbe(projectId, next.path).then((probe) => {
        const durationMs = probe.duration && probe.duration > 0 ? Math.round(probe.duration * 1000) : null;
        if (!durationMs) return;
        setAsset((now) => (now && now.path === next.path ? { ...now, durationMs } : now));
        setDraft((now) => (now && now.endMs == null ? { ...now, endMs: durationMs } : now));
        setLibrary((files) => files?.map((file) => (file.path === next.path ? { ...file, durationMs } : file)) ?? files);
        setFileDurations((now) => ({ ...now, [next.path]: durationMs }));
      }, () => { /* the inspector says what it could not read */ });
    }
  }, [audition, projectId]);

  const selectClip = React.useCallback((next: AudioClip) => {
    audition.pause();
    setClipId(next.id);
    setAsset(null);
    setRemote(null);
    setDraft(null);
    seekFilm(next.atMs);
  }, [audition, seekFilm]);

  const selectRemote = React.useCallback((result: AudioSearchResult) => {
    audition.pause();
    setRemote(result);
    setAsset(null);
    setClipId(null);
    setDraft(null);
  }, [audition]);

  /** Let the sound or clip selection go: a press on empty space, the inspector's close, or Esc. */
  const clearSelection = React.useCallback(() => {
    audition.pause();
    setAsset(null);
    setRemote(null);
    setClipId(null);
    setDraft(null);
  }, [audition.pause]);

  /* A press on empty space anywhere in the step lets the selection go: a panel's background, the picture, the
     space under the last row. Controls, clips, the waveform, the ruler and menus keep their own presses. */
  React.useEffect(() => {
    const onBlank = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const el = event.target as HTMLElement | null;
      if (!el) return;
      if (el.closest('button, a, input, textarea, select, summary, label, [role="button"], [role="tab"], [role="slider"], [role="separator"], [role="menuitem"], [role="option"], [role="switch"], [role="dialog"], [data-popover-panel], [contenteditable="true"], [data-sound-clip], [data-sound-wave], [data-sound-keep]')) return;
      if (asset || remote || clipId) clearSelection();
    };
    window.addEventListener('pointerdown', onBlank, true);
    return () => window.removeEventListener('pointerdown', onBlank, true);
  }, [asset, remote, clipId, clearSelection]);

  const fail = React.useCallback((e: unknown, fallback: string) => {
    if (e instanceof ApiError && e.status === 409) {
      notify(t('soundStage.notice.conflict'));
      void loadAudio();
      return;
    }
    error(e instanceof Error ? e.message : t(fallback));
  }, [error, loadAudio, notify, t]);

  /** One native batch, then the film and the strip read again. Through the editor, it is one undo step too. */
  const write = React.useCallback(async (ops: Op[], done: string, label = t('history.stepEdit')) => {
    pictureRef.current?.stop();
    setBusy('ops');
    try {
      if (onEditOps) {
        const why = await onEditOps(ops, label);
        if (why) { error(why); return false; }
      } else {
        const current = audioRef.current;
        if (!current) return false;
        await api.audioOps(projectId, current.revision, ops);
      }
      notify(done);
      await loadAudio();
      return true;
    } catch (e) {
      fail(e, 'soundStage.errors.edit');
      return false;
    } finally {
      setBusy(null);
    }
  }, [onEditOps, projectId, notify, error, loadAudio, fail, t]);

  /**
   * One sound put on the film. Through the editor's own edit path when it is given (an undo step, the picture told at
   * once); the native insert is the same either way.
   */
  const insertSound = async (how: {
    path: string; atSec: number; startSec: number; endSec: number | null; durationMs: number | null;
    volume: number; fade: [number, number]; speed: number; track: number | null; title: string;
  }) => {
    pictureRef.current?.stop();
    const before = new Set((audioRef.current?.clips ?? []).map((item) => item.id));
    const speed = how.speed > 0 ? how.speed : 1;
    const fileMs = fileDurations[how.path] ?? null;
    const durationMs = how.durationMs ?? (how.endSec != null
      ? Math.max(0, Math.round(((how.endSec - how.startSec) * 1000) / speed))
      : fileMs != null ? Math.max(0, Math.round((fileMs - how.startSec * 1000) / speed)) : null);
    const placement = audioRef.current
      ? planAudioInsert(audioRef.current, { track: how.track, atMs: Math.round(how.atSec * 1000), durationMs })
      : null;
    if (!placement && audioRef.current) {
      error(t('soundStage.inspector.trackLocked'));
      return false;
    }
    const atSec = (placement?.atMs ?? Math.round(how.atSec * 1000)) / 1000;
    const track = placement?.track ?? how.track;
    let clipId: string | null = null;
    if (onEditOps) {
      const clip: Partial<Clip> & { src: string } = {
        src: how.path,
        ...(atSec ? { at: atSec } : {}),
        ...(how.endSec != null ? { time: [how.startSec, how.endSec] as [number, number] } : how.startSec ? { time: [how.startSec] as [number] } : {}),
        ...(how.volume !== 1 ? { volume: how.volume } : {}),
        ...(how.speed !== 1 ? { speed: how.speed } : {}),
        ...(how.fade[0] || how.fade[1] ? { overrides: [{ fade: how.fade }] } : {}),
      };
      const insert: Op = { op: 'insert', clip: clip as never, ...(track == null ? {} : { track }) };
      const why = await onEditOps([...(placement?.ops ?? []), insert], t('history.stepPlaceAudio'));
      if (why) { error(why); return false; }
      const next = await loadAudio();
      clipId = next?.clips.find((item) => (item.path === how.path || item.path.startsWith(`${how.path}#`)) && !before.has(item.id))?.id ?? null;
    } else {
      const made = await api.audioPlace(projectId, {
        path: how.path,
        at: atSec,
        start: how.startSec,
        ...(how.endSec == null ? {} : { end: how.endSec }),
        volume: how.volume,
        fade: how.fade,
        speed: how.speed,
        ...(track == null ? {} : { track }),
        base: audioRef.current?.revision ?? null,
      });
      clipId = made.clipId;
      await loadAudio();
    }
    notify(t('soundStage.notice.placed').replace('{title}', how.title));
    if (clipId) setClipId(clipId);
    setAsset(null);
    setDraft(null);
    return true;
  };

  const place = async () => {
    if (!asset || !draft) return;
    const end = draft.endMs == null ? null : draft.endMs / 1000;
    if (end != null && end <= draft.startMs / 1000) { error(t('soundStage.inspector.endBeforeStart')); return; }
    setBusy('place');
    try {
      await insertSound({
        path: asset.path,
        atSec: posMs / 1000,
        startSec: draft.startMs / 1000,
        endSec: end,
        durationMs: draft.endMs != null
          ? Math.max(0, Math.round((draft.endMs - draft.startMs) / (draft.speed > 0 ? draft.speed : 1)))
          : asset.durationMs != null
            ? Math.max(0, Math.round(asset.durationMs / (draft.speed > 0 ? draft.speed : 1)))
            : null,
        volume: draft.volume,
        fade: [draft.fadeInMs / 1000, draft.fadeOutMs / 1000],
        speed: draft.speed,
        track: draft.track,
        title: asset.title || asset.name,
      });
    } catch (e) {
      fail(e, 'soundStage.errors.place');
    } finally {
      setBusy(null);
    }
  };

  const moveClip = (target: AudioClip, atMs: number) => {
    const current = audioRef.current;
    if (!current) {
      void write(clipOps(target, { atMs }), t('soundStage.notice.moved').replace('{title}', target.title || target.name), t('history.stepMove'));
      return;
    }
    const ops = planAudioMove(current, target, atMs);
    if (!ops) { error(t('soundStage.inspector.trackLocked')); return; }
    if (!ops.length) return;
    void write(ops, t('soundStage.notice.moved').replace('{title}', target.title || target.name), t('history.stepMove'));
  };
  const trimClip = (target: AudioClip, patch: { startMs?: number; endMs?: number; atMs?: number }) => {
    const current = audioRef.current;
    if (current && audioPatchOverlaps(current, target, patch)) {
      error(t('soundStage.errors.overlap'));
      return;
    }
    void write(clipOps(target, patch), t('soundStage.notice.trimmed').replace('{title}', target.title || target.name), t('history.stepMove'));
  };
  const applyClip = (target: AudioClip, patch: ClipPatch) => {
    const current = audioRef.current;
    const timing = (patch.atMs != null && patch.atMs !== target.atMs)
      || (patch.startMs != null && patch.startMs !== target.startMs)
      || (patch.endMs != null && patch.endMs !== target.endMs)
      || (patch.speed != null && patch.speed !== target.speed)
      || (patch.track != null && patch.track !== target.track);
    if (current && timing && audioPatchOverlaps(current, target, patch)) {
      error(t('soundStage.errors.overlap'));
      return;
    }
    void write(clipOps(target, patch), t('soundStage.notice.applied').replace('{title}', target.title || target.name), t('history.stepEdit'));
  };
  const toggleTrack = (track: number, field: 'muted' | 'locked', value: boolean) => {
    void write([trackFlagOp(track, field, value)], t(value ? `soundStage.notice.${field}` : `soundStage.notice.un${field}`), t('history.stepTrackFlag'));
  };
  const dropSound = (sound: DroppedSound, track: number, atMs: number) => {
    setBusy('place');
    void insertSound({
      path: sound.path,
      atSec: atMs / 1000,
      startSec: 0,
      endSec: sound.durationMs == null ? null : sound.durationMs / 1000,
      durationMs: sound.durationMs,
      volume: 1,
      fade: [0, 0],
      speed: 1,
      track,
      title: sound.title ?? sound.path,
    }).catch((e) => fail(e, 'soundStage.errors.place')).finally(() => setBusy(null));
  };

  const removeClip = (target: AudioClip) => setConfirm({ kind: 'clip', clip: target });
  const removeAsset = (target: AudioAsset) => setConfirm({ kind: 'asset', asset: target });

  const confirmRemove = async () => {
    if (!confirm) return;
    if (confirm.kind === 'clip') {
      const target = confirm.clip;
      setConfirm(null);
      const done = await write([{ op: 'remove', clip: target.id }], t('soundStage.notice.removed').replace('{title}', target.title || target.name));
      if (done) { setClipId(null); setDraft(null); }
      return;
    }
    const target = confirm.asset;
    setConfirm(null);
    try {
      const result = await onDelete(target.path);
      if (result !== 'ok') { error(t('soundStage.errors.delete')); return; }
      notify(t('soundStage.notice.deleted').replace('{title}', target.title || target.name));
      await Promise.all([loadAudio(), loadLibrary()]);
      if (asset?.path === target.path) { setAsset(null); setDraft(null); }
    } catch (e) {
      error(e instanceof Error ? e.message : t('soundStage.errors.delete'));
    }
  };

  const upload = async (files: File[]) => {
    setBusy('upload');
    try {
      const landed = await onImport(files, `assets/audio/${DIRS[uploadRole]}`, () => {});
      const next = await loadLibrary();
      await loadAudio();
      const first = landed[0] ? next.find((item) => item.path === landed[0]) : undefined;
      if (first) { setView('project'); setRole(uploadRole); selectAsset(first); }
      notify(t('soundStage.notice.uploaded').replace('{n}', String(landed.length)));
    } catch (e) {
      error(e instanceof Error ? e.message : t('soundStage.errors.upload'));
    } finally {
      setBusy(null);
    }
  };

  const searchNetwork = async () => {
    const wantsEffects = role === 'all' || role === 'sfx';
    const wantsMusic = role === 'all' || role === 'music';
    /* a voice is made or imported, not searched on the stock services; and asking the backend for `all` would list
       the project's own files too, probing every one of them just to be filtered out here */
    if (!wantsEffects && !wantsMusic) {
      setNetworkResults([]);
      setNetworkSources([]);
      setNetworkChecked(true);
      return;
    }
    setNetworkLoading(true);
    try {
      const calls: Promise<AudioSearchResponse>[] = [];
      if (wantsEffects) calls.push(api.audioSearch(projectId, { q: networkQuery.trim(), source: 'freesound', limit: 30 }));
      if (wantsMusic) calls.push(api.audioSearch(projectId, { q: networkQuery.trim(), source: 'jamendo', limit: 30 }));
      const answers = await Promise.all(calls);
      setNetworkResults(answers.flatMap((answer) => answer.results).slice(0, 30));
      setNetworkSources(answers.flatMap((answer) => answer.sources).filter((source) => source.id !== 'local'));
      setNetworkChecked(true);
    } catch (e) {
      fail(e, 'soundStage.errors.search');
    } finally {
      setNetworkLoading(false);
    }
  };

  /* opening the network pane says whether the two services can be used here, without asking for a search yet */
  React.useEffect(() => {
    if (view !== 'network' || networkChecked) return;
    setNetworkChecked(true);
    void Promise.all([
      api.audioSearch(projectId, { source: 'freesound', q: '', limit: 1 }),
      api.audioSearch(projectId, { source: 'jamendo', q: '', limit: 1 }),
    ]).then(([effects, music]) => {
      setNetworkSources([...effects.sources, ...music.sources].filter((source) => source.id !== 'local'));
    }, () => { /* the search buttons report their own failures */ });
  }, [view, networkChecked, projectId]);

  const importRemote = async (result: AudioSearchResult) => {
    if (!result.downloadUrl) return;
    const key = `${result.source}:${result.id}`;
    setImportingRemote(key);
    try {
      const made = await api.audioImport(projectId, {
        url: result.downloadUrl,
        role: result.role,
        name: result.title,
        source: result.source,
        meta: {
          ...(result.credit ? { credit: result.credit } : {}),
          ...(result.license ? { license: result.license } : {}),
          ...(result.page ? { page: result.page } : {}),
          source: result.source,
        },
      });
      notify(t('soundStage.notice.imported').replace('{title}', made.asset.title || made.asset.name));
      if (made.unreadable) error(made.unreadable);
      const next = await loadLibrary();
      await loadAudio();
      setView('project');
      setRole(result.role);
      const found = next.find((item) => item.path === made.asset.path) ?? made.asset;
      selectAsset(found);
    } catch (e) {
      fail(e, 'soundStage.errors.import');
    } finally {
      setImportingRemote(null);
    }
  };

  const loadVoices = async () => {
    if (voicesLoading) return;
    setVoicesLoading(true);
    setVoicesNote(null);
    try {
      const via = form.provider || undefined;
      const model = via && form.model ? form.model : undefined;
      const answer = await api.audioVoices(projectId, { limit: 50, ...(via ? { via } : {}), ...(model ? { model } : {}) });
      setVoices(answer.voices ?? []);
      if (!answer.voices?.length) setVoicesNote(answer.note ?? t('soundStage.generate.voicesEmpty'));
    } catch (e) {
      setVoices([]);
      setVoicesNote(e instanceof Error ? e.message : t('soundStage.errors.voices'));
    } finally {
      setVoicesLoading(false);
    }
  };

  /* Voices belong to the selected provider/model: changing it clears the old list and asks again. */
  const voiceRouteKey = `${form.kind}|${form.provider}|${form.model}`;
  React.useEffect(() => {
    if (voiceRoute.current === null) { voiceRoute.current = voiceRouteKey; return; }
    if (voiceRoute.current === voiceRouteKey) return;
    voiceRoute.current = voiceRouteKey;
    if (view !== 'generate' || form.kind !== 'voice') return;
    setVoices(null);
    setForm((now) => ({ ...now, voice: '' }));
    void loadVoices();
    // loadVoices reads the current form; this effect runs once per provider/model route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceRouteKey, view, form.kind]);

  const generate = async () => {
    const kind = form.kind;
    const voice = form.voice || voices?.[0]?.voiceId || '';
    const prompt = kind === 'music' ? form.musicPrompt.trim() : form.sfxPrompt.trim();
    if (kind === 'voice' && (!form.text.trim() || !voice)) {
      error(t(!form.text.trim() ? 'soundStage.generate.needText' : 'soundStage.generate.needVoice'));
      return;
    }
    if (kind !== 'voice' && !prompt) { error(t('soundStage.generate.needPrompt')); return; }
    setBusy('generate');
    try {
      const chosen = form.provider && legacyProviders.state?.providers.some((item) => item.id === form.provider && item.source)
        ? form.provider
        : undefined;
      const route = { ...(chosen ? { via: chosen } : {}), ...(chosen && form.model ? { model: form.model } : {}) };
      const made = await api.audioGenerate(projectId, kind === 'voice'
        ? { kind: 'voice', text: form.text.trim(), voice, ...route }
        : kind === 'music'
          ? { kind: 'music', prompt, ...(form.musicSec ? { sec: form.musicSec } : {}), ...route }
          : { kind: 'sfx', prompt, ...(form.sfxSec ? { sec: form.sfxSec } : {}), ...route });
      notify(t('soundStage.notice.generated').replace('{title}', made.asset.title || made.asset.name));
      const next = await loadLibrary();
      await loadAudio();
      setView('project');
      setRole(kind);
      selectAsset(next.find((item) => item.path === made.asset.path) ?? made.asset);
      setForm((now) => ({ ...now, ...(kind === 'voice' ? { text: '' } : kind === 'music' ? { musicPrompt: '' } : { sfxPrompt: '' }) }));
    } catch (e) {
      fail(e, 'soundStage.errors.generate');
    } finally {
      setBusy(null);
    }
  };

  const refreshAll = async () => {
    setBusy('refresh');
    try { await Promise.all([loadAudio(), loadLibrary()]); } finally { setBusy(null); }
  };

  /* ── the keys, read fresh each press: the same scheme Settings keeps, and this step's own audio actions ── */
  const frameMs = 1000 / (fps > 0 ? fps : 30);
  const cuts = React.useMemo(() => {
    const points = new Set<number>([0, Math.round(totalMs)]);
    for (const item of audio?.clips ?? []) {
      points.add(Math.round(item.atMs));
      points.add(Math.round(item.atMs + item.durationMs));
    }
    return [...points].filter((ms) => Number.isFinite(ms)).sort((a, b) => a - b);
  }, [audio, totalMs]);
  const selectedTrack = clip ? audio?.tracks.find((track) => track.index === clip.track) : undefined;
  const needClip = () => error(t('soundStage.keys.needClip'));

  const volumeBy = (target: AudioClip, delta: number) => {
    const next = Math.max(0, Math.min(2, Math.round((target.volume + delta) * 100) / 100));
    if (next === target.volume) return;
    void write(clipOps(target, { volume: next }), t('soundStage.notice.applied').replace('{title}', target.title || target.name), t('history.stepVolume'));
  };
  const fadeBy = (target: AudioClip, edge: 'in' | 'out', deltaMs: number) => {
    const maxIn = Math.max(0, target.durationMs - target.fadeOutMs);
    const maxOut = Math.max(0, target.durationMs - target.fadeInMs);
    const fadeInMs = edge === 'in' ? Math.max(0, Math.min(maxIn, target.fadeInMs + deltaMs)) : target.fadeInMs;
    const fadeOutMs = edge === 'out' ? Math.max(0, Math.min(maxOut, target.fadeOutMs + deltaMs)) : target.fadeOutMs;
    void write(clipOps(target, { fadeInMs, fadeOutMs }), t('soundStage.notice.applied').replace('{title}', target.title || target.name), t('history.stepFade'));
  };
  const normalizeClip = async (target: AudioClip) => {
    try {
      const found = await api.audioLoudness(projectId, target.path, target.startMs / 1000, target.endMs / 1000);
      const plan = normalizeVolume(found.lufs, -14);
      if ('silent' in plan) { error(t('soundStage.loudness.silent')); return; }
      void write(clipOps(target, { volume: plan.volume }), t('soundStage.notice.normalized').replace('{title}', target.title || target.name), t('history.stepVolume'));
    } catch (e) {
      error(e instanceof Error ? e.message : t('soundStage.loudness.measureFailed'));
    }
  };
  const splitClip = (target: AudioClip) => {
    const local = posMs - target.atMs;
    if (local <= 30 || local >= target.durationMs - 30) { error(t('soundStage.keys.splitEdge')); return; }
    const cut = target.startMs + local * target.speed;
    void write(
      [{
        op: 'split', clip: target.id,
        left: { time: [target.startMs / 1000, cut / 1000] },
        right: { time: [cut / 1000, target.endMs / 1000], at: posMs / 1000 },
      }],
      t('soundStage.notice.split').replace('{title}', target.title || target.name),
      t('history.stepSplit'),
    );
  };

  /* ── the right-click menu: the page, a clip, or a library sound ── */
  const openContextMenu = (event: React.MouseEvent) => {
    const el = event.target as HTMLElement;
    /* a field keeps the app's text menu (copy / cut / paste) rather than this one */
    if (el.closest(TEXT_FIELD)) return;
    event.preventDefault();
    event.stopPropagation();
    const clipEl = el.closest('[data-sound-clip]') as HTMLElement | null;
    const assetEl = el.closest('[data-sound-asset]') as HTMLElement | null;
    const clipTarget = clipEl
      ? audio?.clips.find((item) => item.id === clipEl.getAttribute('data-sound-clip')) ?? null
      : el.closest('[aria-label="试听"]') ? clip : null;
    const assetTarget = assetEl
      ? library?.find((item) => item.path === assetEl.getAttribute('data-sound-asset')) ?? null
      : null;
    if (clipTarget) selectClip(clipTarget);
    else if (assetTarget) selectAsset(assetTarget);
    setContextMenu({ x: event.clientX, y: event.clientY, clipId: clipTarget?.id ?? null, assetPath: assetTarget?.path ?? null });
  };

  const menuClip = contextMenu?.clipId ? audio?.clips.find((item) => item.id === contextMenu.clipId) ?? null : null;
  const menuAsset = contextMenu?.assetPath ? library?.find((item) => item.path === contextMenu.assetPath) ?? null : null;
  const menuTrack = menuClip ? audio?.tracks.find((item) => item.index === menuClip.track) : null;
  const menuClipLocal = menuClip ? posMs - menuClip.atMs : 0;
  const canSplitMenuClip = Boolean(menuClip && menuClipLocal > 30 && menuClipLocal < menuClip.durationMs - 30);
  const menuItems: ContextMenuEntry[] = [];
  if (contextMenu) {
    if (menuAsset) {
      menuItems.push(
        { id: 'audition-asset', label: t('soundStage.context.auditionAsset'), onSelect: () => selectAsset(menuAsset) },
        {
          id: 'place-asset', label: t('soundStage.context.placeAtHead'), disabled: Boolean(menuAsset.unreadable || menuAsset.missing),
          onSelect: () => {
            const end = menuAsset.durationMs != null && menuAsset.durationMs > 0 ? menuAsset.durationMs / 1000 : null;
            setBusy('place');
            void insertSound({
              path: menuAsset.path, atSec: posMs / 1000, startSec: 0, endSec: end, durationMs: menuAsset.durationMs,
              volume: 1, fade: [0, 0], speed: 1, track: null, title: menuAsset.title || menuAsset.name,
            }).catch((e) => fail(e, 'soundStage.errors.place')).finally(() => setBusy(null));
          },
        },
        { id: 'asset-sep', separator: true },
        { id: 'reveal-asset', label: t('soundStage.inspector.reveal'), onSelect: () => onReveal(menuAsset.path) },
        { id: 'delete-asset', label: t('soundStage.inspector.delete'), danger: true, onSelect: () => removeAsset(menuAsset) },
      );
    } else if (menuClip) {
      menuItems.push(
        {
          id: 'picture-play', label: t(picturePlaying ? 'soundStage.context.pausePicture' : 'soundStage.context.playPicture'),
          shortcut: keyHint('play-pause'), onSelect: () => pictureRef.current?.toggle(),
        },
        { id: 'picture-start', label: t('soundStage.picture.start'), shortcut: keyHint('start'), onSelect: () => seekFilm(0) },
        { id: 'picture-end', label: t('soundStage.picture.end'), shortcut: keyHint('end'), onSelect: () => seekFilm(totalMs) },
        { id: 'clip-sep-1', separator: true },
        {
          id: 'split-clip', label: t('timeline.menuSplitHere'), shortcut: keyHint('split'), disabled: !canSplitMenuClip,
          hint: t('soundStage.keys.splitEdge'), onSelect: () => splitClip(menuClip),
        },
        {
          id: 'remove-clip', label: t('soundStage.inspector.remove'), shortcut: keyHint('remove'), danger: true,
          onSelect: () => removeClip(menuClip),
        },
        { id: 'clip-sep-2', separator: true },
        { id: 'volume-down', label: t('soundStage.inspector.volumeDown'), shortcut: keyHint('audio-volume-down'), onSelect: () => volumeBy(menuClip, -0.1) },
        { id: 'volume-up', label: t('soundStage.inspector.volumeUp'), shortcut: keyHint('audio-volume-up'), onSelect: () => volumeBy(menuClip, 0.1) },
        { id: 'fade-in', label: t('soundStage.inspector.fadeIn'), shortcut: keyHint('audio-fade-in'), onSelect: () => fadeBy(menuClip, 'in', 200) },
        { id: 'fade-out', label: t('soundStage.inspector.fadeOut'), shortcut: keyHint('audio-fade-out'), onSelect: () => fadeBy(menuClip, 'out', 200) },
        { id: 'normalize', label: t('soundStage.loudness.normalizeWeb'), shortcut: keyHint('audio-normalize'), onSelect: () => void normalizeClip(menuClip) },
        { id: 'clip-sep-3', separator: true },
        {
          id: 'mute-track', label: t(menuTrack?.muted ? 'soundStage.overview.unmute' : 'soundStage.overview.mute'),
          onSelect: () => toggleTrack(menuClip.track, 'muted', !menuTrack?.muted),
        },
        {
          id: 'lock-track', label: t(menuTrack?.locked ? 'soundStage.overview.unlock' : 'soundStage.overview.lock'),
          onSelect: () => toggleTrack(menuClip.track, 'locked', !menuTrack?.locked),
        },
        { id: 'reveal-clip', label: t('soundStage.inspector.reveal'), onSelect: () => onReveal(menuClip.path) },
        { id: 'clear-clip', label: t('soundStage.inspector.clear'), onSelect: clearSelection },
      );
    } else {
      menuItems.push(
        {
          id: 'picture-play', label: t(picturePlaying ? 'soundStage.context.pausePicture' : 'soundStage.context.playPicture'),
          shortcut: keyHint('play-pause'), onSelect: () => pictureRef.current?.toggle(),
        },
        { id: 'picture-start', label: t('soundStage.picture.start'), shortcut: keyHint('start'), onSelect: () => seekFilm(0) },
        { id: 'picture-end', label: t('soundStage.picture.end'), shortcut: keyHint('end'), onSelect: () => seekFilm(totalMs) },
        { id: 'page-sep-1', separator: true },
        { id: 'undo', label: t('history.undo'), shortcut: keyHint('undo'), disabled: !onUndo, onSelect: () => onUndo?.() },
        { id: 'redo', label: t('history.redo'), shortcut: keyHint('redo'), disabled: !onRedo, onSelect: () => onRedo?.() },
        { id: 'page-sep-2', separator: true },
        { id: 'refresh', label: t('soundStage.library.refresh'), onSelect: () => void refreshAll() },
        { id: 'settings', label: t('settings.title'), disabled: !onSettings, onSelect: () => onSettings?.() },
        { id: 'clear-page', label: t('soundStage.inspector.clear'), disabled: !asset && !remote && !clipId, onSelect: clearSelection },
      );
    }
  }

  const keyNowRef = React.useRef<(event: KeyboardEvent) => void>(() => {});
  keyNowRef.current = (event) => {
    const el = event.target as HTMLElement | null;
    /* Esc lets the selection go; the picture and the strip keep their place */
    if (event.key === 'Escape' && !isTypingTarget(el) && !el?.closest?.('[role="dialog"], [role="menu"], [role="listbox"], [data-popover-panel]')) {
      if (asset || remote || clipId) {
        event.preventDefault();
        event.stopImmediatePropagation();
        clearSelection();
      }
      return;
    }
    const cmd = keyAction(event);
    if (!cmd) return;
    /* the workflow's own steps and the app's chat: theirs, not this step's */
    if (cmd.startsWith('stage-') || cmd === 'refer') return;
    if (event.defaultPrevented) return;
    if (isTypingTarget(el) || el?.closest?.('[role="dialog"]')) return;
    if (el?.closest?.('[role="menu"], [role="listbox"], [data-popover-panel]')) return;
    /* a seam, a ruler or a volume slider has its own arrows: the keys are its while it has focus */
    if (el?.closest?.('[role="separator"]')) return;
    if ((el?.closest?.('[role="slider"]') || el?.closest?.('input[type="range"]'))
      && /^(frame|jump|prev|next|start|end|nudge)/.test(cmd)) return;
    if (cmd === 'play-pause' && tabbed.current && el?.closest?.('button, a, [role="button"]')) return;
    const repeatable = cmd === 'audio-volume-up' || cmd === 'audio-volume-down'
      || cmd === 'nudge-back' || cmd === 'nudge-forward'
      || cmd === 'frame-back' || cmd === 'frame-forward'
      || cmd === 'jump-back' || cmd === 'jump-forward';
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.repeat && !repeatable) return;
    const takeClip = (): AudioClip | null => {
      if (!clip) { needClip(); return null; }
      return clip;
    };
    switch (cmd) {
      case 'play-pause':
        if (!tabbed.current) {
          const active = document.activeElement;
          if (active && active !== document.body && 'blur' in active) (active as HTMLElement).blur();
        }
        pictureRef.current?.toggle();
        return;
      case 'shuttle-stop':
        pictureRef.current?.stop();
        return;
      case 'shuttle-forward':
        if (!picturePlaying) pictureRef.current?.toggle();
        return;
      case 'shuttle-back':
        if (picturePlaying) pictureRef.current?.stop();
        seekFilm(posMs - 1000);
        return;
      case 'frame-back': case 'frame-forward':
        if (picturePlaying) pictureRef.current?.stop();
        seekFilm(posMs + (cmd === 'frame-back' ? -frameMs : frameMs));
        return;
      case 'jump-back': case 'jump-forward':
        if (picturePlaying) pictureRef.current?.stop();
        seekFilm(posMs + (cmd === 'jump-back' ? -10 : 10) * frameMs);
        return;
      case 'start':
        seekFilm(0);
        return;
      case 'end':
        seekFilm(totalMs);
        return;
      case 'prev-cut': case 'next-cut': {
        const at = cmd === 'prev-cut'
          ? [...cuts].reverse().find((ms) => ms < posMs - 1)
          : cuts.find((ms) => ms > posMs + 1);
        if (at != null) { if (picturePlaying) pictureRef.current?.stop(); seekFilm(at); }
        return;
      }
      case 'loop':
        pictureRef.current?.toggleLoop();
        return;
      case 'split': {
        const target = takeClip();
        if (target) splitClip(target);
        return;
      }
      case 'remove': {
        const target = takeClip();
        if (target) removeClip(target);
        return;
      }
      case 'nudge-back': case 'nudge-forward': {
        const target = takeClip();
        if (target) moveClip(target, Math.max(0, target.atMs + (cmd === 'nudge-back' ? -frameMs : frameMs)));
        return;
      }
      case 'undo':
        pictureRef.current?.stop();
        onUndo?.();
        return;
      case 'redo':
        pictureRef.current?.stop();
        onRedo?.();
        return;
      case 'audio-mute-track': {
        const target = takeClip();
        if (target) toggleTrack(target.track, 'muted', !selectedTrack?.muted);
        return;
      }
      case 'audio-volume-up': {
        const target = takeClip();
        if (target) volumeBy(target, 0.1);
        return;
      }
      case 'audio-volume-down': {
        const target = takeClip();
        if (target) volumeBy(target, -0.1);
        return;
      }
      case 'audio-normalize': {
        const target = takeClip();
        if (target) void normalizeClip(target);
        return;
      }
      case 'audio-fade-in': {
        const target = takeClip();
        if (target) fadeBy(target, 'in', 200);
        return;
      }
      case 'audio-fade-out': {
        const target = takeClip();
        if (target) fadeBy(target, 'out', 200);
        return;
      }
      default:
        /* a timeline or editor action that this step does not have: not the stale editor's either */
        return;
    }
  };
  /* a key pressed while the picture has focus comes back through the preview's own document */
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyNowRef.current(event);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  const tabbed = React.useRef(false);
  React.useEffect(() => {
    const byKey = (event: KeyboardEvent) => { if (event.key === 'Tab') tabbed.current = true; };
    const byPointer = () => { tabbed.current = false; };
    window.addEventListener('keydown', byKey, true);
    window.addEventListener('pointerdown', byPointer, true);
    return () => {
      window.removeEventListener('keydown', byKey, true);
      window.removeEventListener('pointerdown', byPointer, true);
    };
  }, []);

  const counts = audio?.summary;
  const summary = t('soundStage.summary')
    .replace('{tracks}', String(audio?.tracks.length ?? 0))
    .replace('{duration}', formatClipDuration(Math.max(audio?.durationMs ?? 0, durationMs)) || '0:00');

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[6px] bg-[var(--dock-shell)]" onContextMenu={openContextMenu}>
      <div className="flex shrink-0 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]">
        <div className={PANE_BAR}>
          <AudioLines size={14} aria-hidden className="shrink-0 text-[var(--text-dim)]" />
          <span className={PANE_TITLE}>{t('soundStage.title')}</span>
          <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--text-faint)]">{summary}</span>
          <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden pl-2">
            {(['voice', 'music', 'sfx', 'footage'] as const).map((item) => (
              <span key={item} title={t(`soundStage.role.${item}`)} className="inline-flex shrink-0 items-center gap-1 text-[9.5px] tabular-nums text-[var(--text-faint)]">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: AUDIO_ROLE_COLOR[item] }} />
                {counts?.[item]?.count ?? 0}
              </span>
            ))}
          </span>
          <button type="button" onClick={() => void refreshAll()} aria-label={t('soundStage.library.refresh')} title={t('soundStage.library.refresh')}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-faint)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
            <RefreshCw size={11} className={busy === 'refresh' || libraryLoading ? 'animate-spin' : ''} />
          </button>
          {onOpenSubtitles ? (
            <button type="button" onClick={onOpenSubtitles} className={SECONDARY} title="字幕与样式">
              <Captions size={11} aria-hidden />字幕{subtitleLines.length ? ` ${subtitleLines.length}` : ''}
            </button>
          ) : null}
          {onManageMedia ? (
            <button type="button" onClick={onManageMedia} className={SECONDARY}>
              <FolderOpen size={11} aria-hidden />{t('soundStage.header.media')}
            </button>
          ) : null}
          <button type="button" onClick={onNext}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-[var(--text)] ring-1 ring-inset ring-[var(--border-strong)] transition hover:bg-[var(--bg-hover)]">
            <Scissors size={11} aria-hidden />{t('workflow.edit')}<ChevronRight size={11} aria-hidden />
          </button>
        </div>
      </div>

      <div ref={bodyRef} className="flex min-h-0 min-w-0 flex-1 flex-col gap-[6px]">
        <div ref={rowRef} className="flex min-h-0 min-w-0 flex-1">
          <div className="min-h-0 shrink-0" style={{ width: libraryShownWidth }}>
            <SoundLibrary
              view={view} onView={setView}
              role={role} onRole={setRole}
              library={library} libraryLoading={libraryLoading} onRefresh={() => void loadLibrary()}
              selectedPath={asset?.path ?? null} onSelectAsset={selectAsset}
              uploadRole={uploadRole} onUploadRole={setUploadRole} uploading={busy === 'upload'} onUpload={(files) => void upload(files)}
              networkQuery={networkQuery} onNetworkQuery={setNetworkQuery}
              networkResults={networkResults} networkSources={networkSources} networkLoading={networkLoading}
              onNetworkSearch={() => void searchNetwork()}
              selectedRemoteId={remote ? `${remote.source}:${remote.id}` : null} onSelectRemote={selectRemote}
              onImportRemote={(result) => void importRemote(result)} importingId={importingRemote}
              catalog={catalog} onSettings={() => onSettings?.()}
              providers={legacyProviders.state}
              subtitleLines={subtitleLines}
              form={form} onForm={(patch) => setForm((now) => ({ ...now, ...patch }))}
              voices={voices} voicesLoading={voicesLoading} voicesNote={voicesNote} onLoadVoices={() => void loadVoices()}
              onGenerate={() => void generate()} generating={busy === 'generate'}
            />
          </div>
          <PaneDivider width={libraryShownWidth} onResize={commitLibraryWidth} containerRef={rowRef}
            label={t('soundStage.header.resizeLibrary')} min={220} minRest={520} />
          <div ref={centerRef} className="flex min-h-0 min-w-0 flex-1 flex-col">
            {showPicture ? (
              <div className="min-h-0 flex-1">
                <SoundPicture
                  ref={pictureRef}
                  folder={folder}
                  stage={stage}
                  film={film}
                  fps={fps}
                  posMs={posMs}
                  totalMs={totalMs}
                  onPos={setPos}
                  onPlayingChange={(next) => { setPicturePlaying(next); if (next) audition.pause(); }}
                  onKey={(event) => keyNowRef.current(event)}
                  auditionShown={showAudition}
                  onToggleAudition={() => setShowAudition((shown) => !shown)}
                  onClearSelection={clearSelection}
                />
              </div>
            ) : null}
            {showPicture && showAudition ? (
              <DockPaneDivider height={auditionHeight ?? 210} onResize={commitAuditionHeight} containerRef={centerRef}
                label={t('soundStage.header.resizePreviewSplit')} min={140} minRest={160} />
            ) : null}
            {showAudition ? (
              <div className={showPicture ? 'shrink-0' : 'min-h-0 flex-1'} style={showPicture ? { height: auditionHeight ?? 210 } : undefined}>
                <SoundAudition
                  asset={asset} remote={remote} clip={clip}
                  peaks={peaks} waveDurationMs={waveDurationMs}
                  fileDurationMs={fileDurations[clip?.path ?? asset?.path ?? ''] || null}
                  assetRange={asset && draft ? { fromMs: draft.startMs, toMs: draft.endMs } : null}
                  peaksLoading={peaksLoading}
                  audition={audition}
                  onImportRemote={(result) => void importRemote(result)}
                  importing={importingRemote !== null}
                  onBeforePlay={() => pictureRef.current?.stop()}
                  pictureShown={showPicture}
                  onTogglePicture={() => setShowPicture((shown) => !shown)}
                />
              </div>
            ) : null}
          </div>
          <PaneDivider width={inspectorShownWidth} onResize={commitInspectorWidth} containerRef={rowRef} side="end"
            label={t('soundStage.header.resizeInspector')} min={240} minRest={460} />
          <div className="min-h-0 shrink-0" style={{ width: inspectorShownWidth }}>
            <SoundInspector
              projectId={projectId}
              asset={asset} clip={clip} remote={remote} audio={audio}
              fileDurationMs={fileDurations[clip?.path ?? asset?.path ?? ''] || null}
              posMs={posMs} onPos={seekFilm} draft={draft ?? { startMs: 0, endMs: null, volume: 1, fadeInMs: 0, fadeOutMs: 0, speed: 1, track: null }}
              onDraft={patchDraft} onPlace={() => void place()} placing={busy === 'place'}
              onApplyClip={applyClip} onRemoveClip={removeClip} onToggleTrack={toggleTrack}
              onReveal={onReveal} onDeleteAsset={removeAsset}
              onImportRemote={(result) => void importRemote(result)} importingRemote={importingRemote !== null}
              onClear={clearSelection}
            />
          </div>
          {chatOpen ? (
            <>
              <PaneDivider width={chatShownWidth} onResize={commitChatWidth} containerRef={rowRef} side="end"
                label={t('soundStage.header.resizeChat')} min={280} minRest={420} />
              <div className="min-h-0 shrink-0" style={{ width: chatShownWidth }}>
                <EditChatPanel
                  projectId={projectId}
                  scope="audio"
                  title="AI 音效助手"
                  welcome="我可以帮你检查对白、音乐与音效的平衡、响度和剪辑点，也能给出可执行的音频修改建议。"
                  placeholder="例如：对白太轻、音乐压住了人声，帮我看看怎么调。"
                  configured={audioAgentReady}
                  onOpenSettings={onAgentSettings}
                  onClose={() => onCloseChat?.()}
                />
              </div>
            </>
          ) : null}
        </div>

        <DockPaneDivider height={tracksHeight ?? 190} onResize={commitTracksHeight} containerRef={bodyRef}
          label={t('soundStage.header.resizeTracks')} min={112} minRest={200} />
        <div className="shrink-0 overflow-hidden" style={{ height: tracksHeight ?? 190 }}>
          <SoundTracks
            audio={audio} durationMs={durationMs} posMs={posMs} selectedClipId={clipId}
            onPos={seekFilm} onSelectClip={selectClip} onToggleTrack={toggleTrack}
            onMoveClip={moveClip} onTrimClip={trimClip} onDropSound={dropSound}
            waveUrl={waveUrl} fileDurationMs={(path) => fileDurations[path] || null}
            busy={busy === 'ops' || busy === 'place'}
            playing={picturePlaying}
            onTogglePlay={() => pictureRef.current?.toggle()}
            onStop={() => pictureRef.current?.stop()}
            clip={clip}
            onMuteTrack={() => { if (clip) toggleTrack(clip.track, 'muted', !audio?.tracks.find((track) => track.index === clip.track)?.muted); }}
            onVolume={(delta) => { if (clip) volumeBy(clip, delta); }}
            onFade={(edge) => { if (clip) fadeBy(clip, edge, 200); }}
            onNormalize={() => { if (clip) void normalizeClip(clip); }}
            onSplit={() => { if (clip) splitClip(clip); }}
            onRemove={() => { if (clip) removeClip(clip); }}
            onClearSelection={clearSelection}
          />
        </div>
      </div>

      {contextMenu ? <ContextMenu x={contextMenu.x} y={contextMenu.y} items={menuItems} onClose={() => setContextMenu(null)} /> : null}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === 'asset' ? t('soundStage.remove.assetTitle') : t('soundStage.remove.clipTitle')}
        description={confirm?.kind === 'asset'
          ? t('soundStage.remove.assetDesc').replace('{title}', confirm.asset.title || confirm.asset.name)
          : t('soundStage.remove.clipDesc')}
        confirmLabel={t('soundStage.remove.confirm')}
        cancelLabel={t('soundStage.remove.cancel')}
        danger
        onCancel={() => setConfirm(null)}
        onConfirm={() => void confirmRemove()}
      />
    </div>
  );
}
