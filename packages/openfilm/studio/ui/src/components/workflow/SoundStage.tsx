/**
 * Step 5, the sound: voice, music and effects, before the film is delivered.
 *
 * In OpenFilm every sound is a clip on its own track, so this step is about making the material that those tracks
 * carry: a voice-over read from the script, a score picked for the mood, an effect for a moment. What is already on
 * the timeline is listed here — an empty film says so plainly, and points at the tools above it.
 *
 * UI only: the tools say they are not connected yet, as does the rest of the rough cut.
 */
import * as React from 'react';
import { AudioLines, ChevronRight, Mic, Music4, PackageCheck, Sparkles, Volume2 } from 'lucide-react';
import { useT } from '@/i18n';
import { formatClipDuration } from '@/lib/workspace-resources';
import { PANE_BAR, PANE_TITLE } from '../dock-pane-bar';

const BTN = 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[11.5px] font-medium outline-none transition focus-visible:ring-2 focus-visible:ring-[var(--text)]/30';
const SECONDARY = `${BTN} text-[var(--text)] ring-1 ring-inset ring-[var(--border-strong)] hover:bg-[var(--bg-hover)]`;

const TOOLS = [
  { id: 'voice', icon: Mic, titleKey: 'soundStage.voice', hintKey: 'soundStage.voiceHint', actionKey: 'soundStage.voiceAction' },
  { id: 'music', icon: Music4, titleKey: 'soundStage.music', hintKey: 'soundStage.musicHint', actionKey: 'soundStage.musicAction' },
  { id: 'sfx', icon: Volume2, titleKey: 'soundStage.sfx', hintKey: 'soundStage.sfxHint', actionKey: 'soundStage.sfxAction' },
] as const;

export function SoundStage({ durationMs, tracks, onNext }: {
  durationMs: number;
  tracks: number;
  onNext: () => void;
}) {
  const t = useT();
  const [notice, setNotice] = React.useState(false);
  const empty = tracks === 0;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]">
      <div className={PANE_BAR}>
        <AudioLines size={14} aria-hidden className="shrink-0 text-[var(--text-dim)]" />
        <span className={PANE_TITLE}>{t('soundStage.title')}</span>
        <span className="min-w-0 flex-1" />
        <span className="shrink-0 pr-1 text-[10.5px] tabular-nums text-[var(--text-faint)]">
          {t('soundStage.summary').replace('{tracks}', String(tracks)).replace('{duration}', formatClipDuration(durationMs))}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5">
        <div className="mx-auto flex w-full max-w-[940px] flex-col gap-5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {TOOLS.map((tool) => (
              <section key={tool.id} className="flex flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3.5">
                <span className="flex items-center gap-2">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--bg)] text-[var(--text-muted)]">
                    <tool.icon size={14} aria-hidden />
                  </span>
                  <span className="min-w-0 truncate text-[12.5px] font-medium text-[var(--text)]">{t(tool.titleKey)}</span>
                </span>
                <p className="min-h-[32px] text-[11px] leading-relaxed text-[var(--text-muted)]">{t(tool.hintKey)}</p>
                <button type="button" onClick={() => setNotice(true)} className={`${SECONDARY} self-start`}>{t(tool.actionKey)}</button>
              </section>
            ))}
          </div>

          <section aria-label={t('soundStage.tracks')} className="flex flex-col gap-2">
            <span className="text-[11px] font-medium text-[var(--text-faint)]">{t('soundStage.tracks')}</span>
            {empty ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-[var(--border)] px-4 py-10 text-center">
                <AudioLines size={20} aria-hidden className="text-[var(--text-faint)]" />
                <p className="text-[12.5px] font-medium text-[var(--text-muted)]">{t('soundStage.empty')}</p>
                <p className="max-w-[360px] text-[11.5px] leading-relaxed text-[var(--text-faint)]">{t('soundStage.emptyHint')}</p>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {Array.from({ length: tracks }, (_, i) => (
                  <div key={i} className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2">
                    <Volume2 size={13} aria-hidden className="shrink-0 text-[var(--text-muted)]" />
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text)]">{t('soundStage.track').replace('{n}', String(i + 1))}</span>
                    <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--text-faint)]">{formatClipDuration(durationMs)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {notice ? (
            <p role="status" className="flex items-start gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
              <Sparkles size={12} aria-hidden className="mt-px shrink-0 text-[var(--text-faint)]" />
              {t('soundStage.demo')}
            </p>
          ) : null}

          <div className="flex items-center gap-2 border-t border-[var(--border-soft)] pt-3">
            <span className="text-[10.5px] text-[var(--text-faint)]">{t('workflow.next')}</span>
            <button type="button" onClick={onNext}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-[var(--text)] ring-1 ring-inset ring-[var(--border)] transition hover:bg-[var(--bg-hover)]">
              <PackageCheck size={12} aria-hidden />{t('workflow.deliver')}<ChevronRight size={12} aria-hidden />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
