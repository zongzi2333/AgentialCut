/**
 * The semantic-index popover: what is installed, what each library has indexed, and the few
 * actions that change it. All media work stays in the sidecar; this panel only asks.
 */
import * as React from 'react';
import { AlertTriangle, Database, FolderOpen, HardDrive, Loader2, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import { api, ApiError, type SemanticLibrary, type SemanticStatus } from '@/api';
import { useT } from '@/i18n';
import { ConfirmDialog } from '../ConfirmDialog';
import { Tooltip } from '../Tooltip';

export function SemanticIndexPanel({ status, error, selectedCount, selectedPaths, folder, onStart, onStartExternal, onCancel, onRemove, onAddExternal, onRemoveExternal, onImportModel, onRefresh, notify }: {
  status: SemanticStatus | null;
  error: string;
  selectedCount: number;
  selectedPaths: readonly string[];
  folder: string;
  onStart: (options?: { modelId?: string; mode?: 'new' | 'update' | 'rebuild'; assetIds?: string[]; folders?: string[] }) => Promise<boolean>;
  onStartExternal: (libraryId: string, options?: { modelId?: string; mode?: 'new' | 'update' | 'rebuild' }) => Promise<boolean>;
  onCancel: () => Promise<void>;
  onRemove: () => Promise<void>;
  onAddExternal: (path: string, name?: string, indexRoot?: string) => Promise<void>;
  onRemoveExternal: (libraryId: string) => Promise<void>;
  onImportModel: (file: File) => Promise<void>;
  onRefresh: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const t = useT();
  const [modelId, setModelId] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const [scope, setScope] = React.useState<'all' | 'selected' | 'folder'>('all');
  const importRef = React.useRef<HTMLInputElement>(null);
  const models = status?.models ?? [];
  const project = status?.project;
  const sidecar = status?.sidecar;
  const job = project?.job;
  const working = job?.state === 'queued' || job?.state === 'running';
  const activeModel = modelId || project?.stores?.[0]?.modelId || models[0]?.id || '';

  React.useEffect(() => {
    if (!modelId) setModelId(project?.stores?.[0]?.modelId || models[0]?.id || '');
  }, [modelId, models, project?.stores]);
  React.useEffect(() => { if (!selectedCount && scope === 'selected') setScope('all'); }, [selectedCount, scope]);

  async function run(task: () => Promise<unknown>) {
    setBusy(true);
    try { await task(); } catch (e) {
      notify(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function addLibrary() {
    await run(async () => {
      let path: string | null = null;
      try { path = await api.pickFolder(t('semanticIndex.addExternal')); } catch (e) {
        if (e instanceof ApiError && e.status === 501) throw new Error(t('semanticIndex.addExternal'));
        throw e;
      }
      if (!path) return;
      try {
        await onAddExternal(path);
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 403) throw e;
        const indexRoot = await api.pickFolder(t('semanticIndex.indexFolder'), path);
        if (!indexRoot) return;
        await onAddExternal(path, undefined, indexRoot);
      }
      notify(t('semanticIndex.addExternal'));
    });
  }

  async function chooseModel(file: File) {
    await run(async () => {
      await onImportModel(file);
      notify(t('semanticIndex.modelImported'));
    });
  }

  if (sidecar && sidecar.state !== 'ready') {
    return (
      <div className="w-[360px] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[var(--shadow-lg)]" role="dialog" aria-label={t('semanticIndex.title')}>
        <div className="flex items-center gap-2">
          <AlertTriangle size={13} className="text-[var(--warn)]" />
          <span className="text-[12px] font-medium text-[var(--text)]">{t('semanticIndex.title')}</span>
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
          {sidecar.state === 'starting' ? t('semanticIndex.sidecarStarting') : t('semanticIndex.sidecarOff')}
        </p>
        {sidecar.reason ? <p className="mt-1 break-words text-[10.5px] leading-relaxed text-[var(--text-faint)]">{sidecar.reason}</p> : null}
        <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--text-faint)]">{t('semanticIndex.indexUnavailable')}</p>
        <button type="button" onClick={() => void run(onRefresh)}
          className="mt-2 h-7 rounded-md px-2.5 text-[11px] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] hover:text-[var(--text)]">
          {t('semanticIndex.retry')}
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="w-[380px] rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-[var(--shadow-lg)]" role="dialog" aria-label={t('semanticIndex.title')}>
        <div className="flex items-center gap-2">
          <Database size={13} className="text-[var(--accent)]" />
          <span className="text-[12px] font-medium text-[var(--text)]">{t('semanticIndex.title')}</span>
          <span className="min-w-0 flex-1" />
          <span className="rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[10px] text-[var(--text-faint)]">
            {sidecar?.state === 'ready' ? t('semanticIndex.sidecarReady') : t('semanticIndex.sidecarOff')}
          </span>
        </div>

        {error ? <p className="mt-2 rounded-md bg-[var(--surface-2)] px-2 py-1.5 text-[10.5px] leading-relaxed text-[var(--err)]">{error}</p> : null}

        <div className="mt-3 flex items-center gap-2">
          <span className="text-[10.5px] text-[var(--text-faint)]">{t('semanticIndex.model')}</span>
          <select value={activeModel} onChange={(event) => setModelId(event.target.value)} disabled={!models.length || working}
            className="h-7 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-[11px] text-[var(--text)] outline-none">
            {models.length ? models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>) : <option value="">{t('semanticIndex.noModels')}</option>}
          </select>
          <Tooltip label={t('semanticIndex.importModel')} side="top">
            <button type="button" aria-label={t('semanticIndex.importModel')} onClick={() => importRef.current?.click()}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
              <Upload size={13} />
            </button>
          </Tooltip>
          <input ref={importRef} type="file" accept=".zip,application/zip" className="hidden"
            onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void chooseModel(file); }} />
          <div className="flex h-7 items-center gap-1 rounded-md bg-[var(--surface-2)] px-1.5 text-[10px] text-[var(--text-faint)]">
            <HardDrive size={10} />{sidecar?.device || 'cpu'}
          </div>
        </div>

        <div className="mt-3 rounded-md bg-[var(--surface-2)] px-2 py-2">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-[var(--text)]">{project?.name || t('semanticIndex.projectLibrary')}</span>
            <span className="text-[10px] text-[var(--text-faint)]">{project ? `${project.assets.ready}/${project.assets.total}` : '—'}</span>
          </div>
          <p className="mt-1 text-[10px] tabular-nums text-[var(--text-faint)]">
            {t('semanticIndex.assetsReady').replace('{n}', String(project?.assets.ready ?? 0))} · {t('semanticIndex.assetsPending').replace('{n}', String(project?.assets.notIndexed ?? 0))} · {t('semanticIndex.assetsStale').replace('{n}', String(project?.assets.stale ?? 0))}
            {project?.assets.missing ? ` · ${t('semanticIndex.assetsMissing').replace('{n}', String(project.assets.missing))}` : null}
          </p>
          {working ? (
            <div className="mt-2">
              <div className="h-1 overflow-hidden rounded-full bg-[var(--border)]">
                <div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${Math.max(0, Math.min(100, job?.progress ?? 0))}%` }} />
              </div>
              <p className="mt-1 flex items-center gap-1 text-[10px] text-[var(--text-faint)]"><Loader2 size={10} className="animate-spin" />{job?.message || t('semanticIndex.progress')} · {Math.round(job?.progress ?? 0)}%</p>
            </div>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button type="button" disabled={busy || working || !models.length || !project?.assets.total} onClick={() => void run(() => onStart({ modelId: activeModel, mode: 'update', ...(scope === 'selected' ? { assetIds: [...selectedPaths] } : {}), ...(scope === 'folder' && folder ? { folders: [folder] } : {}) }))}
              className="h-7 rounded-md bg-[var(--text)] px-2.5 text-[11px] font-medium text-[var(--panel)] disabled:opacity-40">
              {project?.assets.ready ? t('semanticIndex.update') : t('semanticIndex.index')}
            </button>
            <button type="button" disabled={busy || working || !models.length || !project?.assets.total} onClick={() => void run(() => onStart({ modelId: activeModel, mode: 'rebuild' }))}
              className="h-7 rounded-md px-2 text-[11px] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] hover:text-[var(--text)] disabled:opacity-40">
              <RotateCcw size={11} className="mr-1 inline" />{t('semanticIndex.rebuild')}
            </button>
            {working ? (
              <button type="button" disabled={busy} onClick={() => void run(onCancel)}
                className="h-7 rounded-md px-2 text-[11px] text-[var(--err)] ring-1 ring-inset ring-[var(--border)] disabled:opacity-40">
                {t('semanticIndex.cancel')}
              </button>
            ) : null}
            <button type="button" disabled={busy || !project?.assets.total} onClick={() => setConfirmRemove(true)}
              className="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--err)] disabled:opacity-40"
              aria-label={t('semanticIndex.removeIndex')}>
              <Trash2 size={12} />
            </button>
          </div>
          <div className="mt-2 flex items-center gap-1 text-[10px] text-[var(--text-faint)]">
            <span>{t('semanticIndex.scope')}</span>
            {(['all', 'folder'] as const).map((value) => (
              <button key={value} type="button" onClick={() => setScope(value)} disabled={value === 'folder' && !folder}
                className={`rounded px-1.5 py-0.5 ${scope === value ? 'bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]' : 'hover:text-[var(--text)]'} disabled:opacity-40`}>
                {t(value === 'all' ? 'semanticIndex.scopeAll' : 'semanticIndex.scopeFolder')}
              </button>
            ))}
            {selectedCount ? (
              <button type="button" onClick={() => setScope('selected')} disabled={!selectedPaths.length}
                className={`rounded px-1.5 py-0.5 ${scope === 'selected' ? 'bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow-sm)]' : 'hover:text-[var(--text)]'} disabled:opacity-40`}>
                {t('semanticIndex.scopeSelected')} ({selectedCount})
              </button>
            ) : null}
          </div>
        </div>

        <div className="mt-3">
          <div className="flex items-center gap-2">
            <span className="text-[10.5px] font-medium text-[var(--text-faint)]">{t('semanticIndex.externalLibraries')}</span>
            <span className="min-w-0 flex-1" />
            <button type="button" disabled={busy} onClick={() => void addLibrary()}
              className="flex h-6 items-center gap-1 rounded px-1.5 text-[10.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40">
              <Plus size={11} />{t('semanticIndex.addExternal')}
            </button>
          </div>
          {status?.libraries?.length ? (
            <div className="mt-1 flex flex-col gap-1">
              {status.libraries.map((library) => (
                <ExternalLibraryRow key={library.id} library={library} busy={busy} working={working}
                  onIndex={() => void run(() => onStartExternal(library.id, { modelId: activeModel, mode: 'update' }))}
                  onRemove={() => void run(() => onRemoveExternal(library.id))} />
              ))}
            </div>
          ) : <p className="mt-1 text-[10px] text-[var(--text-faint)]">{t('semanticIndex.externalHint')}</p>}
        </div>
      </div>

      <ConfirmDialog open={confirmRemove} title={t('semanticIndex.removeIndex')} description={t('semanticIndex.removeIndexConfirm')}
        confirmLabel={t('semanticIndex.removeIndex')} danger
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => { setConfirmRemove(false); void run(onRemove); }} />
    </>
  );
}

function ExternalLibraryRow({ library, busy, working, onIndex, onRemove }: {
  library: SemanticLibrary;
  busy: boolean;
  working: boolean;
  onIndex: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const ready = library.stores?.some((store) => store.state === 'ready');
  const extWorking = library.job?.state === 'queued' || library.job?.state === 'running';
  const indexing = library.stores?.some((store) => store.state === 'indexing') || extWorking;
  return (
    <div className="rounded-md bg-[var(--surface-2)] px-2 py-1.5">
      <div className="flex items-center gap-2">
        <FolderOpen size={11} className={library.offline ? 'text-[var(--text-faint)]' : 'text-[var(--text-muted)]'} />
        <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text)]">{library.name}</span>
        <span className="shrink-0 text-[9.5px] text-[var(--text-faint)]">
          {library.offline ? t('semanticIndex.externalOffline') : `${library.assets?.ready ?? 0}/${library.assets?.total ?? 0}`}
        </span>
        {indexing ? <Loader2 size={11} className="animate-spin text-[var(--text-faint)]" /> : (
          <Tooltip label={t('semanticIndex.externalIndex')} side="top">
            <button type="button" disabled={busy || working || library.offline} onClick={onIndex}
              className="rounded px-1 py-0.5 text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40">
              {ready ? t('semanticIndex.update') : t('semanticIndex.index')}
            </button>
          </Tooltip>
        )}
        <button type="button" disabled={busy || indexing} onClick={onRemove} aria-label={t('semanticIndex.removeLibrary')}
          className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--err)] disabled:opacity-40">
          <Trash2 size={10} />
        </button>
      </div>
      {extWorking ? (
        <div className="mt-1.5">
          <div className="h-0.5 overflow-hidden rounded-full bg-[var(--border)]">
            <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.max(0, Math.min(100, library.job?.progress ?? 0))}%` }} />
          </div>
          <p className="mt-1 text-[9.5px] text-[var(--text-faint)]">{library.job?.message || t('semanticIndex.progress')} · {Math.round(library.job?.progress ?? 0)}%</p>
        </div>
      ) : null}
    </div>
  );
}
