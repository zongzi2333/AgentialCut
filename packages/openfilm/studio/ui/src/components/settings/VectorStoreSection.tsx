/**
 * Settings → Vector stores: one card per store, with the encoding model, width, unit counts and the folder its
 * catalog and Lance tables live in. A store belongs to one library and one model; the model and width are facts of
 * the vectors already written, so changing the model builds another store (the old one stays searchable until the
 * person deletes it), and deleting a store removes only its vectors, never media.
 */
import React from 'react';
import { Check, Database, HardDrive, Loader2, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import { useT } from '@/i18n';
import { useSemanticIndex } from '@/components/media/use-semantic-index';
import { MenuSelect } from '@/components/MenuSelect';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import type { SemanticLibrary, SemanticModel, SemanticStore } from '@/api';
import { SettingsButton, SettingsGroup, SettingsItem, SettingsPage, settingsError } from './ui';

export function VectorStoreSection({ projectId }: { projectId: string }) {
  const t = useT();
  const semantic = useSemanticIndex(projectId);
  const project = semantic.status?.project ?? null;
  const libraries = semantic.status?.libraries ?? [];
  const models = semantic.status?.models ?? [];
  const sidecar = semantic.status?.sidecar;
  const [restarting, setRestarting] = React.useState(false);
  const [deleting, setDeleting] = React.useState<{ library: SemanticLibrary; store: SemanticStore } | null>(null);
  const [working, setWorking] = React.useState<string | null>(null);

  const restart = async () => {
    setRestarting(true);
    try { await semantic.restart(); } finally { setRestarting(false); }
  };
  const rebuild = async (library: SemanticLibrary, store: SemanticStore, modelId: string) => {
    setWorking(store.id);
    try {
      const mode = modelId === store.modelId ? 'rebuild' : 'new';
      if (library.kind === 'project') await semantic.start({ modelId, mode });
      else await semantic.startExternal(library.id, { modelId, mode });
    } finally {
      setWorking(null);
    }
  };
  const remove = async () => {
    const going = deleting;
    setDeleting(null);
    if (going) await semantic.removeStore(going.library.id, going.store.id);
  };

  return (
    <SettingsPage note={t('settings.vectorStore.desc')}>
      <SettingsGroup title={t('settings.vectorStore.service')}>
        <SettingsItem
          title={t('settings.vectorStore.state')}
          description={(
            <div className="flex flex-col gap-1 text-[12.5px] leading-relaxed">
              <span>{sidecar?.reason || (sidecar?.state === 'ready' ? t('semanticIndex.sidecarReady') : sidecar?.state === 'starting' ? t('semanticIndex.sidecarStarting') : t('semanticIndex.sidecarOff'))}</span>
              {sidecar ? (
                <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11.5px] text-[var(--text-faint)]">
                  {sidecar.version ? <><span>{t('settings.vectorStore.version')}</span><span className="font-mono">{sidecar.version}</span></> : null}
                  {sidecar.device ? <><span>{t('settings.vectorStore.device')}</span><span>{sidecar.device}</span></> : null}
                  {sidecar.models != null ? <><span>{t('settings.vectorStore.models')}</span><span className="tabular-nums">{sidecar.models}</span></> : null}
                  {sidecar.port ? <><span>{t('settings.vectorStore.port')}</span><span className="font-mono">{sidecar.port}</span></> : null}
                  {sidecar.python ? <><span>{t('settings.vectorStore.python')}</span><span className="min-w-0 truncate font-mono" title={sidecar.python}>{sidecar.python}</span></> : null}
                  {sidecar.modelsRoot ? <><span>{t('settings.vectorStore.modelsRoot')}</span><span className="min-w-0 truncate font-mono" title={sidecar.modelsRoot}>{sidecar.modelsRoot}</span></> : null}
                </div>
              ) : null}
            </div>
          )}
          control={<SettingsButton disabled={restarting} onClick={() => void restart()}><RefreshCw size={13} className={restarting ? 'animate-spin' : ''} />{t('settings.vectorStore.restart')}</SettingsButton>}
        />
        {semantic.error ? <p className={`px-1 py-2 ${settingsError}`} role="alert">{semantic.error}</p> : null}
      </SettingsGroup>

      {project ? (
        <SettingsGroup title={t('settings.vectorStore.project')}>
          <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-[var(--text-muted)]">
              <span className="font-medium text-[var(--text)]">{project.name}</span>
              <span>{t('settings.vectorStore.assets').replace('{ready}', String(project.assets.ready)).replace('{total}', String(project.assets.total))}</span>
              {project.assets.missing ? <span className="text-[var(--warn)]">{t('semanticIndex.assetsMissing').replace('{n}', String(project.assets.missing))}</span> : null}
              <span className="flex min-w-0 items-center gap-1 text-[11.5px]"><HardDrive size={12} /><span className="truncate font-mono" title={project.indexRoot}>{project.indexRoot}</span></span>
            </div>
            <StoreCards library={project} models={models} working={working} onRebuild={rebuild} onDelete={(library, store) => setDeleting({ library, store })} />
          </div>
        </SettingsGroup>
      ) : null}

      {libraries.length ? (
        <SettingsGroup title={t('settings.vectorStore.external')}>
          {libraries.map((library) => (
            <div key={library.id} className="rounded-[10px] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-[var(--text-muted)]">
                <span className="font-medium text-[var(--text)]">{library.name}</span>
                <span>{t('settings.vectorStore.assets').replace('{ready}', String(library.assets?.ready ?? 0)).replace('{total}', String(library.assets?.total ?? 0))}</span>
                {library.assets?.missing ? <span className="text-[var(--warn)]">{t('semanticIndex.assetsMissing').replace('{n}', String(library.assets.missing))}</span> : null}
                <span className="flex min-w-0 items-center gap-1 text-[11.5px]"><HardDrive size={12} /><span className="truncate font-mono" title={library.indexRoot}>{library.indexRoot}</span></span>
                {library.offline ? <span className="text-[10.5px] text-[var(--warn)]">{t('semanticIndex.externalOffline')}</span> : null}
              </div>
              <StoreCards library={library} models={models} working={working} onRebuild={rebuild} onDelete={(target, store) => setDeleting({ library: target, store })} />
            </div>
          ))}
        </SettingsGroup>
      ) : null}

      {!project && sidecar?.state === 'ready' ? (
        <p className="text-[13px] text-[var(--text-faint)]">{t('settings.vectorStore.noProject')}</p>
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        title={t('settings.vectorStore.deleteTitle')}
        description={t('settings.vectorStore.deleteDesc').replace('{model}', deleting?.store.modelId ?? '')}
        confirmLabel={t('settings.vectorStore.delete')}
        cancelLabel={t('settings.vectorStore.cancel')}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => void remove()}
      />
    </SettingsPage>
  );
}

function StoreCards({ library, models, working, onRebuild, onDelete }: {
  library: SemanticLibrary;
  models: SemanticModel[];
  working: string | null;
  onRebuild: (library: SemanticLibrary, store: SemanticStore, modelId: string) => Promise<void>;
  onDelete: (library: SemanticLibrary, store: SemanticStore) => void;
}) {
  const t = useT();
  if (!library.stores?.length) {
    return <p className="mt-2 text-[11.5px] text-[var(--text-faint)]">{t('settings.vectorStore.none')}</p>;
  }
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
      {library.stores.map((store) => (
        <StoreCard key={store.id} library={library} store={store} models={models} busy={working === store.id}
          onRebuild={onRebuild} onDelete={onDelete} />
      ))}
    </div>
  );
}

