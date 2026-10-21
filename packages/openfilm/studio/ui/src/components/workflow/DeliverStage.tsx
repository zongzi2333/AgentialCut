/**
 * Step 6, deliver: where the film goes, and the way to the export center.
 *
 * The export center already exists and knows every destination, quality and side file; this step is its front door in
 * the workflow, so a person sees the ways a film can leave before opening the detail. Nothing is rendered here: a card
 * opens the export center at its last destination, and the dialog does the work.
 */
import {
  AudioLines, Captions, ChevronRight, Film, FolderArchive, MonitorPlay, PackageCheck, Sparkles,
} from 'lucide-react';
import { useT } from '@/i18n';
import { PANE_BAR, PANE_TITLE } from '../dock-pane-bar';

const DESTS = [
  { id: 'video', icon: Film },
  { id: 'social', icon: MonitorPlay },
  { id: 'gif', icon: Sparkles },
  { id: 'audio', icon: AudioLines },
  { id: 'subtitles', icon: Captions },
  { id: 'project', icon: FolderArchive },
] as const;

export function DeliverStage({ durationMs, onExport }: { durationMs: number; onExport: () => void }) {
  const t = useT();
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]">
      <div className={PANE_BAR}>
        <PackageCheck size={14} aria-hidden className="shrink-0 text-[var(--text-dim)]" />
        <span className={PANE_TITLE}>{t('deliverStage.title')}</span>
        <span className="min-w-0 flex-1" />
        <span className="shrink-0 pr-1 text-[10.5px] text-[var(--text-faint)]">{t('deliverStage.hint')}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
        <div className="mx-auto flex w-full max-w-[940px] flex-col gap-4">
          <p className="max-w-[620px] text-[12.5px] leading-relaxed text-[var(--text-muted)]">{t('deliverStage.intro')}</p>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {DESTS.map((dest) => (
              <button
                key={dest.id}
                type="button"
                onClick={onExport}
                disabled={durationMs <= 0}
                className="group flex min-w-0 items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5 text-left transition hover:border-[var(--border-strong)] disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--bg)] text-[var(--text-muted)]">
                  <dest.icon size={15} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1">
                    <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--text)]">{t(`exportCenter.dest.${dest.id}`)}</span>
                    <ChevronRight size={12} aria-hidden className="shrink-0 text-[var(--text-faint)] transition group-hover:translate-x-0.5" />
                  </span>
                  <span className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-[var(--text-faint)]">{t(`exportCenter.destDesc.${dest.id}`)}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3.5 py-3">
            <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-[var(--text-faint)]">{t('deliverStage.note')}</span>
            <button type="button" onClick={onExport} disabled={durationMs <= 0}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--text)] px-3.5 text-[12.5px] font-medium text-[var(--panel)] transition hover:opacity-90 disabled:pointer-events-none disabled:opacity-40">
              {t('deliverStage.open')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
