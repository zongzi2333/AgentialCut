/**
 * Semantic search results: the shots the index found, with the time range and the model/library
 * that found them. They are not files: several shots can belong to one source.
 */
import * as React from 'react';
import { Film, ImageOff, Loader2 } from 'lucide-react';
import type { SemanticHit } from '@/api';
import { useT } from '@/i18n';
import { formatClipDuration } from '@/lib/workspace-resources';

export function MediaSearchResults({ hits, meta, searching, error, selected, onSelect, onOpen }: {
  hits: readonly SemanticHit[];
  meta: { returned: number; elapsedMs: number; mode: string; degraded?: string } | null;
  searching: boolean;
  error: string;
  selected: string | null;
  onSelect: (hit: SemanticHit) => void;
  onOpen: (hit: SemanticHit) => void;
}) {
  const t = useT();
  const [broken, setBroken] = React.useState<Set<string>>(new Set());
  const keyOf = (hit: SemanticHit) => `${hit.assetId}:${hit.startMs}:${hit.endMs}:${hit.storeId}`;
  const timeOf = (ms: number) => (ms > 0 ? formatClipDuration(ms) : '0:00');

  if (searching) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[12px] text-[var(--text-faint)]">
        <Loader2 size={15} className="animate-spin" />{t('semanticIndex.searching')}
      </div>
    );
  }
  if (error) {
    return <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-[12px] text-[var(--err)]">{error}</div>;
  }
  if (!hits.length) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <Film size={22} className="text-[var(--text-faint)]" />
        <p className="text-[12.5px] font-medium text-[var(--text-muted)]">{t('semanticIndex.resultsEmpty')}</p>
        <p className="max-w-[380px] text-[11.5px] leading-relaxed text-[var(--text-faint)]">{t('semanticIndex.resultsEmptyHint')}</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">
      <div className="flex h-8 shrink-0 items-center gap-2 text-[10.5px] text-[var(--text-faint)]">
        <span>{t('semanticIndex.results')}</span>
        <span className="tabular-nums">{t('semanticIndex.resultCount').replace('{n}', String(meta?.returned ?? hits.length))}</span>
        <span className="min-w-0 flex-1" />
        <span>{meta?.mode === 'frame' ? 'Frame' : 'Shot'} · {meta?.elapsedMs ?? 0} ms</span>
      </div>
      {meta?.degraded ? <p className="mb-2 text-[10.5px] text-[var(--warn)]">{meta.degraded}</p> : null}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(184px,1fr))] gap-x-2.5 gap-y-3.5">
        {hits.map((hit) => {
          const key = keyOf(hit);
          const active = selected === key;
          return (
            <article key={key} className="group min-w-0">
              <button type="button" onClick={() => onSelect(hit)} onDoubleClick={() => onOpen(hit)}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData('application/x-openfilm-shot', JSON.stringify({ path: hit.path, startMs: hit.startMs, endMs: hit.endMs }));
                  event.dataTransfer.effectAllowed = 'copy';
                }}
                aria-pressed={active} aria-label={`${hit.name} ${timeOf(hit.startMs)}`}
                className={`relative block aspect-video w-full overflow-hidden rounded-lg bg-[var(--surface-2)] text-left ring-1 transition ${active ? 'ring-2 ring-[var(--accent)]' : 'ring-[var(--border)] hover:ring-[var(--text-faint)]'}`}>
                {broken.has(key) ? <span className="flex h-full items-center justify-center text-[var(--text-faint)]"><ImageOff size={18} /></span> : (
                  <img src={hit.thumbUrl} alt="" loading="lazy" draggable={false}
                    onError={() => setBroken((cur) => new Set(cur).add(key))}
                    className="absolute inset-0 h-full w-full object-cover" />
                )}
                <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-4 text-[10px] tabular-nums text-white/90">
                  <span>{timeOf(hit.startMs)}</span>
                  <span className="text-white/50">–</span>
                  <span>{timeOf(hit.endMs)}</span>
                  <span className="ml-auto rounded bg-black/45 px-1 text-[9.5px]">{Math.round(hit.score * 100)}%</span>
                </span>
              </button>
              <button type="button" onClick={() => onSelect(hit)} className="mt-1.5 block w-full text-left">
                <p className="truncate text-[11.5px] font-medium text-[var(--text)]">{hit.name}</p>
                <p className="mt-0.5 flex min-w-0 items-center gap-1 truncate text-[10px] text-[var(--text-faint)]">
                  <span className="truncate">{hit.libraryName}</span>
                  <span className="text-[var(--border-strong)]">·</span>
                  <span className="truncate">{hit.modelId}</span>
                </p>
              </button>
            </article>
          );
        })}
      </div>
    </div>
  );
}
