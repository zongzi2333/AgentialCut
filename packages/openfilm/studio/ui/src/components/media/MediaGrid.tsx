/**
 * The library's grid: folder chips, the files in the open folder (or the name-search results), a list view, and the
 * cards themselves. Pictures come from the same MediaPreview and sources the editor's pane uses, so a poster or a
 * waveform here is the one shown there.
 */
import * as React from 'react';
import {
  ArrowUp, Check, Folder, Loader2, MoreHorizontal, UploadCloud,
} from 'lucide-react';
import { useT } from '@/i18n';
import { formatClipDuration, formatFileSize, type MediaSources, type WorkspaceResource } from '@/lib/workspace-resources';
import { MediaPreview } from '../MediaPreview';
import { Tooltip } from '../Tooltip';

export interface Upload { id: string; name: string; ratio: number; done?: boolean }

export function MediaGrid({ items, folders, at, view, searching, selected, primaryPath, sources, usedSrcs, unindexed, uploads, onOpenFolder, onSelect, onOpen, onMenu, onClear, onDropFiles, onDropOnFolder }: {
  items: readonly WorkspaceResource[];
  folders: readonly string[];
  at: string;
  view: 'grid' | 'list';
  searching: boolean;
  selected: ReadonlySet<string>;
  primaryPath: string | null;
  sources: MediaSources;
  usedSrcs: readonly string[];
  /** Visual files the semantic index has not indexed yet. */
  unindexed: ReadonlySet<string>;
  uploads: readonly Upload[];
  onOpenFolder: (rel: string) => void;
  onSelect: (file: WorkspaceResource, event: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void;
  onOpen: (file: WorkspaceResource) => void;
  onMenu: (file: WorkspaceResource, x: number, y: number) => void;
  /** A click on the empty part of the grid lets the selection go. */
  onClear: () => void;
  onDropFiles: (files: File[]) => void;
  onDropOnFolder: (path: string, folder: string) => void;
}) {
  const t = useT();
  const used = React.useMemo(() => new Set(usedSrcs), [usedSrcs]);
  const [dropping, setDropping] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);

  function navigate(event: React.KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const target = event.target as Element | null;
    const card = target?.closest('[data-media-card]');
    if (!card) return;
    const cards = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-media-card]') ?? [])];
    const index = cards.indexOf(card as HTMLElement);
    if (index < 0) return;
    const grid = rootRef.current?.querySelector<HTMLElement>('[data-media-grid]');
    const columns = view === 'grid' && grid
      ? Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length)
      : 1;
    const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -columns : columns;
    const next = cards[index + delta];
    if (!next) return;
    event.preventDefault();
    (next.querySelector<HTMLElement>('button') ?? next).focus();
    const path = next.getAttribute('data-path');
    const file = path ? items.find((item) => item.path === path) : null;
    if (file) onSelect(file, { metaKey: false, ctrlKey: false, shiftKey: false });
  }

  return (
    <div
      ref={rootRef}
      className="relative flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-3 pb-3"
      onKeyDown={navigate}
      onClick={(event) => {
        const target = event.target as Element | null;
        if (target?.closest('article, button, a, input, label, [role="separator"]')) return;
        onClear();
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(event) => { if (event.currentTarget.contains(event.relatedTarget as Node | null)) return; setDropping(false); }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDropping(false);
        onDropFiles([...event.dataTransfer.files]);
      }}
    >
      {!searching && folders.length ? (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {at ? (
            <button type="button" onClick={() => onOpenFolder(at.includes('/') ? at.slice(0, at.lastIndexOf('/')) : '')}
              className="flex h-7 items-center gap-1.5 rounded-md bg-[var(--surface-2)] px-2 text-[11.5px] text-[var(--text-muted)] transition hover:text-[var(--text)]">
              <ArrowUp size={12} aria-hidden />{t('mediaLibrary.upOne')}
            </button>
          ) : null}
          {folders.map((folder) => (
            <button key={folder} type="button" onClick={() => onOpenFolder(folder)}
              onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-openfilm-media')) event.preventDefault(); }}
              onDrop={(event) => {
                const path = event.dataTransfer.getData('application/x-openfilm-media');
                if (!path) return;
                event.preventDefault();
                onDropOnFolder(path, folder);
              }}
              className="flex h-7 items-center gap-1.5 rounded-md bg-[var(--surface-2)] px-2 text-[11.5px] text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
              <Folder size={12} aria-hidden />{folder.split('/').pop()}
            </button>
          ))}
        </div>
      ) : null}

      {uploads.length ? (
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5">
          <span className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]"><UploadCloud size={12} aria-hidden />{t('mediaLibrary.uploading')}</span>
          {uploads.map((upload) => (
            <span key={upload.id} className="flex min-w-0 items-center gap-1.5 text-[10.5px] text-[var(--text-faint)]">
              {upload.done ? <Check size={10} aria-hidden /> : <Loader2 size={10} aria-hidden className="animate-spin" />}
              <span className="max-w-[160px] truncate">{upload.name}</span>
              <span className="tabular-nums">{Math.round(Math.max(0, upload.ratio) * 100)}%</span>
            </span>
          ))}
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
          <UploadCloud size={22} aria-hidden className="text-[var(--text-faint)]" />
          <p className="text-[12.5px] font-medium text-[var(--text-muted)]">{searching ? t('mediaLibrary.noResults') : t('mediaLibrary.empty')}</p>
          <p className="max-w-[360px] text-[11.5px] leading-relaxed text-[var(--text-faint)]">{searching ? t('mediaLibrary.noResultsHint') : t('mediaLibrary.emptyHint')}</p>
        </div>
      ) : view === 'grid' ? (
        <div data-media-grid="" className="grid grid-cols-[repeat(auto-fill,minmax(168px,1fr))] gap-x-2.5 gap-y-3.5">
          {items.map((file) => (
            <Card key={file.path} file={file} selected={selected.has(file.path)} primary={primaryPath === file.path}
              used={used.has(file.path)} unindexed={unindexed.has(file.path)} sources={sources} onSelect={onSelect} onOpen={onOpen} onMenu={onMenu} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-[var(--border-soft)]">
          {items.map((file) => (
            <Row key={file.path} file={file} selected={selected.has(file.path)} primary={primaryPath === file.path}
              used={used.has(file.path)} unindexed={unindexed.has(file.path)} sources={sources} onSelect={onSelect} onOpen={onOpen} onMenu={onMenu} />
          ))}
        </div>
      )}

      {dropping ? (
        <div className="pointer-events-none sticky inset-x-0 bottom-0 z-10 mx-auto mt-2 flex h-9 items-center justify-center rounded-lg border border-dashed border-[var(--text-faint)] bg-[var(--surface)] text-[11.5px] text-[var(--text)]">
          {t('mediaLibrary.dropHere').replace('{folder}', at || 'assets')}
        </div>
      ) : null}
    </div>
  );
}

function kindText(kind: WorkspaceResource['kind'], t: (path: string) => string): string {
  if (kind === 'video') return t('mediaLibrary.kindVideo');
  if (kind === 'image') return t('mediaLibrary.kindImage');
  if (kind === 'audio') return t('mediaLibrary.kindAudio');
  if (kind === 'mg') return t('mediaLibrary.kindPage');
  return t('mediaLibrary.kindOther');
}

function Card({ file, selected, primary, used, unindexed, sources, onSelect, onOpen, onMenu }: {
  file: WorkspaceResource; selected: boolean; primary: boolean; used: boolean; unindexed: boolean; sources: MediaSources;
  onSelect: (file: WorkspaceResource, event: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void;
  onOpen: (file: WorkspaceResource) => void;
  onMenu: (file: WorkspaceResource, x: number, y: number) => void;
}) {
  const t = useT();
  const [hover, setHover] = React.useState(false);
  const [play, setPlay] = React.useState(false);
  React.useEffect(() => {
    if (!hover || file.kind !== 'video') { setPlay(false); return undefined; }
    const id = setTimeout(() => setPlay(true), 380);
    return () => clearTimeout(id);
  }, [hover, file.kind]);

  return (
    <article className="group min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]" data-media-card="" data-path={file.path} tabIndex={-1}>
      <div className="relative">
        <button
          type="button"
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData('application/x-openfilm-media', file.path);
            event.dataTransfer.effectAllowed = 'copyMove';
          }}
          onClick={(event) => onSelect(file, event)}
          onDoubleClick={() => onOpen(file)}
          onContextMenu={(event) => { event.preventDefault(); onMenu(file, event.clientX, event.clientY); }}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          aria-pressed={selected}
          aria-label={file.name}
          className={`relative block aspect-video w-full overflow-hidden rounded-lg bg-[var(--surface-2)] text-left ring-1 transition ${
            primary ? 'ring-2 ring-[var(--accent)]' : selected ? 'ring-1 ring-[var(--accent)]' : 'ring-[var(--border)] hover:ring-[var(--text-faint)]'
          }`}
        >
          {file.kind === 'mg' && sources.pagePoster?.(file) ? (
            <img src={sources.pagePoster(file)} alt="" draggable={false} className="absolute inset-0 h-full w-full object-contain" />
          ) : (
            <MediaPreview file={file} sources={sources} />
          )}
          {play ? (
            <video src={sources.file(file)} muted loop autoPlay playsInline draggable={false} className="absolute inset-0 h-full w-full bg-black object-contain" />
          ) : null}
          {used ? (
            <span className="absolute left-1.5 top-1.5 rounded bg-black/50 px-1 py-[1px] text-[9.5px] leading-4 text-white/90">{t('mediaLibrary.usedShort')}</span>
          ) : null}
          {selected ? (
            <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--on-accent)]">
              <Check size={10} strokeWidth={3} aria-hidden />
            </span>
          ) : null}
          {file.durationMs ? (
            <span className="absolute bottom-1.5 right-1.5 rounded bg-black/45 px-1.5 py-[1px] text-[10px] tabular-nums text-white/90">
              {formatClipDuration(file.durationMs)}
            </span>
          ) : null}
          {unindexed ? (
            <span className="absolute bottom-1.5 left-1.5 rounded bg-black/55 px-1.5 py-[1px] text-[9.5px] leading-4 text-white/85">{t('semanticIndex.unindexedBadge')}</span>
          ) : null}
        </button>
      </div>
      <div className="mt-1.5 flex items-start gap-0.5">
        <button type="button" onClick={(event) => onSelect(file, event)} onDoubleClick={() => onOpen(file)}
          className="min-w-0 flex-1 text-left">
          <p className="truncate text-[11.5px] font-medium text-[var(--text)]">{file.name}</p>
          <p className="mt-0.5 truncate text-[10px] text-[var(--text-faint)]">
            {formatFileSize(file.size)}{file.dir ? ` · ${file.dir}` : ''}
          </p>
        </button>
        <Tooltip label={t('mediaLibrary.more')} side="top">
          <button type="button" aria-label={t('mediaLibrary.more')}
            onClick={(event) => { event.stopPropagation(); const r = event.currentTarget.getBoundingClientRect(); onMenu(file, r.right, r.bottom + 4); }}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-faint)] opacity-0 transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] group-hover:opacity-100">
            <MoreHorizontal size={13} />
          </button>
        </Tooltip>
      </div>
    </article>
  );
}

