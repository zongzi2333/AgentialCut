/**
 * The AI side of the storyboard step: the conversation, and what the AI changed before.
 *
 * OpenFilm's promise is that an agent writes the film as web pages; this pane brings that conversation into Studio
 * itself, next to the storyboard it produces, so an ask and its result are read side by side. It holds two views:
 *
 *   Chat     what to change, with the context it will be read against (the whole film, what is selected, the captions),
 *            example prompts, and the few actions worth a shortcut.
 *   History  what the AI changed before, in the same undo history as a person's own edits.
 *
 * The draft itself is the board beside this pane: shots, their media, and their shape in time. That is deliberate —
 * a draft is pictures, and a list in a narrow column would say it worse.
 *
 * UI only, for now: the draft is sample data, the model and the timeline are not connected, and the pane says so. The
 * shape here is what the feature keeps when it is wired: a draft reviewed before anything is written, and every apply
 * one step in the project's history (undoable, like an edit made by hand).
 */
import * as React from 'react';
import {
  ArrowUp, Captions, Check, CircleCheck, Clapperboard, History, ListOrdered, Music4,
  RotateCcw, Scissors, Sparkles, X,
} from 'lucide-react';
import { useT } from '@/i18n';
import { formatClipDuration } from '@/lib/workspace-resources';
import { DEMO_SHOTS } from './ai-demo';
import { PANE_BAR, PANE_BTN, PANE_BTN_ON, PANE_TITLE } from '../dock-pane-bar';
import { Tooltip } from '../Tooltip';

type Tab = 'chat' | 'history';

/** The few actions that are a shortcut, not a conversation: each one writes its ask into the composer. */
const QUICK = [
  { id: 'captions', icon: Captions, titleKey: 'ai.quick.captions', hintKey: 'ai.quick.captionsHint', askKey: 'ai.quick.captionsAsk' },
  { id: 'pauses', icon: Scissors, titleKey: 'ai.quick.pauses', hintKey: 'ai.quick.pausesHint', askKey: 'ai.quick.pausesAsk' },
  { id: 'script', icon: ListOrdered, titleKey: 'ai.quick.script', hintKey: 'ai.quick.scriptHint', askKey: 'ai.quick.scriptAsk' },
  { id: 'score', icon: Music4, titleKey: 'ai.quick.score', hintKey: 'ai.quick.scoreHint', askKey: 'ai.quick.scoreAsk' },
] as const;

const HISTORY = [
  { id: 'h1', titleKey: 'ai.history.script', metaKey: 'ai.history.scriptMeta' },
  { id: 'h2', titleKey: 'ai.history.captions', metaKey: 'ai.history.captionsMeta' },
  { id: 'h3', titleKey: 'ai.history.pauses', metaKey: 'ai.history.pausesMeta' },
] as const;