function StoreCard({ library, store, models, busy, onRebuild, onDelete }: {
  library: SemanticLibrary;
  store: SemanticStore;
  models: SemanticModel[];
  busy: boolean;
  onRebuild: (library: SemanticLibrary, store: SemanticStore, modelId: string) => Promise<void>;
  onDelete: (library: SemanticLibrary, store: SemanticStore) => void;
}) {
  const t = useT();
  const model = models.find((candidate) => candidate.id === store.modelId);
  const [choice, setChoice] = React.useState(store.modelId);
  React.useEffect(() => { setChoice(store.modelId); }, [store.modelId]);
  const ready = store.state === 'ready' || store.state === 'partial';
  const path = `${library.indexRoot.replace(/[\\/]+$/, '')}${library.indexRoot.includes('\\') ? '\\' : '/'}stores${library.indexRoot.includes('\\') ? '\\' : '/'}${store.id}`;
  const disabled = busy || store.state === 'indexing' || store.state === 'queued';
  return (
    <article className="min-w-0 rounded-[8px] border border-[var(--border)] bg-[var(--surface)] p-2.5">
      <div className="flex items-center gap-1.5">
        <Database size={13} className="shrink-0 text-[var(--text-muted)]" />
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-[var(--text)]" title={store.modelId}>{model?.name ?? store.modelId}</span>
        {ready ? <Check size={12} className="shrink-0 text-[var(--accent)]" /> : store.state === 'indexing' ? <Loader2 size={12} className="shrink-0 animate-spin text-[var(--text-faint)]" /> : null}
      </div>
      <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[10.5px] text-[var(--text-faint)]">
        <span>{t('settings.vectorStore.encodingModel')}</span><span className="truncate text-right text-[var(--text-muted)]" title={store.modelId}>{model?.name ?? store.modelId}</span>
        <span>{t('settings.vectorStore.dimension')}</span><span className="text-right tabular-nums text-[var(--text-muted)]">{store.dimension ?? '—'}</span>
        <span>{t('settings.vectorStore.frames')}</span><span className="text-right tabular-nums text-[var(--text-muted)]">{store.frames}</span>
        <span>{t('settings.vectorStore.chunks')}</span><span className="text-right tabular-nums text-[var(--text-muted)]">{store.chunks}</span>
        <span>{t('settings.vectorStore.stateLabel')}</span><span className="text-right text-[var(--text-muted)]">{t(`settings.vectorStore.storeState.${store.state}`)}</span>
      </div>
      <div className="mt-2 flex min-w-0 items-start gap-1 text-[9.5px] text-[var(--text-faint)]" title={path}>
        <HardDrive size={10} className="mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1 break-all font-mono leading-snug">{path}</span>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <MenuSelect
          label={t('settings.vectorStore.changeModel')}
          value={choice}
          groups={[{ choices: models.map((candidate) => ({ value: candidate.id, label: candidate.name })) }]}
          onPick={setChoice}
          disabled={disabled || !models.length}
          className="min-w-0 flex-1"
        />
        <SettingsButton className="h-7 px-2 text-[11px]" disabled={disabled || !choice} onClick={() => void onRebuild(library, store, choice)} title={t('settings.vectorStore.rebuild')} aria-label={t('settings.vectorStore.rebuild')}>
          <RotateCcw size={12} />
        </SettingsButton>
        <SettingsButton className="h-7 px-2 text-[11px]" disabled={disabled} onClick={() => onDelete(library, store)} title={t('settings.vectorStore.delete')} aria-label={t('settings.vectorStore.delete')}>
          <Trash2 size={12} />
        </SettingsButton>
      </div>
    </article>
  );
}
