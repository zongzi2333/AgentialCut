/**
 * The contextual shelf under the storyboard: library, basket, the selected shot's candidates, and gaps.
 *
 * A shelf is not a second media page. It keeps the four things a storyboard needs in reach: files to
 * drag into a card, shots set aside, several candidates for the current card, and the cards still
 * missing a clip. Candidate cards carry the source range, score and evidence entry point.
 */
import * as React from 'react';
import { Film, Image as ImageIcon, Loader2, Search, Sparkles, X } from 'lucide-react';
import { useT } from '@/i18n';
import { formatClipDuration, type MediaSources, type WorkspaceResource } from '@/lib/workspace-resources';
import { sourceTime } from './time';
import type { StoryboardCandidate, StoryboardDocument, StoryboardShot } from '@/api';
import type { BasketItem } from '../../media/basket';
import { PANE_BAR } from '../../dock-pane-bar';

export type ShelfTab = 'library' | 'basket' | 'candidates' | 'gaps';

export function MaterialShelf({
  files,
  sources,
  doc,
  shot,
  tab,
  onTab,
  basket,
  onAddBasket,
  onRemoveBasket,
  onSelectShot,
  onAdopt,
  onMatch,
  matching,
  onPreview,
  onPreviewFile,
}: {
  files: readonly WorkspaceResource[];
  sources: MediaSources;
  doc: StoryboardDocument;
  shot: StoryboardShot | null;
  tab: ShelfTab;
  onTab: (tab: ShelfTab) => void;
  basket: readonly BasketItem[];
  onAddBasket: (file: WorkspaceResource) => void;
  onRemoveBasket: (item: BasketItem) => void;
  onSelectShot: (id: string) => void;
  onAdopt: (candidate: StoryboardCandidate) => void;
  onMatch: () => void;
  matching: boolean;
  onPreview: (candidate: StoryboardCandidate) => void;
  onPreviewFile: (file: WorkspaceResource) => void;
}) {
  const t = useT();
  const [query, setQuery] = React.useState('');
  const [kind, setKind] = React.useState<'all' | 'video' | 'image'>('all');
  const candidates = shot?.match.candidates ?? [];
  const gaps = doc.shots.filter((item) => item.match.state === 'gap' || !item.match.selectedId);
  const visible = files.filter((file) => {
    if (file.kind !== 'video' && file.kind !== 'image' && file.kind !== 'mg') return false;
    if (kind !== 'all' && file.kind !== kind) return false;
    const needle = query.trim().toLowerCase();
    return !needle || file.name.toLowerCase().includes(needle) || file.path.toLowerCase().includes(needle);
  });
  const tabButton = (id: ShelfTab, label: string, count?: number) => (
    <button key={id} type="button" onClick={() => onTab(id)} aria-selected={tab === id} role="tab"
      className={`flex h-[26px] items-center gap-1.5 rounded-md px-2 text-[11.5px] transition ${tab === id ? 'bg-[var(--surface-3)] text-[var(--text)]' : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]'}`}>
      {label}
      {count != null ? <span className="tabular-nums text-[10px] text-[var(--text-faint)]">{count}</span> : null}
    </button>
  );

  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-[7px] border border-[var(--border)] bg-[var(--dock-pane)]" aria-label={t('storyboard.title')}>
      <div className={`${PANE_BAR} border-b border-[var(--border-soft)]`}>
        <div role="tablist" aria-label={t('storyboard.title')} className="flex min-w-0 items-center gap-0.5">
          {tabButton('library', t('storyboard.library'), files.length)}
          {tabButton('basket', t('storyboard.basket'), basket.length)}
          {tabButton('candidates', shot ? `${t('storyboard.candidates')} · ${shot.title}` : t('storyboard.candidates'), candidates.length)}
          {tabButton('gaps', t('storyboard.gapTab'), gaps.length)}
        </div>
        <span className="min-w-0 flex-1" />
        {tab === 'library' ? (
          <>
            <label className="flex h-[25px] w-[170px] items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 text-[10.5px] text-[var(--text-faint)]">
              <Search size={11} aria-hidden />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('storyboard.search')} aria-label={t('storyboard.search')}
                className="min-w-0 flex-1 bg-transparent text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]" />
            </label>
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label={t('storyboard.filter')}
              className="h-[25px] rounded-md border border-[var(--border)] bg-[var(--bg)] px-1.5 text-[10.5px] text-[var(--text-muted)] outline-none">
              <option value="all">{t('storyboard.all')}</option><option value="video">Video</option><option value="image">Image</option>
            </select>
          </>
        ) : null}
        {tab === 'candidates' && shot ? (
          <button type="button" onClick={onMatch} disabled={matching || shot.locked}
            className="flex h-[25px] items-center gap-1 rounded-md px-2 text-[10.5px] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40">
            {matching ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />}
            {shot.locked ? t('storyboard.locked') : t('storyboard.rematch')}
          </button>
        ) : null}
      </div>

      <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-[repeat(auto-fill,minmax(148px,1fr))] content-start gap-2 overflow-y-auto overscroll-contain px-3 py-2">
        {tab === 'library' ? (visible.length ? visible.map((file) => <FileCard key={file.path} file={file} sources={sources} onAdd={() => onAddBasket(file)} onPreview={() => onPreviewFile(file)} />) : <ShelfEmpty text={t('storyboard.libraryEmpty')} />) : null}
        {tab === 'basket' && !basket.length ? <ShelfEmpty text={t('storyboard.noSelection')} /> : null}
        {tab === 'basket' ? basket.map((item) => (
          <div key={`${item.path}:${item.startMs}:${item.endMs}`} draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('application/x-openfilm-shot', JSON.stringify({ path: item.path, startMs: item.startMs, endMs: item.endMs }));
              event.dataTransfer.effectAllowed = 'copy';
            }}
            className="flex min-w-0 cursor-grab flex-col gap-1 active:cursor-grabbing">
            <div className="flex h-[70px] items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-faint)]">
              <Film size={17} aria-hidden />
            </div>
            <div className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--text)]" title={item.name}>{item.name}</span>
              <button type="button" aria-label={t('mediaLibrary.removeFromBasket')} onClick={() => onRemoveBasket(item)}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
                <X size={11} />
              </button>
            </div>
            <span className="truncate text-[9.5px] tabular-nums text-[var(--text-faint)]">
              {item.startMs > 0 || item.endMs > 0 ? `${sourceTime(item.startMs)} – ${sourceTime(item.endMs)}` : t('storyboard.shot')}
            </span>
          </div>
        )) : null}
        {tab === 'candidates' ? (
          shot ? (
            candidates.length ? candidates.map((candidate) => (
              <CandidateCard key={candidate.id} candidate={candidate} adopted={shot.match.selectedId === candidate.id} onAdopt={() => onAdopt(candidate)} onPreview={() => onPreview(candidate)} />
            )) : (
              <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 text-center">
                <Sparkles size={18} className="text-[var(--text-faint)]" />
                <span className="text-[11.5px] text-[var(--text-muted)]">{t('storyboard.candidateEmpty')}</span>
                <span className="text-[10.5px] text-[var(--text-faint)]">{t('storyboard.candidateHint')}</span>
              </div>
            )
          ) : <ShelfEmpty text={t('storyboard.candidateHint')} />
        ) : null}
        {tab === 'gaps' ? (
          gaps.length ? gaps.map((item) => (
            <button key={item.id} type="button" onClick={() => onSelectShot(item.id)}
              className="flex min-w-0 flex-col gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-2 text-left transition hover:border-[var(--border-strong)]">
              <span className="flex items-center gap-1.5 text-[10px] tabular-nums text-[var(--warn)]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--warn)]" />{String(item.order + 1).padStart(2, '0')}</span>
              <span className="truncate text-[11px] text-[var(--text)]">{item.title}</span>
              <span className="truncate text-[10px] text-[var(--text-faint)]">{item.match.error || t('storyboard.gap')}</span>
            </button>
          )) : <ShelfEmpty text={t('storyboard.noSelection')} />
        ) : null}
      </div>
    </section>
  );
}