export function AiPanel({ totalMs, selectedCount, subtitleCount, onClose, titleKey = 'ai.title' }: {
  totalMs: number;
  selectedCount: number;
  subtitleCount: number;
  onClose: () => void;
  /** what the pane is called here: the workflow step it stands in, or the feature's own name */
  titleKey?: string;
}) {
  const t = useT();
  const [tab, setTab] = React.useState<Tab>('chat');
  const [ask, setAsk] = React.useState('');
  const [notice, setNotice] = React.useState(false);
  const composer = React.useRef<HTMLTextAreaElement>(null);
  const shots = DEMO_SHOTS.length;

  const say = React.useCallback((words: string) => {
    setAsk(words);
    setNotice(false);
    composer.current?.focus();
  }, []);

  /* UI only: generating says plainly that nothing is wired yet; the sample draft is already on the board. */
  const generate = React.useCallback(() => setNotice(true), []);

  const tabButton = (id: Tab, label: string) => (
    <button
      key={id}
      type="button"
      role="tab"
      id={`ai-tab-${id}`}
      aria-controls={`ai-view-${id}`}
      aria-selected={tab === id}
      onClick={() => { setTab(id); setNotice(false); }}
      className={`flex-1 rounded-md px-2 py-[5px] text-[12px] font-medium transition ${
        tab === id ? 'bg-[var(--surface-3)] text-[var(--text)] shadow-[var(--shadow-sm)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'
      }`}
    >
      {label}
    </button>
  );

  return (
    <aside data-ai-panel="" className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--dock-pane)]">
      <div className={PANE_BAR}>
        <Sparkles size={14} className="shrink-0 text-[var(--text-dim)]" aria-hidden />
        <span className={PANE_TITLE}>{t(titleKey)}</span>
        <span className="shrink-0 rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[10px] leading-4 text-[var(--text-faint)]">
          {t('ai.demo')}
        </span>
        <span className="min-w-0 flex-1" />
        <Tooltip label={t('ai.historyTitle')} side="bottom">
          <button type="button" aria-label={t('ai.historyTitle')} onClick={() => { setTab('history'); setNotice(false); }}
            className={`${PANE_BTN} ${tab === 'history' ? PANE_BTN_ON : ''}`}>
            <History size={13} />
          </button>
        </Tooltip>
        <Tooltip label={t('ai.close')} side="bottom">
          <button type="button" aria-label={t('ai.close')} onClick={onClose} className={PANE_BTN}>
            <X size={14} />
          </button>
        </Tooltip>
      </div>

      <div role="tablist" aria-label={t(titleKey)} className="mx-2.5 mb-2 flex shrink-0 items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-[2px]">
        {tabButton('chat', t('ai.tab.chat'))}
        {tabButton('history', t('ai.tab.history'))}
      </div>

      <div role="tabpanel" id={`ai-view-${tab}`} aria-labelledby={`ai-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-3">
        {tab === 'chat' ? (
          <div className="flex flex-col gap-3">
            {/* what the ask will be read against: said before it is typed, not after */}
            <section aria-label={t('ai.context')} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-medium text-[var(--text-faint)]">{t('ai.context')}</span>
                <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--text-faint)]">{t('ai.contextHint')}</span>
              </div>
              <div className="flex flex-wrap gap-1">
                <Chip icon={<Clapperboard size={11} />} label={t('ai.wholeFilm')} value={formatClipDuration(totalMs)} on />
                {selectedCount ? <Chip icon={<Check size={11} />} label={t('ai.selected').replace('{n}', String(selectedCount))} /> : null}
                <Chip icon={<Captions size={11} />} label={t('ai.captions').replace('{n}', String(subtitleCount))} />
              </div>
            </section>

            {/* the composer: the pane's one input, held open with the examples under it */}
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] focus-within:border-[var(--border-strong)]">
              <textarea
                ref={composer}
                value={ask}
                onChange={(e) => { setAsk(e.target.value); setNotice(false); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (ask.trim()) generate(); }
                }}
                rows={3}
                placeholder={t('ai.placeholder')}
                aria-label={t('ai.placeholder')}
                className="block w-full resize-none rounded-t-xl bg-transparent px-2.5 pt-2 text-[12.5px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]"
              />
              <div className="flex items-center gap-2 px-2 pb-1.5">
                <span className="min-w-0 flex-1 truncate text-[10.5px] text-[var(--text-faint)]">{t('ai.composerHint')}</span>
                <button
                  type="button"
                  onClick={generate}
                  disabled={!ask.trim()}
                  aria-label={t('ai.generate')}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--text)] text-[var(--panel)] transition hover:opacity-90 disabled:opacity-30"
                >
                  <ArrowUp size={14} />
                </button>
              </div>
            </section>

            <section aria-label={t('ai.examples')} className="flex flex-wrap gap-1">
              {(['tighten', 'onePerLine', 'teaser'] as const).map((id) => (
                <button key={id} type="button" onClick={() => say(t(`ai.example.${id}`))}
                  className="max-w-full truncate rounded-md bg-[var(--bg)] px-2 py-1 text-left text-[11.5px] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
                  {t(`ai.example.${id}`)}
                </button>
              ))}
            </section>

            <section className="flex flex-col gap-1.5">
              <span className="text-[11px] font-medium text-[var(--text-faint)]">{t('ai.quickTitle')}</span>
              <div className="grid grid-cols-2 gap-1.5">
                {QUICK.map((q) => (
                  <button key={q.id} type="button" onClick={() => say(t(q.askKey))}
                    className="group flex min-w-0 flex-col gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2 text-left transition hover:border-[var(--border-strong)]">
                    <span className="flex items-center gap-1.5">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[var(--bg)] text-[var(--text-muted)]">
                        <q.icon size={12} />
                      </span>
                      <span className="min-w-0 truncate text-[12px] font-medium text-[var(--text)]">{t(q.titleKey)}</span>
                    </span>
                    <span className="line-clamp-2 text-[10.5px] leading-snug text-[var(--text-faint)]">{t(q.hintKey)}</span>
                  </button>
                ))}
              </div>
            </section>

            {/* the draft is the answer, and it is on the board: the chat says it is ready and hands over */}
            <section className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
              <div className="flex items-center gap-1.5">
                <CircleCheck size={13} className="shrink-0 text-[var(--ok)]" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--text)]">{t('ai.draft.ready')}</span>
                <span className="shrink-0 text-[10.5px] tabular-nums text-[var(--text-faint)]">{t('ai.draft.count').replace('{n}', String(shots))}</span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-[var(--text-muted)]">{t('ai.draft.summary')}</p>
              <p className="mt-1.5 text-[10.5px] text-[var(--text-faint)]">{t('ai.draft.beside')}</p>
            </section>

            {notice ? <Notice text={t('ai.notConnected')} /> : null}

            <p className="px-0.5 text-[10.5px] leading-relaxed text-[var(--text-faint)]">{t('ai.footnote')}</p>
          </div>
        ) : null}

        {tab === 'history' ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-[var(--text-faint)]">{t('ai.historyTitle')}</span>
            {HISTORY.map((item) => (
              <article key={item.id} className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-[var(--bg)] text-[var(--text-muted)]">
                  <Sparkles size={11} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12px] font-medium text-[var(--text)]">{t(item.titleKey)}</p>
                  <p className="mt-0.5 text-[10.5px] text-[var(--text-faint)]">{t(item.metaKey)}</p>
                </div>
                <Tooltip label={t('ai.undo')} side="bottom">
                  <button type="button" aria-label={t('ai.undo')} onClick={() => setNotice(true)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-faint)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">
                    <RotateCcw size={12} />
                  </button>
                </Tooltip>
              </article>
            ))}
            {notice ? <Notice text={t('ai.notConnected')} /> : null}
            <p className="mt-1 px-0.5 text-[10.5px] leading-relaxed text-[var(--text-faint)]">{t('ai.historyNote')}</p>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function Chip({ icon, label, value, on }: { icon: React.ReactNode; label: string; value?: string; on?: boolean }) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 rounded-full border px-1.5 py-[2px] text-[10.5px] ${
      on ? 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text)]' : 'border-[var(--border)] text-[var(--text-muted)]'
    }`}>
      <span aria-hidden className="shrink-0 text-[var(--text-faint)]">{icon}</span>
      <span className="min-w-0 truncate">{label}</span>
      {value ? <span className="shrink-0 tabular-nums text-[var(--text-faint)]">{value}</span> : null}
    </span>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <p role="status" className="flex items-start gap-1.5 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-[10.5px] leading-snug text-[var(--text-muted)]">
      <Sparkles size={11} className="mt-[1px] shrink-0 text-[var(--text-faint)]" aria-hidden />
      {text}
    </p>
  );
}
