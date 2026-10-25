/**
 * The sound stage's right pane: the sound picked, placed or changed.
 *
 * A library file gets a placement draft (where, which part, how loud, how it comes in and goes out) that writes
 * nothing until "Place on the timeline"; a clip already on the film gets the same fields as a draft that one "Apply"
 * writes in one native batch. Two different promises: a file may be placed many times, a clip is one existing thing.
 */
import * as React from 'react';
import {
  AlertTriangle, ExternalLink, Gauge, Loader2, Lock, LockOpen, RefreshCw, Trash2, Volume2, VolumeX, X,
} from 'lucide-react';
import { api } from '@/api';
import type { AudioAsset, AudioClip, AudioSearchResult, AudioState } from '@/api';
import { useT } from '@/i18n';
import { LOUDNESS_TARGETS, normalizeVolume } from '@/lib/loudness';
import { formatTimecode } from '@/lib/timecode';
import { clamp, formatSoundLength, formatVolume, audioSourceLabel, type ClipPatch } from '@/lib/sound';
import { formatFileSize } from '@/lib/workspace-resources';
import { MenuSelect } from '../../MenuSelect';
import { NumberInput } from '../../NumberInput';
import { SoundRoleChip } from './SoundRoleMark';

/** What "Place on the timeline" will write, in ms and in the API's seconds. */
export interface PlaceDraft {
  startMs: number;
  /** null: the file's own end (the API reads it). */
  endMs: number | null;
  volume: number;
  fadeInMs: number;
  fadeOutMs: number;
  speed: number;
  /** null: let the film choose a sound track. */
  track: number | null;
}

export const emptyDraft = (asset: AudioAsset | AudioClip): PlaceDraft => ({
  startMs: 0,
  endMs: asset.durationMs && asset.durationMs > 0 ? asset.durationMs : null,
  volume: 1,
  fadeInMs: 0,
  fadeOutMs: 0,
  speed: 1,
  track: null,
});


export function SoundInspector({
  projectId, asset, clip, remote, audio, fileDurationMs, posMs, onPos, draft, onDraft, onPlace, placing,
  onApplyClip, onRemoveClip, onToggleTrack, onReveal, onDeleteAsset, onImportRemote, importingRemote, onClear,
}: {
  projectId: string;
  asset: AudioAsset | null;
  clip: AudioClip | null;
  remote: AudioSearchResult | null;
  audio: AudioState | null;
  /** The selected file's whole length (the inspector caps trims with it). */
  fileDurationMs: number | null;
  posMs: number;
  onPos: (ms: number) => void;
  draft: PlaceDraft;
  onDraft: (patch: Partial<PlaceDraft>) => void;
  onPlace: () => void;
  placing: boolean;
  onApplyClip: (clip: AudioClip, patch: ClipPatch) => void;
  onRemoveClip: (clip: AudioClip) => void;
  onToggleTrack: (track: number, field: 'muted' | 'locked', value: boolean) => void;
  onReveal: (path: string) => void;
  onDeleteAsset: (asset: AudioAsset) => void;
  onImportRemote: (result: AudioSearchResult) => void;
  importingRemote: boolean;
  /** Let the selection go (the background, Esc, or the pane's close button). */
  onClear?: () => void;
}) {
  const t = useT();
  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]" aria-label={t('soundStage.inspector.title')}>
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-[var(--border-soft)] px-3">
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-[var(--text-muted)]">
          {clip ? t('soundStage.inspector.clipTitle') : asset ? t('soundStage.inspector.assetTitle') : remote ? t('soundStage.inspector.remoteTitle') : t('soundStage.inspector.title')}
        </span>
        {clip || asset || remote ? <SoundRoleChip role={clip?.role ?? asset?.role ?? remote?.role ?? 'sfx'} label={t(`soundStage.role.${clip?.role ?? asset?.role ?? remote?.role ?? 'sfx'}`)} /> : null}
        {clip || asset || remote ? (
          <button type="button" aria-label={t('soundStage.inspector.clear')} onClick={onClear}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-faint)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
            <X size={12} />
          </button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4 pt-3">
        {clip ? (
          <ClipPanel projectId={projectId} clip={clip} audio={audio} fileDurationMs={fileDurationMs} onApply={onApplyClip} onRemove={onRemoveClip} onToggleTrack={onToggleTrack} onReveal={onReveal} />
        ) : asset ? (
          <AssetPanel projectId={projectId} asset={asset} audio={audio} fileDurationMs={fileDurationMs} posMs={posMs} onPos={onPos} draft={draft} onDraft={onDraft}
            onPlace={onPlace} placing={placing} onReveal={onReveal} onDelete={onDeleteAsset} />
        ) : remote ? (
          <RemotePanel remote={remote} onImport={onImportRemote} importing={importingRemote} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <span aria-hidden className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--surface-2)] text-[var(--text-faint)]">
              <Volume2 size={17} />
            </span>
            <p className="text-[12.5px] font-medium text-[var(--text-muted)]">{t('soundStage.inspector.none')}</p>
            <p className="max-w-[240px] text-[10.5px] leading-relaxed text-[var(--text-faint)]">{t('soundStage.inspector.noneHint')}</p>
          </div>
        )}
      </div>
    </aside>
  );
}