function FileCard({ file, sources, onAdd, onPreview }: { file: WorkspaceResource; sources: MediaSources; onAdd: () => void; onPreview: () => void }) {
  const t = useT();
  const poster = file.kind === 'video' ? sources.poster?.(file) : file.kind === 'mg' ? sources.pagePoster?.(file) : sources.file(file);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button type="button" onClick={onPreview} onDoubleClick={onPreview}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData('application/x-openfilm-media', file.path);
          event.dataTransfer.effectAllowed = 'copyMove';
        }}
        className="group relative h-[70px] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-2)] transition hover:border-[var(--border-strong)]">
        {poster ? <img src={poster} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" /> : (
          <span className="flex h-full items-center justify-center text-[var(--text-faint)]">{file.kind === 'video' ? <Film size={16} /> : <ImageIcon size={16} />}</span>
        )}
        <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-4 text-[9px] tabular-nums text-white/85">
          {file.durationMs ? formatClipDuration(file.durationMs) : ''}
        </span>
      </button>
      <button type="button" onClick={onAdd} className="min-w-0 text-left">
        <span className="block truncate text-[10.5px] text-[var(--text)]" title={file.name}>{file.name}</span>
        <span className="block truncate text-[9.5px] text-[var(--text-faint)]">{file.kind === 'video' ? 'Video' : file.kind === 'image' ? 'Image' : 'Page'}{file.size ? ` · ${Math.round(file.size / 1024)} KB` : ''}</span>
      </button>
      <button type="button" onClick={onAdd} className="h-[18px] rounded border border-[var(--border)] text-[9px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">{t('storyboard.basket')}</button>
    </div>
  );
}

