/**
 * What the library shows of a file: its picture, its facts, its index state and the few things to do with it.
 *
 * The facts and the preview come from what the editor already has (the listing, the same media sources), so this panel
 * opens without a request. Semantic indexing has no engine yet: its rows and the button are here, off, and say why —
 * they are the place the sidecar will fill.
 */
import type { ReactNode } from 'react';
import {
  Captions, EyeOff, Film, FolderOpen, Image as ImageIcon, ListPlus, Music4, Sparkles, Tag,
} from 'lucide-react';
import { useT } from '@/i18n';
import { useKeyHint } from '@/lib/keymap-store';
import { formatClipDuration, formatFileSize, type MediaSources, type WorkspaceResource } from '@/lib/workspace-resources';
import { AssetFields } from '../ResourceInspector';
import { KIND_ICON } from '../MediaPreview';
import { PANE_BAR, PANE_TITLE } from '../dock-pane-bar';

const BTN = 'inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-lg px-3 text-[12px] font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--text)]/30';
const PRIMARY = `${BTN} bg-[var(--text)] text-[var(--panel)] hover:opacity-90 disabled:pointer-events-none disabled:opacity-40`;
const SECONDARY = `${BTN} text-[var(--text)] ring-1 ring-inset ring-[var(--border-strong)] hover:bg-[var(--bg-hover)] disabled:pointer-events-none disabled:opacity-40`;

export function MediaInspector({ file, selected, used, sources, width, onAdd, onUseInEdit, onReveal, onExtractAudio, onSetCover, onRemove, onReserved }: {
  file: WorkspaceResource | null;
  selected: readonly WorkspaceResource[];
  used: boolean;
  sources: MediaSources;
  width: number;
  onAdd: (files: readonly WorkspaceResource[]) => void;
  onUseInEdit: (file: WorkspaceResource) => void;
  onReveal: (file: WorkspaceResource) => void;
  onExtractAudio: (file: WorkspaceResource) => void;
  onSetCover: (file: WorkspaceResource) => void;
  /** Take the files out of the library's view; the files themselves stay in the project folder. */
  onRemove: (files: readonly WorkspaceResource[]) => void;
  onReserved: (message: string) => void;
}) {
  const t = useT();
  const keyHint = useKeyHint();
  const many = selected.length > 1;
  return (
    <aside style={{ width }} className="flex shrink-0 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]" aria-label={t('mediaLibrary.properties')}>
      <div className={PANE_BAR}>
        <span className={PANE_TITLE}>{many ? t('mediaLibrary.selected').replace('{n}', String(selected.length)) : t('mediaLibrary.properties')}</span>
        <span className="min-w-0 flex-1" />
        {file?.kind === 'mg' ? <span className="shrink-0 text-[10px] text-[var(--text-faint)]">{t('mediaLibrary.page')}</span> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4">
        {!file ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center">
            <Sparkles size={20} aria-hidden className="text-[var(--text-faint)]" />
            <p className="text-[12.5px] font-medium text-[var(--text-muted)]">{t('mediaLibrary.previewEmpty')}</p>
            <p className="text-[11.5px] leading-relaxed text-[var(--text-faint)]">{t('mediaLibrary.previewEmptyHint')}</p>
          </div>
        ) : (
          <>
            <Preview file={file} sources={sources} />
            <div className="mt-3 flex items-start gap-2">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--fill-tsp)] text-[var(--text-muted)]">
                {(() => { const Icon = KIND_ICON[file.kind] ?? KIND_ICON.other; return <Icon size={14} />; })()}
              </span>
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap break-words text-[12.5px] font-medium text-[var(--text)]">{file.name}</p>
                <p className="mt-0.5 break-all text-[10.5px] leading-relaxed text-[var(--text-faint)]">{file.path}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-[var(--text-faint)]">
                  <span>{formatFileSize(file.size)}</span>
                  {file.durationMs ? <span>{formatClipDuration(file.durationMs)}</span> : null}
                  {used ? <span className="text-[var(--accent)]">{t('mediaLibrary.usedInFilm')}</span> : null}
                </p>
              </div>
            </div>

            <div className="mt-3 flex flex-col gap-1.5">
              <button type="button" className={PRIMARY} onClick={() => onAdd(selected.length ? selected : [file])}>
                <ListPlus size={13} aria-hidden />{many ? t('mediaLibrary.batchAdd') : t('mediaLibrary.addToBasket')}
              </button>
              <button type="button" className={SECONDARY} onClick={() => onUseInEdit(file)}>
                <Film size={13} aria-hidden />{t('mediaLibrary.inEdit')}
              </button>
            </div>

            <section className="mt-4 border-t border-[var(--border-soft)] pt-3">
              <h3 className="text-[11px] font-medium text-[var(--text-faint)]">{t('mediaLibrary.facts')}</h3>
              <AssetFields file={file} />
            </section>

            <section className="mt-2 border-t border-[var(--border-soft)] pt-3">
              <div className="flex items-center gap-2">
                <h3 className="text-[11px] font-medium text-[var(--text-faint)]">{t('mediaLibrary.indexSection')}</h3>
                <span className="min-w-0 flex-1" />
                <span className="rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[10px] text-[var(--text-faint)]">{t('mediaLibrary.indexOff')}</span>
              </div>
              <div className="mt-2 flex flex-col gap-1">
                <Engine icon={<ImageIcon size={11} />} label={t('mediaLibrary.engineVisual')} />
                <Engine icon={<Captions size={11} />} label={t('mediaLibrary.engineDialogue')} />
                <Engine icon={<Tag size={11} />} label={t('mediaLibrary.engineTags')} />
              </div>
              <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--text-faint)]">{t('mediaLibrary.indexReserved')}</p>
              <button type="button" disabled className={`${SECONDARY} mt-2`}>{t('mediaLibrary.buildIndex')}</button>
            </section>

            <section className="mt-3 flex flex-wrap gap-1.5 border-t border-[var(--border-soft)] pt-3">
              <Action icon={<FolderOpen size={12} />} label={t('mediaLibrary.reveal')} onClick={() => onReveal(file)} />
              {file.kind === 'video' ? <Action icon={<Music4 size={12} />} label={t('mediaLibrary.extractAudio')} onClick={() => onExtractAudio(file)} /> : null}
              {file.kind === 'image' || file.kind === 'video' || file.kind === 'mg' ? (
                <Action icon={<ImageIcon size={12} />} label={t('mediaLibrary.setCover')} onClick={() => onSetCover(file)} />
              ) : null}
              <Action icon={<EyeOff size={12} />} label={many ? t('mediaLibrary.batchRemove').replace('{n}', String(selected.length)) : t('mediaLibrary.removeFromLibrary')} onClick={() => onRemove(selected.length ? selected : [file])} danger hint={keyHint('remove')} />
              <button type="button" onClick={() => onReserved(t('mediaLibrary.indexReserved'))}
                className="flex h-7 items-center rounded-md px-2 text-[11px] text-[var(--text-faint)] ring-1 ring-inset ring-[var(--border)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-muted)]">
                {t('mediaLibrary.reindex')}
              </button>
            </section>
            {many ? <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--text-faint)]">{t('mediaLibrary.multiHint')}</p> : null}
          </>
        )}
      </div>
    </aside>
  );
}

