/**
 * The sound stage's middle pane: the sound picked, heard.
 *
 * A project file is shown with its whole waveform and the part its clip plays left bright; a network result is heard
 * from its preview address (there is no waveform until it is imported, and saying so is better than drawing a fake
 * one). The transport is the pane's own rather than the browser's: a sound is judged by where it starts and stops, and
 * a missing loop or a missing place readout breaks that.
 */
import * as React from 'react';
import {
  AlertTriangle, Eye, EyeOff, ExternalLink, Loader2, Pause, Play, Repeat2, Sparkles, Square, Volume1, Volume2, VolumeX,
} from 'lucide-react';
import type { AudioAsset, AudioClip, AudioSearchResult } from '@/api';
import { useT } from '@/i18n';
import { formatFileSize } from '@/lib/workspace-resources';
import { formatTimecode } from '@/lib/timecode';
import { formatSoundLength, clamp, audioSourceLabel } from '@/lib/sound';
import type { Audition } from '@/lib/use-audition';
import { Tooltip } from '../../Tooltip';
import { SoundRoleChip, SoundRoleMark } from './SoundRoleMark';
import { SoundWave } from './SoundWave';




export function SoundAudition({
  asset, remote, clip, peaks, waveDurationMs, fileDurationMs, assetRange, peaksLoading,
  audition, onImportRemote, importing, onBeforePlay, pictureShown, onTogglePicture,
}: {
  /** The project's file selected in the library. */
  asset: AudioAsset | null;
  /** A search result selected in the network list. */
  remote: AudioSearchResult | null;
  /** A clip selected on the overview (it wins over the file it came from). */
  clip: AudioClip | null;
  peaks: readonly number[] | null;
  waveDurationMs: number | null;
  /** The file's whole length, when its waveform is not in yet. */
  fileDurationMs: number | null;
  /** The part of a library file the placement form would put on the timeline (the whole file when not set). */
  assetRange: { fromMs: number; toMs: number | null } | null;
  peaksLoading: boolean;
  audition: Audition;
  onImportRemote: (result: AudioSearchResult) => void;
  importing: boolean;
  /** The picture steps aside when this sound is heard. */
  onBeforePlay?: () => void;
  /** The picture above is in sight: this pane's toggle hides it for now. */
  pictureShown: boolean;
  onTogglePicture: () => void;
}) {
  const t = useT();
  const sound = clip ?? asset;
  const sourceUrl = sound?.previewUrl ?? remote?.previewUrl ?? null;
  /* a video's own sound is heard as its sound alone: the film origin makes a small copy of it on request, where the
     video itself may not play in an <audio> element in every browser */
  const url = sourceUrl && clip && (clip.role === 'footage' || /\.(mp4|m4v|mov|mkv|webm|avi)$/i.test(clip.path))
    ? `${sourceUrl}${sourceUrl.includes('?') ? '&' : '?'}film-sound`
    : sourceUrl;
  const remoteOnly = !sound && Boolean(remote);
  const role = clip?.role ?? asset?.role ?? remote?.role ?? 'sfx';
  const title = sound?.title ?? remote?.title ?? '';
  const durationMs = sound
    ? (waveDurationMs ?? fileDurationMs ?? (peaks?.length ? Math.round((peaks.length / 40) * 1000) : asset?.durationMs ?? clip?.endMs ?? 0))
    : (remote?.durationMs ?? (audition.url === url ? audition.durationMs : 0));
  const inMs = clip ? clip.startMs : assetRange?.fromMs ?? 0;
  const outMs = clip ? clip.endMs : assetRange?.toMs ?? (durationMs || null);
  const range = { fromMs: inMs, toMs: outMs };
  const shownPos = audition.url === url && url ? audition.posMs : inMs;

  const playable = Boolean(url) && !sound?.unreadable && !sound?.missing;
  const play = () => { if (url && playable) { onBeforePlay?.(); audition.toggle(url, range); } };

  /* the sound is loaded (not played) as it is picked: its length is read, and a click on its waveform can move the
     head before the first play */
  const loadKey = url && playable ? `${url}|${inMs}|${outMs ?? ''}` : '';
  React.useEffect(() => {
    if (!url || !playable) return;
    audition.load(url, { fromMs: inMs, toMs: outMs });
    // the key is what changed: the same sound stays where it was seeked to
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]" aria-label={t('soundStage.audition.title')}>
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-[var(--border-soft)] px-3">
        <Volume2 size={13} aria-hidden className="shrink-0 text-[var(--text-faint)]" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-[var(--text-muted)]">{t('soundStage.audition.title')}</span>
        {sound || remote ? <SoundRoleChip role={role} label={t(`soundStage.role.${role}`)} /> : null}
        {sound?.source && sound.source !== 'local' ? (
          <span className="shrink-0 rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[9px] leading-4 text-[var(--text-faint)]">
            {audioSourceLabel(sound.source, t)}
          </span>
        ) : null}
        <Tooltip label={t(pictureShown ? 'soundStage.audition.hidePicture' : 'soundStage.audition.showPicture')} side="top">
          <button type="button" aria-label={t(pictureShown ? 'soundStage.audition.hidePicture' : 'soundStage.audition.showPicture')}
            aria-pressed={!pictureShown} onClick={onTogglePicture}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-faint)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
            {pictureShown ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        </Tooltip>
      </div>

      {!sound && !remote ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <span aria-hidden className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text-faint)]">
            <Volume2 size={20} />
          </span>
          <p className="text-[13px] font-medium text-[var(--text-muted)]">{t('soundStage.audition.empty')}</p>
          <p className="max-w-[320px] text-[11px] leading-relaxed text-[var(--text-faint)]">{t('soundStage.audition.emptyHint')}</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-4 py-3">
          <div className="flex min-w-0 items-start gap-2">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-2)]">
              <SoundRoleMark role={role} size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-medium text-[var(--text)]">{title}</p>
              <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-[var(--text-faint)]">
                <span className="tabular-nums">{formatSoundLength(durationMs)}</span>
                {clip ? <span>{t('soundStage.audition.clipRange').replace('{from}', formatTimecode(clip.startMs)).replace('{to}', formatTimecode(clip.endMs))}</span> : null}
                {clip && clip.speed !== 1 ? <span>×{clip.speed}</span> : null}
                {sound ? <span className="truncate">{sound.path}</span> : remote ? <span>{remote.source === 'jamendo' ? 'Jamendo' : 'Freesound'}</span> : null}
              </p>
            </div>
          </div>

          {sound?.unreadable ? (
            <Notice tone="warn" icon={<AlertTriangle size={12} />}>{sound.unreadable}</Notice>
          ) : sound?.missing ? (
            <Notice tone="warn" icon={<AlertTriangle size={12} />}>{t('soundStage.audition.missing')}</Notice>
          ) : null}

          <div className="relative">
            {remoteOnly ? (
              <div className="flex h-[122px] items-center justify-center rounded-md border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-4 text-center text-[10px] leading-relaxed text-[var(--text-faint)]">
                {t('soundStage.audition.remoteHint')}
              </div>
            ) : (
              <SoundWave
                peaks={peaks}
                durationMs={durationMs}
                inMs={inMs}
                outMs={outMs ?? undefined}
                posMs={shownPos}
                height={120}
                color="var(--tl-wave)"
                onSeek={playable && durationMs > 0 ? (ms) => audition.seek(ms, url!, range) : undefined}
              />
            )}
            {peaksLoading && !remoteOnly ? (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1.5 rounded-md bg-[var(--dock-pane)]/55 text-[10.5px] text-[var(--text-faint)]">
                <Loader2 size={12} className="animate-spin" />{t('soundStage.audition.loadingWave')}
              </span>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={play} disabled={!playable}
              aria-label={audition.playing && audition.url === url ? t('soundStage.audition.pause') : t('soundStage.audition.play')}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--text)] text-[var(--panel)] transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-30">
              {audition.playing && audition.url === url ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}
            </button>
            <button type="button" onClick={audition.stop} disabled={!playable}
              aria-label={t('soundStage.audition.stop')}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-30">
              <Square size={11} />
            </button>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-[var(--text-muted)]">
              {formatTimecode(shownPos)} <span className="text-[var(--text-faint)]">/ {formatTimecode(durationMs)}</span>
            </span>
            <span className="min-w-0 flex-1" />
            <button type="button" aria-pressed={audition.loop} onClick={() => audition.setLoop(!audition.loop)}
              title={t('soundStage.audition.loop')} aria-label={t('soundStage.audition.loop')}
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition ${audition.loop ? 'bg-[var(--surface-3)] text-[var(--text)]' : 'text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]'}`}>
              <Repeat2 size={12} />
            </button>
            <span className="flex w-[104px] shrink-0 items-center gap-1">
              <button type="button" onClick={() => audition.setVolume(audition.volume > 0 ? 0 : 0.9)}
                aria-label={t('soundStage.audition.mute')}
                className="flex h-6 w-5 shrink-0 items-center justify-center text-[var(--text-faint)] hover:text-[var(--text)]">
                {audition.volume <= 0 ? <VolumeX size={12} /> : audition.volume < 0.5 ? <Volume1 size={12} /> : <Volume2 size={12} />}
              </button>
              <input type="range" min={0} max={1} step={0.01} value={audition.volume}
                onChange={(event) => audition.setVolume(Number(event.target.value))}
                aria-label={t('soundStage.audition.volume')} className="h-1 min-w-0 flex-1 accent-[var(--accent)]" />
            </span>
            {audition.failed && audition.url === url ? (
              <span role="status" className="w-full text-[10.5px] text-[var(--err)]">{t('soundStage.audition.failed')}</span>
            ) : null}
          </div>

          {remoteOnly && remote ? (
            <div className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[10.5px]">
                <dt className="text-[var(--text-faint)]">{t('soundStage.info.source')}</dt>
                <dd className="truncate text-[var(--text-muted)]">{remote.source === 'jamendo' ? 'Jamendo' : 'Freesound'}</dd>
                {remote.credit ? <><dt className="text-[var(--text-faint)]">{t('soundStage.info.credit')}</dt><dd className="min-w-0 break-words text-[var(--text-muted)]">{remote.credit}</dd></> : null}
                {remote.license ? <><dt className="text-[var(--text-faint)]">{t('soundStage.info.license')}</dt><dd className="min-w-0 break-words text-[var(--text-muted)]">{remote.license}</dd></> : null}
                {remote.tags?.length ? <><dt className="text-[var(--text-faint)]">{t('soundStage.info.tags')}</dt><dd className="min-w-0 break-words text-[var(--text-muted)]">{remote.tags.join(' · ')}</dd></> : null}
              </dl>
              <div className="flex items-center gap-1.5">
                <button type="button" onClick={() => onImportRemote(remote)} disabled={importing || !remote.downloadUrl}
                  className="flex h-7 items-center gap-1.5 rounded-md bg-[var(--text)] px-2.5 text-[11px] font-medium text-[var(--panel)] transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-40">
                  {importing ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
                  {t('soundStage.network.import')}
                </button>
                {remote.page ? (
                  <a href={remote.page} target="_blank" rel="noreferrer"
                    className="flex h-7 items-center gap-1 rounded-md px-2 text-[10.5px] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
                    <ExternalLink size={10} />{t('soundStage.network.page')}
                  </a>
                ) : null}
              </div>
            </div>
          ) : sound ? (
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3 text-[10.5px]">
              <Fact label={t('soundStage.info.source')} value={audioSourceLabel(sound.source, t)} />
              {sound.size > 0 ? <Fact label={t('soundStage.info.size')} value={formatFileSize(sound.size)} /> : null}
              <Fact label={t('soundStage.info.role')} value={t(`soundStage.role.${role}`)} />
              <Fact label={t('soundStage.info.length')} value={formatSoundLength(durationMs)} />
              {sound.credit ? <Fact label={t('soundStage.info.credit')} value={sound.credit} wide /> : null}
              {sound.license ? <Fact label={t('soundStage.info.license')} value={sound.license} wide /> : null}
              {sound.page ? (
                <a href={sound.page} target="_blank" rel="noreferrer"
                  className="col-span-2 flex items-center gap-1 text-[10.5px] text-[var(--text-muted)] underline-offset-2 hover:text-[var(--text)] hover:underline">
                  <ExternalLink size={10} />{t('soundStage.info.page')}
                </a>
              ) : null}
            </div>
          ) : null}

          {clip ? (
            <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-[10px] leading-relaxed text-[var(--text-faint)]">
              {t('soundStage.audition.clipNote')
                .replace('{volume}', `${Math.round(clamp(clip.volume, 0, 2) * 100)}%`)
                .replace('{track}', String(clip.track + 1))}
            </p>
          ) : assetRange && assetRange.toMs != null ? (
            <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-[10px] leading-relaxed text-[var(--text-faint)]">
              {t('soundStage.audition.draftRange')
                .replace('{from}', formatTimecode(assetRange.fromMs))
                .replace('{to}', formatTimecode(assetRange.toMs))}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function Fact({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`min-w-0 ${wide ? 'col-span-2' : ''}`}>
      <span className="block text-[9.5px] text-[var(--text-faint)]">{label}</span>
      <span className="block break-words text-[10.5px] text-[var(--text-muted)]">{value}</span>
    </div>
  );
}

function Notice({ children, tone, icon }: { children: React.ReactNode; tone: 'warn' | 'error'; icon: React.ReactNode }) {
  return (
    <p role="status" className={`flex items-start gap-1.5 rounded-lg border px-2.5 py-2 text-[10.5px] leading-relaxed ${
      tone === 'error' ? 'border-[var(--err)]/40 text-[var(--err)]' : 'border-[var(--warn)]/40 text-[var(--text-muted)]'
    }`}>
      <span aria-hidden className="mt-px shrink-0">{icon}</span>
      <span className="min-w-0">{children}</span>
    </p>
  );
}
