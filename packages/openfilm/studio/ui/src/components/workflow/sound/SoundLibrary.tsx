/**
 * The sound stage's left pane: where sound comes from.
 *
 * Three places, because they fail for different reasons: the project's own files (and the ones an agent left there), a
 * stock search (Freesound for effects, Jamendo for music, each needing a key), and the connected provider that makes a
 * voice-over, a score or an effect. Picking never writes to the film: the inspector is where a sound is placed.
 */
import * as React from 'react';
import {
  Captions, Download, ExternalLink, FolderOpen, Globe2, Loader2, Mic, Music4, RefreshCw, Search, Settings2, Sparkles, Upload, Volume2, WandSparkles,
} from 'lucide-react';
import type { AudioAsset, AudioCatalog, AudioSearchResult, AudioSourceState, AudioVoice, SoundRole } from '@/api';
import { useT } from '@/i18n';
import { SOUND_ROLES, audioSourceLabel, formatSoundLength } from '@/lib/sound';
import type { ProviderVerb, ProvidersState } from '@/lib/providers';
import { MenuSelect } from '../../MenuSelect';
import { NumberInput } from '../../NumberInput';
import { Tooltip } from '../../Tooltip';
import { SoundRoleChip, SoundRoleMark } from './SoundRoleMark';

export type SoundView = 'project' | 'network' | 'generate';

/** The generation form, all three kinds together so a switch of kind does not lose what was typed. */
export interface SoundForm {
  kind: SoundRole;
  text: string;
  voice: string;
  musicPrompt: string;
  musicSec: number | null;
  sfxPrompt: string;
  sfxSec: number | null;
  /** The provider card chosen for this run ('' = the default in Settings), and its model. */
  provider: string;
  model: string;
}

const NETWORK_LABEL: Record<string, string> = { freesound: 'Freesound', jamendo: 'Jamendo' };

const inputClass = 'h-8 w-full min-w-0 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 text-[12px] text-[var(--text)] outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--border-strong)]';