function AssetPanel({
  projectId, asset, audio, fileDurationMs, posMs, onPos, draft, onDraft, onPlace, placing, onReveal, onDelete,
}: {
  projectId: string;
  asset: AudioAsset;
  audio: AudioState | null;
  fileDurationMs: number | null;
  posMs: number;
  onPos: (ms: number) => void;
  draft: PlaceDraft;
  onDraft: (patch: Partial<PlaceDraft>) => void;
  onPlace: () => void;
  placing: boolean;
  onReveal: (path: string) => void;
  onDelete: (asset: AudioAsset) => void;
}) {
  const t = useT();
  const [probed, setProbed] = React.useState<{ durationMs: number | null; audio: boolean | null }>({ durationMs: asset.durationMs, audio: null });
  React.useEffect(() => {
    setProbed({ durationMs: asset.durationMs, audio: null });
    if (asset.durationMs != null) return;
    let alive = true;
    void api.audioProbe(projectId, asset.path).then((probe) => {
      if (!alive) return;
      const durationMs = probe.duration && probe.duration > 0 ? Math.round(probe.duration * 1000) : null;
      setProbed({ durationMs, audio: probe.audio ?? null });
      if (durationMs) onDraft({ endMs: durationMs });
    }, () => { /* unreadable is said by the file's own row */ });
    return () => { alive = false; };
  }, [projectId, asset.path, asset.durationMs, onDraft]);
  const knownDuration = fileDurationMs ?? probed.durationMs;
  const endMs = draft.endMs;
  const pastEnd = endMs != null && knownDuration != null && endMs > knownDuration;
  const invalid = (endMs != null && endMs <= draft.startMs) || pastEnd;
  const tracks = audio?.tracks ?? [];
  const chosenTrack = draft.track == null ? null : tracks.find((track) => track.index === draft.track);
  const lockedTrack = Boolean(chosenTrack?.locked);
  const blocked = Boolean(asset.unreadable || asset.missing || probed.audio === false) || invalid || lockedTrack;
  return (
    <div className="flex flex-col gap-3">
      <div className="min-w-0">
        <p className="break-words text-[13px] font-medium text-[var(--text)]">{asset.title || asset.name}</p>
        <p className="mt-0.5 break-all text-[10px] leading-relaxed text-[var(--text-faint)]">{asset.path}</p>
      </div>
      {asset.unreadable ? <Warn>{asset.unreadable}</Warn> : asset.missing ? <Warn>{t('soundStage.inspector.missingFile')}</Warn> : probed.audio === false ? <Warn>{t('soundStage.inspector.noSound')}</Warn> : null}

      <Section title={t('soundStage.inspector.placeFields')} hint={formatTimecode(posMs)}>
        <NumberRow label={t('soundStage.inspector.at')} value={posMs / 1000} min={0} step={0.01} unit="s"
          onCommit={(value) => onPos(Math.round((value ?? 0) * 1000))} />
        <p className="-mt-1 pl-[66px] font-mono text-[9.5px] tabular-nums text-[var(--text-faint)]">{formatTimecode(posMs)}</p>
        <div className="grid grid-cols-2 gap-2">
          <NumberRow label={t('soundStage.inspector.start')} value={draft.startMs / 1000} min={0} step={0.01} unit="s"
            onCommit={(value) => onDraft({ startMs: Math.max(0, Math.round((value ?? 0) * 1000)) })} />
          <NumberRow label={t('soundStage.inspector.end')} value={endMs == null ? null : endMs / 1000} min={0}
            max={knownDuration == null ? undefined : knownDuration / 1000} step={0.01} unit="s" allowEmpty
            onCommit={(value) => onDraft({ endMs: value == null ? null : Math.max(0, Math.round(value * 1000)) })} />
        </div>
        <p className="pl-[66px] text-[9.5px] text-[var(--text-faint)]">
          {t('soundStage.inspector.length').replace('{length}', formatSoundLength(endMs == null ? knownDuration : endMs - draft.startMs))}
        </p>
        {invalid ? <Warn>{t(pastEnd ? 'soundStage.inspector.endPastFile' : 'soundStage.inspector.endBeforeStart').replace('{length}', formatSoundLength(knownDuration))}</Warn> : null}
        {lockedTrack ? <Warn>{t('soundStage.inspector.trackLocked')}</Warn> : null}

        <VolumeRow volume={draft.volume} onVolume={(volume) => onDraft({ volume })} />
        <div className="grid grid-cols-2 gap-2">
          <NumberRow label={t('soundStage.inspector.fadeIn')} value={draft.fadeInMs / 1000} min={0} step={0.05} unit="s"
            onCommit={(value) => onDraft({ fadeInMs: Math.max(0, Math.round((value ?? 0) * 1000)) })} />
          <NumberRow label={t('soundStage.inspector.fadeOut')} value={draft.fadeOutMs / 1000} min={0} step={0.05} unit="s"
            onCommit={(value) => onDraft({ fadeOutMs: Math.max(0, Math.round((value ?? 0) * 1000)) })} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NumberRow label={t('soundStage.inspector.speed')} value={draft.speed} min={0.25} max={4} step={0.05} unit="×"
            onCommit={(value) => onDraft({ speed: clamp(value ?? 1, 0.25, 4) })} />
          <div className="flex items-center gap-2">
            <span className="w-[52px] shrink-0 text-[10.5px] text-[var(--text-faint)]">{t('soundStage.inspector.track')}</span>
            <MenuSelect size="sm" label={t('soundStage.inspector.track')} value={draft.track == null ? 'auto' : String(draft.track)}
              groups={[{ choices: [
                { value: 'auto', label: t('soundStage.inspector.trackAuto') },
                ...tracks.map((track) => ({ value: String(track.index), label: `${track.name} · ${t(`soundStage.role.${track.role}`)}${track.locked ? ` · ${t('soundStage.inspector.lockedTag')}` : ''}` })),
              ] }]}
              onPick={(value) => onDraft({ track: value === 'auto' ? null : Number(value) })} className="min-w-0 flex-1" />
          </div>
        </div>

        <button type="button" onClick={onPlace} disabled={placing || blocked}
          className="mt-1 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--text)] px-3 text-[12px] font-medium text-[var(--panel)] transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-40">
          {placing ? <Loader2 size={13} className="animate-spin" /> : <Volume2 size={13} />}
          {t('soundStage.inspector.placeButton').replace('{at}', formatTimecode(posMs))}
        </button>
        <p className="text-center text-[9.5px] leading-relaxed text-[var(--text-faint)]">{t('soundStage.inspector.placeHint')}</p>
      </Section>

      <Section title={t('soundStage.inspector.facts')}>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[10.5px]">
          <dt className="text-[var(--text-faint)]">{t('soundStage.info.role')}</dt>
          <dd className="text-[var(--text-muted)]">{t(`soundStage.role.${asset.role}`)}</dd>
          <dt className="text-[var(--text-faint)]">{t('soundStage.info.length')}</dt>
          <dd className="tabular-nums text-[var(--text-muted)]">{formatSoundLength(probed.durationMs ?? asset.durationMs)}</dd>
          <dt className="text-[var(--text-faint)]">{t('soundStage.info.source')}</dt>
          <dd className="text-[var(--text-muted)]">{audioSourceLabel(asset.source, t)}</dd>
          <dt className="text-[var(--text-faint)]">{t('soundStage.info.size')}</dt>
          <dd className="tabular-nums text-[var(--text-muted)]">{formatFileSize(asset.size)}</dd>
          {asset.credit ? <><dt className="text-[var(--text-faint)]">{t('soundStage.info.credit')}</dt><dd className="break-words text-[var(--text-muted)]">{asset.credit}</dd></> : null}
          {asset.license ? <><dt className="text-[var(--text-faint)]">{t('soundStage.info.license')}</dt><dd className="break-words text-[var(--text-muted)]">{asset.license}</dd></> : null}
          {asset.page ? (
            <>
              <dt className="text-[var(--text-faint)]">{t('soundStage.info.page')}</dt>
              <dd><a href={asset.page} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all text-[var(--text-muted)] underline-offset-2 hover:text-[var(--text)] hover:underline"><ExternalLink size={10} />{asset.page}</a></dd>
            </>
          ) : null}
        </dl>
      </Section>

      <div className="flex flex-wrap gap-1.5 border-t border-[var(--border-soft)] pt-3">
        <SmallButton onClick={() => onReveal(asset.path)}>{t('soundStage.inspector.reveal')}</SmallButton>
        <SmallButton danger onClick={() => onDelete(asset)}><Trash2 size={11} />{t('soundStage.inspector.delete')}</SmallButton>
      </div>
    </div>
  );
}

