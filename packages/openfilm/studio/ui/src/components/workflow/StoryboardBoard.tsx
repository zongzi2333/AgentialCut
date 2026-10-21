/**
 * The storyboard beside the AI pane: the draft as pictures and as time, which a list in a narrow column cannot show.
 *
 * Same draft, three views: the shots as cards (what is said, which media carries it, how long), the draft as a strip
 * of blocks proportional to their length (the shape the timeline will have), and the two decisions at the bottom —
 * preview it, or apply it as one step. The panel next to it is where the ask is typed and the history read.
 *
 * UI only: the sample draft says so, and both buttons say the model and the timeline are not connected yet.
 */
import * as React from 'react';
import { Check, Clapperboard, FileText, WandSparkles } from 'lucide-react';
import { useT } from '@/i18n';
import { formatClipDuration } from '@/lib/workspace-resources';
import { DEMO_SHOTS } from '../ai/ai-demo';
import { PANE_BAR, PANE_TITLE } from '../dock-pane-bar';

export function StoryboardBoard({ totalMs, trackCount }: { totalMs: number; trackCount: number }) {
  const t = useT();
  const [notice, setNotice] = React.useState(false);
  const shots = DEMO_SHOTS.length;
  const total = DEMO_SHOTS.reduce((sum, shot) => sum + shot.seconds, 0);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]">
      <div className={PANE_BAR}>
        <WandSparkles size={14} aria-hidden className="shrink-0 text-[var(--text-dim)]" />
        <span className={PANE_TITLE}>{t('ai.board.title')}</span>
        <span className="shrink-0 rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[10px] leading-4 text-[var(--text-faint)]">{t('ai.demo')}</span>
        <span className="min-w-0 flex-1" />
        <span className="shrink-0 pr-1 text-[10.5px] tabular-nums text-[var(--text-faint)]">
          {t('ai.board.stats').replace('{shots}', String(shots)).replace('{duration}', formatClipDuration(totalMs)).replace('{tracks}', String(trackCount))}
        </span>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-4 py-4">
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
          {DEMO_SHOTS.map((shot, i) => (
            <article key={shot.id} className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-2)]">
              <div
                className="relative flex aspect-video items-center justify-center"
                style={{ background: shot.kind === 'page' ? 'linear-gradient(135deg, #3a4a5f, #22303f)' : 'linear-gradient(135deg, #4d4635, #2b2a24)' }}
              >
                {shot.kind === 'page'
                  ? <FileText size={22} aria-hidden className="text-white/70" />
                  : <Clapperboard size={22} aria-hidden className="text-white/70" />}
                <span className="absolute bottom-1.5 left-2 rounded-sm bg-black/35 px-1 text-[10px] tabular-nums text-white/85">{String(i + 1).padStart(2, '0')}</span>
                <span className="absolute bottom-1.5 right-2 text-[10px] tabular-nums text-white/75">{shot.seconds.toFixed(1)}s</span>
              </div>
              <div className="flex flex-col gap-1 p-2.5">
                <p className="line-clamp-2 text-[12px] leading-snug text-[var(--text)]">{t(shot.narrationKey)}</p>
                <p className="truncate font-mono text-[10px] text-[var(--text-faint)]">{shot.media}</p>
              </div>
            </article>
          ))}
        </div>

        <div className="min-h-4 flex-1" aria-hidden />

        <section className="mt-5">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[11px] font-medium text-[var(--text-faint)]">{t('ai.board.timeline')}</span>
            <span className="min-w-0 flex-1" />
            <span className="text-[10.5px] tabular-nums text-[var(--text-faint)]">{formatClipDuration(totalMs)}</span>
          </div>
          {/* the draft's shape: each block's width is its length, as the timeline will show it */}
          <div className="flex h-9 items-stretch gap-[3px] rounded-md bg-[var(--tl-lane)] p-[3px]">
            {DEMO_SHOTS.map((shot, i) => (
              <div
                key={shot.id}
                style={{ flexGrow: shot.seconds, background: shot.kind === 'page' ? 'var(--tl-scene)' : 'var(--tl-video)' }}
                className="flex min-w-0 items-center gap-1.5 overflow-hidden rounded-[4px] px-2 text-[10px] text-white"
              >
                <span className="shrink-0 tabular-nums text-white/75">{String(i + 1).padStart(2, '0')}</span>
                <span className="truncate text-white/90">{t(shot.narrationKey)}</span>
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[9.5px] tabular-nums text-[var(--text-faint)]">
            <span>0:00</span>
            <span>{formatClipDuration(total / 2 * 1000)}</span>
            <span>{formatClipDuration(total * 1000)}</span>
          </div>
        </section>

      </div>

      <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border-soft)] px-3 py-2">
        <span role={notice ? 'status' : undefined} className={`min-w-0 flex-1 truncate text-[10.5px] ${notice ? 'text-[var(--text-muted)]' : 'text-[var(--text-faint)]'}`}>
          {notice ? t('ai.notConnected') : t('ai.draft.hint')}
        </span>
        <button type="button" onClick={() => setNotice(true)}
          className="flex h-7 shrink-0 items-center justify-center rounded-lg px-3 text-[11.5px] font-medium text-[var(--text)] ring-1 ring-inset ring-[var(--border-strong)] transition hover:bg-[var(--bg-hover)]">
          {t('ai.preview')}
        </button>
        <button type="button" onClick={() => setNotice(true)}
          className="flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-[var(--text)] px-3 text-[11.5px] font-medium text-[var(--panel)] transition hover:opacity-90">
          <Check size={13} />{t('ai.apply').replace('{n}', String(shots))}
        </button>
      </div>
    </div>
  );
}