function Preview({ file, sources }: { file: WorkspaceResource; sources: MediaSources }) {
  const t = useT();
  if (file.kind === 'video') {
    return (
      <video
        key={file.path}
        src={sources.file(file)}
        poster={sources.poster?.(file)}
        controls
        preload="metadata"
        playsInline
        aria-label={t('mediaLibrary.preview')}
        className="aspect-video w-full rounded-lg bg-black object-contain"
      />
    );
  }
  if (file.kind === 'image') {
    return <img key={file.path} src={sources.file(file)} alt="" className="aspect-video w-full rounded-lg bg-black object-contain" />;
  }
  if (file.kind === 'mg') {
    const poster = sources.pagePoster?.(file);
    return (
      <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-2)]">
        {poster ? <img src={poster} alt="" className="h-full w-full object-contain" /> : <Film size={22} aria-hidden className="text-[var(--text-faint)]" />}
      </div>
    );
  }
  if (file.kind === 'audio') {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
        <span className="flex items-center gap-2 text-[11.5px] text-[var(--text-muted)]"><Music4 size={14} aria-hidden />{file.name}</span>
        <audio controls preload="metadata" src={sources.file(file)} aria-label={t('mediaLibrary.preview')} className="w-full" />
      </div>
    );
  }
  return (
    <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-faint)]">
      <KIND_ICON.other size={22} aria-hidden />
    </div>
  );
}

function Engine({ icon, label }: { icon: ReactNode; label: string }) {
  const t = useT();
  return (
    <div className="flex h-7 items-center gap-2 rounded-md bg-[var(--surface-2)] px-2 text-[11.5px]">
      <span aria-hidden className="text-[var(--text-faint)]">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[var(--text-muted)]">{label}</span>
      <span className="text-[10px] text-[var(--text-faint)]">{t('mediaLibrary.indexOff')}</span>
    </div>
  );
}

function Action({ icon, label, onClick, danger, hint }: { icon: ReactNode; label: string; onClick: () => void; danger?: boolean; hint?: string }) {
  return (
    <button type="button" onClick={onClick} title={hint ? `${label} (${hint})` : undefined}
      className={`flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] ring-1 ring-inset ring-[var(--border)] transition hover:bg-[var(--bg-hover)] ${danger ? 'text-[var(--err)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
      {icon}{label}
    </button>
  );
}