function RemotePanel({ remote, onImport, importing }: { remote: AudioSearchResult; onImport: (result: AudioSearchResult) => void; importing: boolean }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3">
      <div className="min-w-0">
        <p className="break-words text-[13px] font-medium text-[var(--text)]">{remote.title}</p>
        <p className="mt-0.5 text-[10px] text-[var(--text-faint)]">{remote.source === 'jamendo' ? 'Jamendo' : 'Freesound'} · {formatSoundLength(remote.durationMs)}</p>
      </div>
      <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 text-[10.5px] leading-relaxed text-[var(--text-faint)]">
        {t('soundStage.inspector.remoteHint')}
      </p>
      <button type="button" onClick={() => onImport(remote)} disabled={importing || !remote.downloadUrl}
        className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--text)] px-3 text-[12px] font-medium text-[var(--panel)] transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-40">
        {importing ? <Loader2 size={13} className="animate-spin" /> : <Volume2 size={13} />}
        {t('soundStage.network.import')}
      </button>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 text-[10.5px]">
        {remote.credit ? <><dt className="text-[var(--text-faint)]">{t('soundStage.info.credit')}</dt><dd className="break-words text-[var(--text-muted)]">{remote.credit}</dd></> : null}
        {remote.license ? <><dt className="text-[var(--text-faint)]">{t('soundStage.info.license')}</dt><dd className="break-words text-[var(--text-muted)]">{remote.license}</dd></> : null}
        {remote.page ? (
          <>
            <dt className="text-[var(--text-faint)]">{t('soundStage.info.page')}</dt>
            <dd><a href={remote.page} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all text-[var(--text-muted)] underline-offset-2 hover:text-[var(--text)] hover:underline"><ExternalLink size={10} />{remote.page}</a></dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

/** A clip that is on the film: the same fields, one batch, and the track it lives on. */
function ClipPanel({ projectId, clip, audio, fileDurationMs, onApply, onRemove, onToggleTrack, onReveal }: {
  projectId: string;
  clip: AudioClip;
  audio: AudioState | null;
  fileDurationMs: number | null;
  onApply: (clip: AudioClip, patch: ClipPatch) => void;
  onRemove: (clip: AudioClip) => void;
  onToggleTrack: (track: number, field: 'muted' | 'locked', value: boolean) => void;
  onReveal: (path: string) => void;
}) {
  const t = useT();
  interface Draft { atMs: number; startMs: number; endMs: number; volume: number; fadeInMs: number; fadeOutMs: number; speed: number; track: number }
  const of = (value: AudioClip): Draft => ({
    atMs: value.atMs,
    startMs: value.startMs,
    endMs: value.endMs,
    volume: value.volume,
    fadeInMs: value.fadeInMs,
    fadeOutMs: value.fadeOutMs,
    speed: value.speed,
    track: value.track,
  });
  const [draft, setDraft] = React.useState<Draft>(() => of(clip));
  const signature = `${clip.id}|${clip.atMs}|${clip.startMs}|${clip.endMs}|${clip.volume}|${clip.speed}|${clip.fadeInMs}|${clip.fadeOutMs}|${clip.track}`;
  React.useEffect(() => { setDraft(of(clip)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [signature]);
  const patch = (next: Partial<Draft>) => setDraft((now) => ({ ...now, ...next }));
  const original = of(clip);
  const dirty = (Object.keys(original) as (keyof Draft)[]).some((key) => Math.abs(draft[key] - original[key]) > 0.5);
  const pastEnd = fileDurationMs != null && draft.endMs > fileDurationMs;
  const invalid = draft.endMs <= draft.startMs || pastEnd;
  const track = audio?.tracks.find((item) => item.index === clip.track);
  const tracks = audio?.tracks ?? [];
  const [loud, setLoud] = React.useState<{ lufs: number | null; peak: number | null } | null>(null);
  const [measuring, setMeasuring] = React.useState(false);
  const [loudError, setLoudError] = React.useState<string | null>(null);
  const [target, setTarget] = React.useState(String(LOUDNESS_TARGETS[0].lufs));
  const [normalized, setNormalized] = React.useState<string | null>(null);
  React.useEffect(() => { setLoud(null); setNormalized(null); setLoudError(null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [signature]);

  const measure = async () => {
    setMeasuring(true);
    setLoudError(null);
    setNormalized(null);
    try {
      const found = await api.audioLoudness(projectId, clip.path, clip.startMs / 1000, clip.endMs / 1000);
      setLoud(found);
    } catch (e) {
      setLoudError(e instanceof Error ? e.message : String(e));
    } finally {
      setMeasuring(false);
    }
  };
  const normalize = () => {
    if (!loud) return;
    const plan = normalizeVolume(loud.lufs, Number(target));
    if ('silent' in plan) { setNormalized(t('soundStage.loudness.silent')); return; }
    patch({ volume: plan.volume });
    setNormalized(plan.reached
      ? t('soundStage.loudness.normalized').replace('{volume}', formatVolume(plan.volume))
      : t('soundStage.loudness.short').replace('{volume}', formatVolume(plan.volume)).replace('{lufs}', String(plan.lufs)));
  };

  const apply = () => onApply(clip, {
    atMs: draft.atMs,
    startMs: draft.startMs,
    endMs: draft.endMs,
    volume: draft.volume,
    fadeInMs: draft.fadeInMs,
    fadeOutMs: draft.fadeOutMs,
    speed: draft.speed,
    track: draft.track,
  });

  return (
    <div className="flex flex-col gap-3">
      <div className="min-w-0">
        <p className="break-words text-[13px] font-medium text-[var(--text)]">{clip.title || clip.name}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] text-[var(--text-faint)]">
          <span className="font-mono">{clip.id}</span>
          <span>·</span>
          <span>{track?.name ?? `${t('soundStage.inspector.track')} ${clip.track + 1}`}</span>
        </p>
      </div>
      {clip.missing ? <Warn>{t('soundStage.inspector.missingFile')}</Warn> : null}

      <Section title={t('soundStage.inspector.clipFields')} hint={dirty ? t('soundStage.inspector.dirty') : undefined}>
        <NumberRow label={t('soundStage.inspector.at')} value={draft.atMs / 1000} min={0} step={0.01} unit="s"
          onCommit={(value) => patch({ atMs: Math.max(0, Math.round((value ?? 0) * 1000)) })} />
        <p className="-mt-1 pl-[66px] font-mono text-[9.5px] tabular-nums text-[var(--text-faint)]">{formatTimecode(draft.atMs)}</p>
        <div className="grid grid-cols-2 gap-2">
          <NumberRow label={t('soundStage.inspector.start')} value={draft.startMs / 1000} min={0}
            max={Math.max(0, (draft.endMs - 50) / 1000)} step={0.01} unit="s"
            onCommit={(value) => patch({ startMs: Math.max(0, Math.round((value ?? 0) * 1000)) })} />
          <NumberRow label={t('soundStage.inspector.end')} value={draft.endMs / 1000} min={0}
            max={fileDurationMs == null ? undefined : fileDurationMs / 1000} step={0.01} unit="s"
            onCommit={(value) => patch({ endMs: Math.max(0, Math.round((value ?? 0) * 1000)) })} />
        </div>
        <p className="pl-[66px] text-[9.5px] text-[var(--text-faint)]">
          {t('soundStage.inspector.length').replace('{length}', formatSoundLength((draft.endMs - draft.startMs) / draft.speed))}
        </p>
        {invalid ? <Warn>{t(pastEnd ? 'soundStage.inspector.endPastFile' : 'soundStage.inspector.endBeforeStart').replace('{length}', formatSoundLength(fileDurationMs))}</Warn> : null}
        {track?.locked ? <Warn>{t('soundStage.inspector.trackLocked')}</Warn> : null}
        <VolumeRow volume={draft.volume} onVolume={(volume) => patch({ volume })} />
        <div className="grid grid-cols-2 gap-2">
          <NumberRow label={t('soundStage.inspector.fadeIn')} value={draft.fadeInMs / 1000} min={0} step={0.05} unit="s"
            onCommit={(value) => patch({ fadeInMs: Math.max(0, Math.round((value ?? 0) * 1000)) })} />
          <NumberRow label={t('soundStage.inspector.fadeOut')} value={draft.fadeOutMs / 1000} min={0} step={0.05} unit="s"
            onCommit={(value) => patch({ fadeOutMs: Math.max(0, Math.round((value ?? 0) * 1000)) })} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NumberRow label={t('soundStage.inspector.speed')} value={draft.speed} min={0.25} max={4} step={0.05} unit="×"
            onCommit={(value) => patch({ speed: clamp(value ?? 1, 0.25, 4) })} />
          <div className="flex items-center gap-2">
            <span className="w-[52px] shrink-0 text-[10.5px] text-[var(--text-faint)]">{t('soundStage.inspector.track')}</span>
            <MenuSelect size="sm" label={t('soundStage.inspector.track')} value={String(draft.track)}
              groups={[{ choices: tracks.map((item) => ({ value: String(item.index), label: `${item.name} · ${t(`soundStage.role.${item.role}`)}` })) }]}
              onPick={(value) => patch({ track: Number(value) })} className="min-w-0 flex-1" />
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button type="button" onClick={apply} disabled={!dirty || invalid || Boolean(track?.locked)}
            className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[var(--text)] px-3 text-[12px] font-medium text-[var(--panel)] transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-40">
            <RefreshCw size={12} />{t('soundStage.inspector.apply')}
          </button>
          <button type="button" onClick={() => setDraft(of(clip))} disabled={!dirty}
            className="flex h-8 items-center justify-center rounded-lg px-2.5 text-[11.5px] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40">
            {t('soundStage.inspector.revert')}
          </button>
        </div>
      </Section>

      <Section title={t('soundStage.inspector.trackFlags')}>
        <div className="flex flex-wrap gap-1.5">
          <SmallButton onClick={() => onToggleTrack(clip.track, 'muted', !track?.muted)}>
            {track?.muted ? <Volume2 size={11} /> : <VolumeX size={11} />}
            {track?.muted ? t('soundStage.inspector.unmuteTrack') : t('soundStage.inspector.muteTrack')}
          </SmallButton>
          <SmallButton onClick={() => onToggleTrack(clip.track, 'locked', !track?.locked)}>
            {track?.locked ? <LockOpen size={11} /> : <Lock size={11} />}
            {track?.locked ? t('soundStage.inspector.unlockTrack') : t('soundStage.inspector.lockTrack')}
          </SmallButton>
        </div>
      </Section>

      <Section title={t('soundStage.loudness.title')}>
        <div className="flex items-center gap-2">
          <MenuSelect size="sm" label={t('soundStage.loudness.target')} value={target}
            groups={[{ choices: LOUDNESS_TARGETS.map((item) => ({ value: String(item.lufs), label: t(`soundStage.loudness.${item.id}`) })) }]}
            onPick={setTarget} className="min-w-0 flex-1" />
          <button type="button" onClick={() => void measure()} disabled={measuring}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[10.5px] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40">
            {measuring ? <Loader2 size={11} className="animate-spin" /> : <Gauge size={11} />}{t('soundStage.loudness.measure')}
          </button>
        </div>
        {loud ? (
          <div className="flex items-center gap-2 rounded-lg bg-[var(--surface-2)] px-2.5 py-2 text-[10.5px]">
            <span className="min-w-0 flex-1 tabular-nums text-[var(--text-muted)]">
              {loud.lufs == null ? t('soundStage.loudness.silent') : `${t('soundStage.loudness.lufs')} ${loud.lufs.toFixed(1)}`}
              {loud.peak != null ? ` · ${t('soundStage.loudness.peak')} ${loud.peak.toFixed(1)}` : ''}
            </span>
            <button type="button" onClick={normalize} disabled={loud.lufs == null}
              className="shrink-0 rounded-md bg-[var(--surface-3)] px-2 py-1 text-[10.5px] text-[var(--text)] transition hover:opacity-85 disabled:opacity-40">
              {t('soundStage.loudness.apply')}
            </button>
          </div>
        ) : null}
        {loudError ? <Warn>{loudError}</Warn> : null}
        {normalized ? <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">{normalized}</p> : null}
        <p className="text-[9.5px] leading-relaxed text-[var(--text-faint)]">{t('soundStage.loudness.hint')}</p>
      </Section>

      <div className="flex flex-wrap gap-1.5 border-t border-[var(--border-soft)] pt-3">
        <SmallButton onClick={() => onReveal(clip.path)}>{t('soundStage.inspector.reveal')}</SmallButton>
        <SmallButton danger onClick={() => onRemove(clip)}><Trash2 size={11} />{t('soundStage.inspector.remove')}</SmallButton>
      </div>
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 border-t border-[var(--border-soft)] pt-3 first:border-0 first:pt-0">
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 text-[10.5px] font-medium text-[var(--text-faint)]">{title}</h3>
        {hint ? <span className="shrink-0 text-[9.5px] text-[var(--text-faint)]">{hint}</span> : null}
      </div>
      {children}
    </section>
  );
}

function NumberRow({ label, value, min, max, step, unit, allowEmpty, onCommit }: {
  label: string;
  value: number | null;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  allowEmpty?: boolean;
  onCommit: (value: number | null) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="w-[64px] shrink-0 truncate text-[10.5px] text-[var(--text-faint)]">{label}</span>
      <span className="flex h-7 min-w-0 flex-1 items-center rounded-md border border-[var(--border)] bg-[var(--bg)] px-2">
        <NumberInput value={value} min={min} max={max} step={step} allowEmpty={allowEmpty} onCommit={onCommit}
          className="h-7 min-w-0 flex-1 border-0 bg-transparent text-[11px] tabular-nums text-[var(--text)] outline-none" />
        {unit ? <span className="shrink-0 pl-1 text-[9.5px] text-[var(--text-faint)]">{unit}</span> : null}
      </span>
    </label>
  );
}

function VolumeRow({ volume, onVolume }: { volume: number; onVolume: (volume: number) => void }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2">
      <span className="w-[64px] shrink-0 text-[10.5px] text-[var(--text-faint)]">{t('soundStage.inspector.volume')}</span>
      <button type="button" onClick={() => onVolume(volume > 0 ? 0 : 1)} aria-label={t('soundStage.audition.mute')}
        className="flex h-6 w-5 shrink-0 items-center justify-center text-[var(--text-faint)] hover:text-[var(--text)]">
        {volume <= 0 ? <VolumeX size={12} /> : <Volume2 size={12} />}
      </button>
      <input type="range" min={0} max={2} step={0.01} value={volume} onChange={(event) => onVolume(Number(event.target.value))}
        aria-label={t('soundStage.inspector.volume')} className="h-1 min-w-0 flex-1 accent-[var(--accent)]" />
      <span className="w-[38px] shrink-0 text-right text-[10px] tabular-nums text-[var(--text-muted)]">{formatVolume(volume)}</span>
    </div>
  );
}

function SmallButton({ children, onClick, danger = false }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[10.5px] ring-1 ring-inset ring-[var(--border)] transition hover:bg-[var(--bg-hover)] ${danger ? 'text-[var(--err)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
      {children}
    </button>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="flex items-start gap-1.5 rounded-lg border border-[var(--warn)]/40 px-2.5 py-2 text-[10px] leading-relaxed text-[var(--text-muted)]">
      <AlertTriangle size={11} aria-hidden className="mt-px shrink-0 text-[var(--warn)]" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