function CandidateCard({ candidate, adopted, onAdopt, onPreview }: { candidate: StoryboardCandidate; adopted: boolean; onAdopt: () => void; onPreview: () => void }) {
  const t = useT();
  const score = Math.round(Math.max(0, Math.min(1, candidate.review?.confidence ?? candidate.score)) * 100);
  const low = score < 55;
  const bad = score < 35;
  return (
    <div className={`flex min-w-0 flex-col gap-1 rounded-md border p-1 ${adopted ? (low ? 'border-[rgba(255,191,54,.55)] bg-[rgba(255,191,54,.06)]' : 'border-[var(--accent)] bg-[var(--accent-soft)]') : low ? (bad ? 'border-[rgba(235,77,77,.45)]' : 'border-[rgba(255,191,54,.4)]') : 'border-[var(--border)]'}`}>
      <button type="button" onClick={onPreview} onDoubleClick={onPreview} className="relative h-[68px] overflow-hidden rounded-sm bg-[var(--surface-2)] text-left">
        {candidate.thumbUrl ? <img src={candidate.thumbUrl} alt="" loading="lazy" draggable={false} className="absolute inset-0 h-full w-full object-cover" /> : <span className="flex h-full items-center justify-center text-[var(--text-faint)]"><Film size={16} /></span>}
        <span className={`absolute right-1 top-1 rounded px-1 py-0.5 text-[9px] tabular-nums ${bad ? 'bg-[#7a2828]/85 text-white' : low ? 'bg-[#6b501d]/85 text-white' : 'bg-black/45 text-white/90'}`}>{score}%</span>
      </button>
      <span className="truncate text-[10px] text-[var(--text)]" title={candidate.name}>{candidate.name}</span>
      <span className="truncate text-[9.5px] tabular-nums text-[var(--text-faint)]">{sourceTime(candidate.startMs)} – {sourceTime(candidate.endMs)}</span>
      <span className={`truncate text-[9.5px] ${bad ? 'text-[#ff8585]' : low ? 'text-[var(--warn)]' : 'text-[var(--text-faint)]'}`} title={candidate.review?.reason}>
        {adopted ? `${t('storyboard.adopted')} · ${score}%` : t('storyboard.confidence').replace('{n}', String(score))}
        {candidate.review ? ` · ${candidate.review.verdict === 'pass' ? '通过' : candidate.review.verdict === 'fail' ? '不通过' : '待确认'}` : ''}
      </span>
      <button type="button" onClick={onAdopt} className={`h-[20px] rounded text-[9.5px] transition ${adopted ? 'bg-[var(--text)] text-[var(--panel)]' : 'border border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]'}`}>{adopted ? t('storyboard.adopted') : t('storyboard.adopt')}</button>
    </div>
  );
}

function ShelfEmpty({ text }: { text: string }) {
  return <div className="flex min-w-0 flex-1 items-center justify-center text-[11px] text-[var(--text-faint)]">{text}</div>;
}
