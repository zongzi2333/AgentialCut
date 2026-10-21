/**
 * Step 1, the project: what this film is before anyone touches it.
 *
 * A poster, the folder it lives in, and the facts that decide how everything after it behaves (canvas, frame rate,
 * length, tracks, clips, captions). The actions here are the ones that belong to the project as a whole — reveal the
 * folder, open the export center — not edits: those belong to the steps after.
 */
import * as React from 'react';
import { ChevronRight, Clapperboard, ExternalLink, FolderKanban, Image as ImageIcon, LibraryBig } from 'lucide-react';
import { useT } from '@/i18n';
import { formatClipDuration } from '@/lib/workspace-resources';
import { PANE_BAR, PANE_TITLE } from '../dock-pane-bar';

const BTN = 'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--text)]/30';
const PRIMARY = `${BTN} bg-[var(--text)] text-[var(--panel)] hover:opacity-90 disabled:pointer-events-none disabled:opacity-40`;
const SECONDARY = `${BTN} text-[var(--text)] ring-1 ring-inset ring-[var(--border-strong)] hover:bg-[var(--bg-hover)]`;

export function ProjectStage({ title, folder, stage, fps, durationMs, tracks, clips, captions, onReveal, onMedia, onExport }: {
  title: string;
  folder: string;
  stage: { w: number; h: number };
  fps: number;
  durationMs: number;
  tracks: number;
  clips: number;
  captions: number;
  onReveal: () => void;
  onMedia: () => void;
  onExport: () => void;
}) {
  const t = useT();
  const duration = formatClipDuration(durationMs);
  /* a project opened from a URL (an agent's `open`, the shared library) has no folder on this computer to reveal */
  const local = !/^https?:/i.test(folder) && /^([A-Za-z]:[\\/]|\/)/.test(folder);
  const filmPath = !folder ? 'film.html' : local ? `${folder.replace(/[\\/]+$/, '')}/film.html` : folder.replace(/\/+$/, '');
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]">
      <div className={PANE_BAR}>
        <FolderKanban size={14} aria-hidden className="shrink-0 text-[var(--text-dim)]" />
        <span className={PANE_TITLE}>{t('projectStage.title')}</span>
        <span className="min-w-0 flex-1" />
        {local ? (
          <button type="button" onClick={onReveal} className="flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
            <ExternalLink size={12} aria-hidden />{t('projectStage.reveal')}
          </button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
        <div className="mx-auto flex w-full max-w-[940px] flex-col gap-5">
          <header className="flex flex-wrap items-center gap-4">
            {/* the film's face: the brand's wind, so a project without a poster still looks like this product */}
            <div
              className="relative flex h-[96px] w-[160px] shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--border)] shadow-[var(--shadow-sm)]"
              style={{ background: 'linear-gradient(135deg, var(--brand-wind-from), var(--brand-wind-mid) 55%, var(--brand-wind-to))' }}
            >
              <Clapperboard size={26} aria-hidden className="text-white/80" />
              <span className="absolute bottom-1.5 right-2 text-[10px] tabular-nums text-white/80">{duration}</span>
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-[19px] font-semibold tracking-tight text-[var(--text)]">{title || t('project.untitled')}</h1>
              <p className="mt-1 truncate font-mono text-[11px] text-[var(--text-faint)]">{filmPath}</p>
              <p className="mt-2 text-[12px] text-[var(--text-muted)]">
                {t('projectStage.meta').replace('{duration}', duration).replace('{w}', String(stage.w)).replace('{h}', String(stage.h)).replace('{fps}', String(fps))}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" onClick={onMedia} className={SECONDARY}>{t('projectStage.manageMedia')}</button>
              <button type="button" onClick={onExport} disabled={durationMs <= 0} className={PRIMARY}>{t('projectStage.export')}</button>
            </div>
          </header>

          <section aria-label={t('projectStage.facts')} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Fact icon={<ImageIcon size={12} />} label={t('projectStage.canvas')} value={`${stage.w}×${stage.h}`} />
            <Fact label={t('projectStage.fps')} value={`${fps} fps`} />
            <Fact label={t('projectStage.duration')} value={duration} />
            <Fact label={t('projectStage.tracks')} value={String(tracks)} />
            <Fact label={t('projectStage.clips')} value={String(clips)} />
            <Fact label={t('projectStage.captions')} value={String(captions)} />
          </section>

          <section className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5">
            <span className="text-[11px] font-medium text-[var(--text-faint)]">{t('projectStage.where')}</span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--text-muted)]">{folder || '—'}</span>
              {local ? (
                <button type="button" onClick={onReveal} className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-[var(--text)] ring-1 ring-inset ring-[var(--border)] transition hover:bg-[var(--bg-hover)]">
                  <ExternalLink size={12} aria-hidden />{t('projectStage.reveal')}
                </button>
              ) : null}
            </div>
            <p className="text-[11px] leading-relaxed text-[var(--text-faint)]">{t('projectStage.hint')}</p>
          </section>

          {/* the workflow's own arrow: a stage ends by naming the one after it */}
          <div className="flex items-center gap-2 border-t border-[var(--border-soft)] pt-3">
            <span className="text-[10.5px] text-[var(--text-faint)]">{t('workflow.next')}</span>
            <button type="button" onClick={onMedia}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-[var(--text)] ring-1 ring-inset ring-[var(--border)] transition hover:bg-[var(--bg-hover)]">
              <LibraryBig size={12} aria-hidden />{t('workflow.media')}<ChevronRight size={12} aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Fact({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2">
      {icon ? <span aria-hidden className="text-[var(--text-faint)]">{icon}</span> : null}
      <div className="min-w-0">
        <div className="truncate text-[10.5px] text-[var(--text-faint)]">{label}</div>
        <div className="truncate text-[13px] font-medium tabular-nums text-[var(--text)]">{value}</div>
      </div>
    </div>
  );
}
