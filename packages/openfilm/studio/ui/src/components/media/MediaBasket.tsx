/**
 * The basket: shots set aside in the media library, waiting to be used together.
 *
 * Its bar sits at the top of the tray (the count and the two things one does with the shots); the shots themselves lie
 * under it, in the order collected, and wrap as the tray is made taller. "Add to timeline" appends each shot to the end
 * of its track, in order; "Export shots" saves the source files while the basket holds whole files.
 */
import { ArrowRight, Download, Trash2, X } from 'lucide-react';
import { useT } from '@/i18n';
import { formatClipDuration } from '@/lib/workspace-resources';
import type { MediaSources, WorkspaceResource } from '@/lib/workspace-resources';
import { KIND_ICON } from '../MediaPreview';
import type { BasketItem } from './basket';

export function MediaBasket({ items, sources, fileOf, busy = false, onAddToTimeline, onExport, onRemove, onClear }: {
  items: readonly BasketItem[];
  sources: MediaSources;
  /** The file in the listing, for its poster (a basket item only keeps what it needs to be used). */
  fileOf: (path: string) => WorkspaceResource | null;
  /** An addition to the timeline is on its way; the bar waits rather than queueing it twice. */
  busy?: boolean;
  onAddToTimeline: () => void;
  onExport: () => void;
  onRemove: (item: BasketItem) => void;
  onClear: () => void;
}) {
  const t = useT();
  const empty = items.length === 0;
  return (
    <div className="flex h-full flex-col">
      {/* the tray's own bar: what it holds, and what can be done with it */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border-soft)] px-3">
        <span className="flex shrink-0 items-center gap-1.5 text-[11.5px] font-medium text-[var(--text)]">
          <span className="text-[var(--text-muted)]">{t('mediaLibrary.basket')}</span>
          <span className="tabular-nums text-[var(--text-faint)]">{t('mediaLibrary.basketItems').replace('{n}', String(items.length))}</span>
        </span>
        <span className="min-w-0 flex-1" />
        <button type="button" disabled={empty || busy} onClick={onAddToTimeline}
          className="flex h-6 shrink-0 items-center gap-1 rounded-md bg-[var(--text)] px-2 text-[11px] font-medium text-[var(--panel)] transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-40">
          {t('mediaLibrary.basketTimeline')}<ArrowRight size={11} aria-hidden />
        </button>
        <button type="button" disabled={empty} onClick={onExport}
          className="flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:pointer-events-none disabled:opacity-40">
          <Download size={11} aria-hidden />{t('mediaLibrary.basketExport')}
        </button>
        <button type="button" aria-label={t('mediaLibrary.basketClear')} disabled={empty} onClick={onClear}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-faint)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:pointer-events-none disabled:opacity-40">
          <Trash2 size={12} />
        </button>
      </div>

      {/* the shots, under the bar */}
      <div className="flex min-h-0 flex-1 flex-wrap content-start items-start gap-1.5 overflow-y-auto px-3 py-1.5">
        {empty ? (
          <span className="self-center truncate text-[11px] text-[var(--text-faint)]">{t('mediaLibrary.basketEmpty')}</span>
        ) : items.map((item) => {
          const Icon = KIND_ICON[item.kind] ?? KIND_ICON.other;
          const file = fileOf(item.path);
          const poster = file ? (file.kind === 'video' ? sources.poster?.(file) : file.kind === 'mg' ? sources.pagePoster?.(file) : file.kind === 'image' ? sources.file(file) : undefined) : undefined;
          return (
            <span key={`${item.path}:${item.startMs}:${item.endMs}`} className="group relative flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-2)] py-1 pl-1 pr-1.5">
              <span className="relative flex h-8 w-[52px] shrink-0 items-center justify-center overflow-hidden rounded-sm bg-[var(--bg)] text-[var(--text-faint)]">
                {poster ? <img src={poster} alt="" className="absolute inset-0 h-full w-full object-cover" /> : <Icon size={13} aria-hidden />}
              </span>
              <span className="flex max-w-[150px] min-w-0 flex-col">
                <span className="truncate text-[11px] text-[var(--text)]">{item.name}</span>
                <span className="text-[10px] tabular-nums text-[var(--text-faint)]">
                  {item.kind === 'video' || item.kind === 'audio'
                    ? item.startMs > 0 ? `${formatClipDuration(item.startMs)}–${formatClipDuration(item.endMs)}` : formatClipDuration(item.endMs)
                    : item.endMs > item.startMs ? `${formatClipDuration(item.startMs)}–${formatClipDuration(item.endMs)}` : '—'}
                </span>
              </span>
              <button type="button" aria-label={t('mediaLibrary.removeFromBasket')} onClick={() => onRemove(item)}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-faint)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
                <X size={12} />
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}