export function SoundLibrary({
  view, onView, role, onRole,
  library, libraryLoading, onRefresh,
  selectedPath, onSelectAsset,
  uploadRole, onUploadRole, uploading, onUpload,
  networkQuery, onNetworkQuery, networkResults, networkSources, networkLoading, onNetworkSearch,
  selectedRemoteId, onSelectRemote, onImportRemote, importingId,
  catalog, onSettings,
  providers,
  subtitleLines,
  form, onForm, voices, voicesLoading, voicesNote, onLoadVoices,
  onGenerate, generating,
}: {
  view: SoundView;
  onView: (view: SoundView) => void;
  role: SoundRole | 'all';
  onRole: (role: SoundRole | 'all') => void;
  library: AudioAsset[] | null;
  libraryLoading: boolean;
  onRefresh: () => void;
  selectedPath: string | null;
  onSelectAsset: (asset: AudioAsset) => void;
  uploadRole: SoundRole;
  onUploadRole: (role: SoundRole) => void;
  uploading: boolean;
  onUpload: (files: File[]) => void;
  networkQuery: string;
  onNetworkQuery: (query: string) => void;
  networkResults: AudioSearchResult[] | null;
  networkSources: AudioSourceState[];
  networkLoading: boolean;
  onNetworkSearch: () => void;
  selectedRemoteId: string | null;
  onSelectRemote: (result: AudioSearchResult) => void;
  onImportRemote: (result: AudioSearchResult) => void;
  importingId: string | null;
  catalog: AudioCatalog | null;
  onSettings: () => void;
  /** Settings → Providers' cards and catalog: who makes this kind of media, and with which model. */
  providers: ProvidersState | null;
  subtitleLines: readonly string[];
  form: SoundForm;
  onForm: (patch: Partial<SoundForm>) => void;
  voices: AudioVoice[] | null;
  voicesLoading: boolean;
  voicesNote: string | null;
  onLoadVoices: () => void;
  onGenerate: () => void;
  generating: boolean;
}) {
  const t = useT();
  const [localQuery, setLocalQuery] = React.useState('');
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const files = React.useMemo(() => {
    const needle = localQuery.trim().toLowerCase();
    return (library ?? []).filter((file) => {
      if (role !== 'all' && file.role !== role) return false;
      if (!needle) return true;
      return `${file.title} ${file.name} ${file.path}`.toLowerCase().includes(needle);
    });
  }, [library, localQuery, role]);
  const networkShown = React.useMemo(
    () => (networkResults ?? []).filter((result) => role === 'all' || result.role === role),
    [networkResults, role],
  );

  const kind = form.kind;
  const kindReady = catalog?.kinds[kind]?.available ?? false;
  const voiceChoices = React.useMemo(() => (voices ?? []).map((voice) => ({
    value: voice.voiceId,
    label: [voice.name, voice.language, voice.gender].filter(Boolean).join(' · '),
  })), [voices]);
  const chosenVoice = voiceChoices.some((choice) => choice.value === form.voice) ? form.voice : voiceChoices[0]?.value ?? '';
  const canGenerate = kindReady && !generating && (
    kind === 'voice' ? Boolean(form.text.trim() && chosenVoice) : Boolean((kind === 'music' ? form.musicPrompt : form.sfxPrompt).trim())
  );

  React.useEffect(() => {
    if (view !== 'generate' || form.kind !== 'voice' || voices !== null || voicesLoading) return;
    if (!catalog?.kinds.voice.available) return;
    onLoadVoices();
  }, [view, form.kind, voices, voicesLoading, catalog, onLoadVoices]);

  /* the generate pane has one kind at a time, and the other panes follow it: coming from the network or the project
     list, the filter is the kind about to be made */
  React.useEffect(() => {
    if (view === 'generate') onRole(form.kind);
    // the kind is read when the pane is opened; switching it there sets the role itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  /* the two stock services that apply to the role in hand, as far as the last answer said */
  const shownSources = networkSources.filter((source) => role === 'all' || (source.id === 'freesound' ? role === 'sfx' : source.id === 'jamendo' ? role === 'music' : true));

  return (
    <aside className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]" aria-label={t('soundStage.library.title')}>
      <div className="flex shrink-0 items-center gap-2 px-3 pb-2 pt-3">
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--text)]">{t('soundStage.library.title')}</span>
        {view === 'project' ? (
          <Tooltip label={t('soundStage.library.refresh')} side="top">
            <button type="button" aria-label={t('soundStage.library.refresh')} onClick={onRefresh}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-faint)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
              <RefreshCw size={12} className={libraryLoading ? 'animate-spin' : ''} />
            </button>
          </Tooltip>
        ) : null}
      </div>

      <div className="mx-3 flex shrink-0 items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-[2px]" role="tablist" aria-label={t('soundStage.library.sources')}>
        {([
          ['project', FolderOpen],
          ['network', Globe2],
          ['generate', WandSparkles],
        ] as const).map(([id, Icon]) => {
          const active = view === id;
          return (
            <button key={id} type="button" role="tab" aria-selected={active} onClick={() => onView(id)}
              className={`flex h-6 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-1.5 text-[11px] transition ${
                active ? 'bg-[var(--surface-3)] text-[var(--text)] shadow-[var(--shadow-sm)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'
              }`}>
              <Icon size={12} aria-hidden />
              <span className="truncate">{t(`soundStage.library.view.${id}`)}</span>
              {id === 'project' && library?.length ? <span className="shrink-0 tabular-nums text-[9.5px] text-[var(--text-faint)]">{library.length}</span> : null}
            </button>
          );
        })}
      </div>

      {view === 'generate' ? (
        <Generate
          form={form} onForm={onForm} onRole={onRole}
          catalog={catalog} onSettings={onSettings} providers={providers}
          subtitleLines={subtitleLines}
          voiceChoices={voiceChoices} chosenVoice={chosenVoice}
          voicesLoading={voicesLoading} voicesNote={voicesNote} onLoadVoices={onLoadVoices}
          canGenerate={canGenerate} onGenerate={onGenerate} generating={generating}
        />
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-1 px-3 pb-2 pt-3">
            {(['all', ...SOUND_ROLES] as const).map((value) => {
              const active = role === value;
              return (
                <button key={value} type="button" aria-pressed={active} onClick={() => onRole(value)}
                  className={`flex h-5 items-center gap-1 rounded-full px-1.5 text-[10px] transition ${
                    active ? 'bg-[var(--surface-3)] text-[var(--text)] ring-1 ring-inset ring-[var(--border)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]'
                  }`}>
                  {value === 'all' ? null : <SoundRoleMark role={value} size={10} />}
                  {t(`soundStage.role.${value}`)}
                </button>
              );
            })}
          </div>

          {view === 'project' ? (
            <>
              <div className="flex shrink-0 items-center gap-1.5 px-3 pb-2">
                <span className="relative flex min-w-0 flex-1 items-center">
                  <Search size={12} aria-hidden className="pointer-events-none absolute left-2 text-[var(--text-faint)]" />
                  <input value={localQuery} onChange={(event) => setLocalQuery(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Escape') setLocalQuery(''); }}
                    placeholder={t('soundStage.library.search')} aria-label={t('soundStage.library.search')}
                    className={`${inputClass} pl-7`} />
                </span>
                <span className="w-[84px] shrink-0">
                  <MenuSelect size="sm" label={t('soundStage.library.uploadTo')} value={uploadRole}
                    prefix={t('soundStage.library.to')}
                    groups={[{ choices: SOUND_ROLES.map((value) => ({ value, label: t(`soundStage.role.${value}`) })) }]}
                    onPick={(value) => onUploadRole(value as SoundRole)} />
                </span>
                <Tooltip label={t('soundStage.library.upload')} side="top">
                  <button type="button" aria-label={t('soundStage.library.upload')} onClick={() => fileRef.current?.click()} disabled={uploading}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40">
                    {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                  </button>
                </Tooltip>
                <input ref={fileRef} type="file" accept="audio/*" multiple className="hidden"
                  onChange={(event) => {
                    const picked = [...(event.target.files ?? [])];
                    event.target.value = '';
                    if (picked.length) onUpload(picked);
                  }} />
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
                {library === null && libraryLoading ? (
                  <p className="flex items-center justify-center gap-2 py-8 text-[11px] text-[var(--text-faint)]"><Loader2 size={13} className="animate-spin" />{t('soundStage.library.loading')}</p>
                ) : files.length ? (
                  <div className="flex flex-col gap-0.5">
                    {files.map((file) => {
                      const active = file.path === selectedPath;
                      return (
                        <div key={file.path} draggable={!file.unreadable && !file.missing} data-sound-asset={file.path}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = 'copy';
                            event.dataTransfer.setData('application/x-openfilm-sound', JSON.stringify({ path: file.path, title: file.title, durationMs: file.durationMs }));
                          }}
                          className={`flex items-center gap-1 rounded-lg pr-1 transition ${active ? 'bg-[var(--surface-2)] ring-1 ring-inset ring-[var(--border-strong)]' : 'hover:bg-[var(--bg-hover)]'}`}>
                          <button type="button" onClick={() => onSelectAsset(file)}
                            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left">
                            <SoundRoleMark role={file.role} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12px] text-[var(--text)]">{file.title || file.name}</span>
                              <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[10px] text-[var(--text-faint)]">
                                <span className="tabular-nums">{formatSoundLength(file.durationMs)}</span>
                                {file.source && file.source !== 'local' ? <span className="text-[var(--text-muted)]">{audioSourceLabel(file.source, t)}</span> : null}
                                {file.unreadable ? <span className="text-[var(--warn)]">{t('soundStage.library.unreadable')}</span> : null}
                                {file.missing ? <span className="text-[var(--err)]">{t('soundStage.library.missing')}</span> : null}
                              </span>
                            </span>
                          </button>
                          {file.unreadable ? null : <SoundRoleChip role={file.role} label={t(`soundStage.role.${file.role}`)} />}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <Empty icon={<Music4 size={20} />} title={t('soundStage.library.empty')} hint={t('soundStage.library.emptyHint')}
                    action={(
                      <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
                        className="mt-1 inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[11px] text-[var(--text)] ring-1 ring-inset ring-[var(--border-strong)] transition hover:bg-[var(--bg-hover)]">
                        <Upload size={12} />{t('soundStage.library.upload')}
                      </button>
                    )} />
                )}
              </div>
            </>
          ) : (
            <>
              <div className="flex shrink-0 items-center gap-1.5 px-3 pb-2">
                <span className="relative flex min-w-0 flex-1 items-center">
                  <Search size={12} aria-hidden className="pointer-events-none absolute left-2 text-[var(--text-faint)]" />
                  <input value={networkQuery} onChange={(event) => onNetworkQuery(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') onNetworkSearch(); }}
                    placeholder={t('soundStage.network.searchHint')} aria-label={t('soundStage.network.searchHint')}
                    className={`${inputClass} pl-7`} />
                </span>
                <button type="button" onClick={onNetworkSearch} disabled={networkLoading || role === 'voice'}
                  className="flex h-8 shrink-0 items-center gap-1 rounded-lg bg-[var(--text)] px-2.5 text-[11.5px] font-medium text-[var(--panel)] transition hover:opacity-90 disabled:opacity-40">
                  {networkLoading ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                  {t('soundStage.network.search')}
                </button>
              </div>

              <div className="flex shrink-0 flex-wrap items-center gap-1 px-3 pb-2">
                {shownSources.length ? shownSources.map((source) => (
                  <span key={source.id} title={source.note}
                    className="inline-flex min-w-0 items-center gap-1 rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[9.5px] leading-4 text-[var(--text-muted)]">
                    <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${source.available ? 'bg-[var(--ok)]' : 'bg-[var(--text-faint)]'}`} />
                    <span className="truncate">{NETWORK_LABEL[source.id] ?? source.id}</span>
                    {source.available ? null : <span className="text-[var(--text-faint)]">{t('soundStage.network.notConnected')}</span>}
                  </span>
                )) : (
                  <span className="text-[10px] text-[var(--text-faint)]">{networkLoading ? t('soundStage.network.checking') : t('soundStage.network.searchHint')}</span>
                )}
                {shownSources.some((source) => !source.available) ? (
                  <button type="button" onClick={onSettings} className="text-[10px] text-[var(--text-muted)] underline-offset-2 hover:text-[var(--text)] hover:underline">
                    {t('soundStage.network.connect')}
                  </button>
                ) : null}
                {shownSources.some((source) => !source.available) ? (
                  <p className="basis-full px-1 text-[9.5px] leading-relaxed text-[var(--text-faint)]">{t('soundStage.network.keyHint')}</p>
                ) : null}
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
                {networkLoading && !networkResults ? (
                  <p className="flex items-center justify-center gap-2 py-8 text-[11px] text-[var(--text-faint)]"><Loader2 size={13} className="animate-spin" />{t('soundStage.network.searching')}</p>
                ) : networkShown.length ? (
                  <div className="flex flex-col gap-0.5">
                    {networkShown.map((result) => {
                      const key = `${result.source}:${result.id}`;
                      const active = key === selectedRemoteId;
                      return (
                        <div key={key} className={`flex items-start gap-1 rounded-lg pr-1 transition ${active ? 'bg-[var(--surface-2)] ring-1 ring-inset ring-[var(--border-strong)]' : 'hover:bg-[var(--bg-hover)]'}`}>
                          <button type="button" onClick={() => onSelectRemote(result)}
                            className="flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-1.5 text-left">
                            <SoundRoleMark role={result.role} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12px] text-[var(--text)]">{result.title}</span>
                              <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[10px] text-[var(--text-faint)]">
                                <span className="tabular-nums">{formatSoundLength(result.durationMs)}</span>
                                <span>{NETWORK_LABEL[result.source] ?? result.source}</span>
                                {result.credit ? <span className="max-w-full truncate">{result.credit}</span> : null}
                              </span>
                            </span>
                          </button>
                          {result.page ? (
                            <a href={result.page} target="_blank" rel="noreferrer" title={t('soundStage.network.page')}
                              className="mt-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
                              <ExternalLink size={11} />
                            </a>
                          ) : null}
                          <Tooltip label={t('soundStage.network.import')} side="top">
                            <button type="button" aria-label={t('soundStage.network.import')} onClick={() => onImportRemote(result)} disabled={importingId !== null || !result.downloadUrl}
                              className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40">
                              {importingId === key ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
                            </button>
                          </Tooltip>
                        </div>
                      );
                    })}
                  </div>
                ) : role === 'voice' ? (
                  <Empty icon={<Mic size={20} />} title={t('soundStage.network.voiceOnly')} hint={t('soundStage.network.voiceOnlyHint')} />
                ) : networkQuery.trim() ? (
                  <Empty icon={<Globe2 size={20} />} title={t('soundStage.network.empty')} hint={t('soundStage.network.emptyHint')} />
                ) : (
                  <Empty icon={<Globe2 size={20} />} title={t('soundStage.network.start')} hint={t('soundStage.network.startHint')} />
                )}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
}

function Generate({
  form, onForm, onRole, catalog, onSettings, providers, subtitleLines, voiceChoices, chosenVoice,
  voicesLoading, voicesNote, onLoadVoices, canGenerate, onGenerate, generating,
}: {
  form: SoundForm;
  onForm: (patch: Partial<SoundForm>) => void;
  onRole: (role: SoundRole | 'all') => void;
  catalog: AudioCatalog | null;
  onSettings: () => void;
  providers: ProvidersState | null;
  subtitleLines: readonly string[];
  voiceChoices: { value: string; label: string }[];
  chosenVoice: string;
  voicesLoading: boolean;
  voicesNote: string | null;
  onLoadVoices: () => void;
  canGenerate: boolean;
  onGenerate: () => void;
  generating: boolean;
}) {
  const t = useT();
  const kind = form.kind;
  const state = catalog?.kinds[kind];
  const available = state?.available ?? false;
  const prompt = kind === 'music' ? form.musicPrompt : form.sfxPrompt;
  const sec = kind === 'music' ? form.musicSec : form.sfxSec;
  const category: ProviderVerb = kind === 'voice' ? 'tts' : kind === 'music' ? 'music' : 'sfx';
  const providerList = providers?.providers ?? [];
  const connected = providerList.filter((item) => item.source && item.verbs.includes(category));
  const selectedProvider = connected.find((item) => item.id === form.provider) ?? null;
  const providerValue = selectedProvider?.id ?? 'auto';
  const models = selectedProvider?.models[category] ?? [];
  const chosenModel = providers?.model[category] ?? null;
  const modelValue = selectedProvider
    ? (form.model || (models.some((model) => model.id === chosenModel) ? chosenModel : models[0]?.id) || '')
    : '';
  const recommended = [...new Set(providerList.filter((item) => item.verbs.includes(category)).map((item) => item.name))];
  const autoId = providers?.use[category] ?? null;
  const autoProvider = providerList.find((item) => item.id === autoId)?.name ?? catalog?.kinds[kind]?.provider;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 px-3 pb-2 pt-3" role="tablist" aria-label={t('soundStage.generate.kind')}>
        {SOUND_ROLES.map((value) => {
          const active = kind === value;
          return (
            <button key={value} type="button" role="tab" aria-selected={active}
              onClick={() => { onForm({ kind: value, provider: '', model: '' }); onRole(value); }}
              className={`flex h-6 min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1 text-[11px] transition ${
                active ? 'bg-[var(--surface-2)] text-[var(--text)] ring-1 ring-inset ring-[var(--border)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]'
              }`}>
              <SoundRoleMark role={value} size={11} />
              <span className="truncate">{t(`soundStage.role.${value}`)}</span>
            </button>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
        {catalog === null ? (
          <p className="flex items-center gap-2 py-6 text-[11px] text-[var(--text-faint)]"><Loader2 size={13} className="animate-spin" />{t('soundStage.generate.checking')}</p>
        ) : !available ? (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
            <p className="text-[11.5px] font-medium text-[var(--text)]">{t('soundStage.generate.unavailable')}</p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-[var(--text-faint)]">{t('soundStage.generate.unavailableHint')}</p>
            {catalog.note ? (
              <details className="mt-1.5">
                <summary className="cursor-pointer text-[9.5px] text-[var(--text-faint)] hover:text-[var(--text-muted)]">{t('soundStage.generate.details')}</summary>
                <p className="mt-1 max-h-[120px] overflow-y-auto break-words text-[9.5px] leading-relaxed text-[var(--text-faint)]">{catalog.note}</p>
              </details>
            ) : null}
            <button type="button" onClick={onSettings}
              className="mt-2 flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-[var(--text)] ring-1 ring-inset ring-[var(--border-strong)] transition hover:bg-[var(--bg-hover)]">
              <Sparkles size={11} />{t('soundStage.generate.openSettings')}
            </button>
          </div>
        ) : (
          <p className="mb-2 flex items-center gap-1.5 text-[10px] text-[var(--text-faint)]">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[var(--ok)]" />
            {t('soundStage.generate.connected').replace('{what}', selectedProvider?.name ?? autoProvider ?? t('soundStage.generate.providerDefaultName'))}
          </p>
        )}

        {catalog ? (
        <div className="mb-2 flex flex-col gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="w-[52px] shrink-0 text-[10.5px] text-[var(--text-faint)]">{t('soundStage.generate.provider')}</span>
            {connected.length ? (
              <MenuSelect size="sm" label={t('soundStage.generate.provider')} value={providerValue}
                groups={[{ choices: [
                  { value: 'auto', label: `${t('soundStage.generate.providerAuto')}${autoProvider ? ` · ${autoProvider}` : ''}` },
                  ...connected.map((item) => ({ value: item.id, label: item.name })),
                ] }]}
                onPick={(value) => onForm({ provider: value === 'auto' ? '' : value, model: '' })} className="min-w-0 flex-1" />
            ) : (
              <span className="min-w-0 flex-1 text-[10px] text-[var(--text-faint)]">
                {available ? t('soundStage.generate.providerDefaultOnly') : t('soundStage.generate.providerNone')}
              </span>
            )}
            <Tooltip label={t('soundStage.generate.providerManage')} side="top">
              <button type="button" aria-label={t('soundStage.generate.providerManage')} onClick={onSettings}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-faint)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
                <Settings2 size={11} />
              </button>
            </Tooltip>
          </div>
          {selectedProvider && models.length ? (
            <div className="flex items-center gap-1.5">
              <span className="w-[52px] shrink-0 text-[10.5px] text-[var(--text-faint)]">{t('soundStage.generate.model')}</span>
              <MenuSelect size="sm" label={t('soundStage.generate.model')} value={modelValue}
                groups={[{ choices: models.map((model) => ({ value: model.id, label: model.name })) }]}
                onPick={(value) => onForm({ model: value })} className="min-w-0 flex-1" />
            </div>
          ) : null}
          {!connected.length && recommended.length ? (
            <p className="text-[9.5px] leading-relaxed text-[var(--text-faint)]">
              {t('soundStage.generate.providerRecommend').replace('{names}', recommended.join('、'))}
            </p>
          ) : null}
        </div>
        ) : null}

        {kind === 'voice' ? (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] font-medium text-[var(--text-faint)]">{t('soundStage.generate.text')}</span>
              <textarea value={form.text} onChange={(event) => onForm({ text: event.target.value })} rows={5}
                placeholder={t('soundStage.generate.textHint')}
                className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--border-strong)]" />
            </label>
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={() => {
                const lines = subtitleLines.map((line) => line.trim()).filter(Boolean);
                if (!lines.length) return;
                onForm({ text: form.text.trim() ? `${form.text.trim()}\n${lines.join('\n')}` : lines.join('\n') });
              }} disabled={!subtitleLines.length}
                className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[10.5px] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40">
                <Captions size={11} />{t('soundStage.generate.fromSubtitles').replace('{n}', String(subtitleLines.length))}
              </button>
              <span className="min-w-0 flex-1" />
              <span className="text-[9.5px] tabular-nums text-[var(--text-faint)]">{form.text.length}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-[52px] shrink-0 text-[10.5px] text-[var(--text-faint)]">{t('soundStage.generate.voice')}</span>
              <MenuSelect size="sm" label={t('soundStage.generate.voice')} value={chosenVoice}
                groups={[{ choices: voiceChoices }]}
                onPick={(value) => onForm({ voice: value })} disabled={!voiceChoices.length || voicesLoading} className="min-w-0 flex-1" />
              <Tooltip label={t('soundStage.generate.reloadVoices')} side="top">
                <button type="button" aria-label={t('soundStage.generate.reloadVoices')} onClick={onLoadVoices} disabled={voicesLoading || !available}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-faint)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40">
                  <RefreshCw size={11} className={voicesLoading ? 'animate-spin' : ''} />
                </button>
              </Tooltip>
            </div>
            {voicesLoading ? (
              <p className="text-[10px] text-[var(--text-faint)]">{t('soundStage.generate.voicesLoading')}</p>
            ) : available && !voiceChoices.length ? (
              <p className="text-[10px] leading-relaxed text-[var(--text-faint)]">{voicesNote ?? t('soundStage.generate.voicesEmpty')}</p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10.5px] font-medium text-[var(--text-faint)]">{t(`soundStage.generate.${kind}Prompt`)}</span>
              <textarea value={prompt} onChange={(event) => onForm(kind === 'music' ? { musicPrompt: event.target.value } : { sfxPrompt: event.target.value })} rows={5}
                placeholder={t(`soundStage.generate.${kind}Hint`)}
                className="w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--text-faint)] focus:border-[var(--border-strong)]" />
            </label>
            <label className="flex items-center gap-2">
              <span className="w-[52px] shrink-0 text-[10.5px] text-[var(--text-faint)]">{t('soundStage.generate.sec')}</span>
              <span className="flex h-8 min-w-0 flex-1 items-center rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2">
                <NumberInput value={sec} allowEmpty min={kind === 'music' ? 3 : 0.5} max={kind === 'music' ? 300 : 22} step={0.5}
                  onCommit={(value) => onForm(kind === 'music' ? { musicSec: value } : { sfxSec: value })}
                  className="min-w-0 flex-1 border-0 bg-transparent text-[12px] tabular-nums text-[var(--text)] outline-none" />
                <span className="shrink-0 text-[10px] text-[var(--text-faint)]">s</span>
              </span>
              <span className="w-[74px] shrink-0 text-[9px] leading-tight text-[var(--text-faint)]">{t(`soundStage.generate.${kind}SecHint`)}</span>
            </label>
          </div>
        )}

        <button type="button" onClick={onGenerate} disabled={!canGenerate}
          className="mt-3 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--text)] px-3 text-[12px] font-medium text-[var(--panel)] transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-40">
          {generating ? <Loader2 size={13} className="animate-spin" /> : kind === 'voice' ? <Volume2 size={13} /> : kind === 'music' ? <Music4 size={13} /> : <Sparkles size={13} />}
          {generating ? t('soundStage.generate.making') : t(`soundStage.generate.make.${kind}`)}
        </button>
        <p className="mt-2 text-[9.5px] leading-relaxed text-[var(--text-faint)]">{t('soundStage.generate.cost')}</p>
      </div>
    </div>
  );
}

function Empty({ icon, title, hint, action }: { icon: React.ReactNode; title: string; hint: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <span aria-hidden className="text-[var(--text-faint)]">{icon}</span>
      <p className="text-[12px] font-medium text-[var(--text-muted)]">{title}</p>
      <p className="max-w-[280px] text-[10.5px] leading-relaxed text-[var(--text-faint)]">{hint}</p>
      {action}
    </div>
  );
}