function Row({ file, selected, primary, used, unindexed, sources, onSelect, onOpen, onMenu }: {
  file: WorkspaceResource; selected: boolean; primary: boolean; used: boolean; unindexed: boolean; sources: MediaSources;
  onSelect: (file: WorkspaceResource, event: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void;
  onOpen: (file: WorkspaceResource) => void;
  onMenu: (file: WorkspaceResource, x: number, y: number) => void;
}) {
  const t = useT();
  return (
    <div data-media-card="" data-path={file.path} tabIndex={-1} className={`group flex items-center gap-2.5 py-2 outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${selected ? 'bg-[var(--bg-hover)]/40' : ''}`}>
      <button type="button" onClick={(event) => onSelect(file, event)} onDoubleClick={() => onOpen(file)}
        onContextMenu={(event) => { event.preventDefault(); onMenu(file, event.clientX, event.clientY); }}
        aria-label={file.name}
        className={`relative block h-[38px] w-[68px] shrink-0 overflow-hidden rounded bg-[var(--surface-2)] ring-1 ${primary ? 'ring-[var(--accent)]' : 'ring-[var(--border)]'}`}>
        <MediaPreview file={file} sources={sources} />
        {used ? <span className="absolute inset-x-0 bottom-0 bg-black/45 text-center text-[8px] text-white/85">{t('mediaLibrary.usedShort')}</span> : null}
      </button>
      <button type="button" onClick={(event) => onSelect(file, event)} onDoubleClick={() => onOpen(file)} className="min-w-0 flex-1 text-left">
        <p className="truncate text-[12px] text-[var(--text)]">{file.name}</p>
        <p className="mt-0.5 truncate text-[10.5px] text-[var(--text-faint)]">
          {kindText(file.kind, t)} · {formatFileSize(file.size)}{file.dir ? ` · ${file.dir}` : ''}
        </p>
      </button>
      <span className="w-[52px] shrink-0 text-right text-[10.5px] tabular-nums text-[var(--text-faint)]">
        {unindexed ? <span className="mr-1 text-[9.5px] text-[var(--warn)]">{t('semanticIndex.unindexedBadge')}</span> : null}
        {file.durationMs ? formatClipDuration(file.durationMs) : '—'}
      </span>
      <button type="button" aria-label={t('mediaLibrary.more')}
        onClick={(event) => { const r = event.currentTarget.getBoundingClientRect(); onMenu(file, r.right, r.bottom + 4); }}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--text-faint)] opacity-0 transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] group-hover:opacity-100">
        <MoreHorizontal size={14} />
      </button>
    </div>
  );
}
