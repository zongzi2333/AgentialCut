/**
 * The storyboard's director pane.
 *
 * It is a conversation about a draft, not a second editor. Every structural request comes back as a
 * proposal with a diff-sized summary; the person previews or applies it. The run and history tabs
 * make the agents' work and the applied changes inspectable without inventing a chain-of-thought.
 */
import * as React from 'react';
import { ArrowUp, Check, Loader2, RotateCcw, Settings2, Sparkles } from 'lucide-react';
import { useT } from '@/i18n';
import type { PipelineRun, StoryboardChatResponse, StoryboardDocument, StoryboardProposal } from '@/api';
import { PANE_BAR, PANE_BTN, PANE_TITLE } from '../../dock-pane-bar';

type Tab = 'chat' | 'run' | 'history';
type Message = { id: string; role: 'user' | 'agent'; text: string; proposal?: StoryboardChatResponse };
type Applied = { id: string; text: string; at: number };

export function DirectorPanel({
  doc,
  selectedIds,
  busy,
  error,
  configured,
  chat,
  apply,
  onMatch,
  onGenerateFromPrompt,
  onOpenSettings,
  onUndo,
  pipeline,
}: {
  doc: StoryboardDocument | null;
  pipeline?: PipelineRun | null;
  selectedIds: readonly string[];
  busy: string;
  error: string;
  configured: boolean | null;
  chat: (text: string, selectedIds: string[]) => Promise<StoryboardChatResponse | null>;
  apply: (proposal: Pick<StoryboardProposal, 'baseRevision'>, operations: Array<Record<string, unknown>>) => Promise<boolean>;
  onMatch: (ids?: string[]) => Promise<'success' | 'failed'>;
  onGenerateFromPrompt: (text: string) => Promise<boolean>;
  onOpenSettings: () => void;
  onUndo: () => void;
}) {
  const t = useT();
  const [tab, setTab] = React.useState<Tab>('chat');
  const [ask, setAsk] = React.useState('');
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [proposal, setProposal] = React.useState<{ response: StoryboardChatResponse; messageId: string } | null>(null);
  const [applied, setApplied] = React.useState<Applied[]>([]);
  const [notice, setNotice] = React.useState('');
  const composer = React.useRef<HTMLTextAreaElement>(null);
  const selected = doc?.shots.filter((shot) => selectedIds.includes(shot.id)) ?? [];
  const working = busy === 'chat' || busy === 'apply' || busy === 'generate';

  const send = React.useCallback(async () => {
    const text = ask.trim();
    if (!text || working) return;
    const id = `m_${Date.now()}`;
    setAsk('');
    setNotice('');
    setMessages((current) => [...current, { id, role: 'user', text }]);
    if (!doc?.shots.length) {
      const made = await onGenerateFromPrompt(text);
      setMessages((current) => [...current, { id: `${id}_a`, role: 'agent', text: made ? t('storyboard.started') : t('storyboard.error') }]);
      return;
    }
    const response = await chat(text, [...selectedIds]);
    if (!response) {
      setMessages((current) => [...current, { id: `${id}_a`, role: 'agent', text: t('storyboard.error') }]);
      return;
    }
    setMessages((current) => [...current, { id: `${id}_a`, role: 'agent', text: response.reply, proposal: response }]);
    if (response.operations.length) setProposal({ response, messageId: `${id}_a` });
    if (response.intent === 'match') await onMatch(selectedIds.length ? [...selectedIds] : undefined);
  }, [ask, working, selectedIds, chat, t, onMatch, doc?.shots.length, onGenerateFromPrompt]);

  const applyProposal = React.useCallback(async () => {
    if (!proposal) return;
    const ok = await apply(proposal.response.proposal, proposal.response.operations);
    if (!ok) return;
    setApplied((current) => [{ id: proposal.response.proposal.id, text: proposal.response.reply, at: Date.now() }, ...current].slice(0, 30));
    setMessages((current) => current.map((message) => message.id === proposal.messageId ? { ...message, proposal: undefined } : message));
    setProposal(null);
    setNotice('');
  }, [proposal, apply]);

  const quick = (text: string) => { setAsk(text); composer.current?.focus(); };
  const contextLabel = selected.length ? t('storyboard.contextSelected').replace('{n}', String(selected.length)) : t('storyboard.contextAll');

  return (
    <aside data-storyboard-agent="" className="flex min-h-0 h-full min-w-0 flex-1 flex-col overflow-hidden rounded-[7px] border border-[var(--border)] bg-[var(--dock-pane)] shadow-[var(--shadow-sm)]">
      <div className={PANE_BAR}>
        <Sparkles size={14} aria-hidden className="shrink-0 text-[var(--text-dim)]" />
        <span className={PANE_TITLE}>{t('storyboard.aiTitle')}</span>
        <span className="shrink-0 rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[10px] leading-4 text-[var(--text-faint)]">{contextLabel}</span>
        <span className="min-w-0 flex-1" />
        <button type="button" aria-label={t('storyboard.configure')} onClick={onOpenSettings} className={PANE_BTN}><Settings2 size={13} /></button>
        <button type="button" aria-label={t('storyboard.undo')} onClick={onUndo} className={PANE_BTN}><RotateCcw size={13} /></button>
      </div>

      <div role="tablist" className="mx-2.5 mb-2 flex shrink-0 items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-[2px]">
        {(['chat', 'run', 'history'] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`flex-1 rounded-md px-2 py-[5px] text-[12px] font-medium transition ${tab === id ? 'bg-[var(--surface-3)] text-[var(--text)] shadow-[var(--shadow-sm)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
            {t(`storyboard.${id}`)}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-3">
        {tab === 'chat' ? (
          <div className="flex flex-col gap-2.5">
            <div className="flex flex-wrap gap-1">
              <span className="rounded-full border border-[var(--border)] px-2 py-[2px] text-[10px] text-[var(--text-muted)]">{t('storyboard.contextAll')}</span>
              {selected.length ? <span className="rounded-full border border-[var(--accent)] bg-[var(--accent-soft)] px-2 py-[2px] text-[10px] text-[var(--text)]">{contextLabel}</span> : null}
              {doc ? <span className="rounded-full border border-[var(--border)] px-2 py-[2px] text-[10px] text-[var(--text-faint)]">{doc.shots.length} {t('storyboard.shots').replace('{n}', '').replace(/^\s+/, '')}</span> : null}
            </div>

            {configured === false ? (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
                <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">{t('storyboard.notConfigured')}</p>
                <button type="button" onClick={onOpenSettings} className="mt-2 h-6 rounded-md bg-[var(--text)] px-2 text-[10.5px] font-medium text-[var(--panel)]">{t('storyboard.configure')}</button>
              </div>
            ) : null}

            {messages.length ? messages.map((message) => (
              <div key={message.id} className={`rounded-lg border px-2 py-1.5 text-[11px] leading-relaxed ${message.role === 'user' ? 'border-[var(--border)] bg-[var(--bg)] text-[var(--text-muted)]' : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-dim)]'}`}>
                {message.role === 'agent' ? <strong className="mr-1 text-[var(--text)]">AI</strong> : null}{message.text}
                {message.proposal?.operations.length ? (
                  <div className="mt-2 rounded-md border border-[rgba(26,147,254,.35)] bg-[var(--accent-soft)] px-2 py-1.5">
                    <div className="flex items-center gap-1.5 text-[10px] text-[var(--text)]"><Sparkles size={11} className="text-[var(--accent)]" />{t('storyboard.proposal')}</div>
                    <div className="mt-0.5 text-[10px] text-[var(--text-faint)]">{t('storyboard.affects').replace('{n}', String(message.proposal.operations.filter((op) => op.shotId).length || 1))}</div>
                  </div>
                ) : null}
              </div>
            )) : <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-[11px] leading-relaxed text-[var(--text-muted)]">{t('storyboard.generateHint')}</p>}

            {proposal ? (
              <div className="overflow-hidden rounded-lg border border-[rgba(26,147,254,.38)] bg-[linear-gradient(180deg,rgba(26,147,254,.07),rgba(26,147,254,.015))]">
                <div className="flex items-center gap-1.5 px-2.5 pt-2 text-[11px] text-[var(--text)]"><Sparkles size={12} className="text-[var(--accent)]" />{t('storyboard.proposal')}</div>
                <p className="px-2.5 pt-1 text-[10.5px] leading-relaxed text-[var(--text-muted)]">{proposal.response.reply}</p>
                <div className="mt-2 flex items-center gap-1.5 border-t border-[rgba(26,147,254,.15)] px-2 py-1.5">
                  <button type="button" onClick={() => setProposal(null)} className="h-6 rounded-md px-2 text-[10px] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)]">{t('storyboard.reject')}</button>
                  <button type="button" onClick={() => void applyProposal()} disabled={working}
                    className="ml-auto flex h-6 items-center gap-1 rounded-md bg-[var(--text)] px-2 text-[10px] font-medium text-[var(--panel)] disabled:opacity-40">
                    {working ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />}{t('storyboard.apply')}
                  </button>
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-1">
              {['压缩到 30 秒', '补齐缺镜', '减少重复镜头', '保持开头三镜'].map((one) => (
                <button key={one} type="button" onClick={() => quick(one)} className="max-w-full truncate rounded-md bg-[var(--bg)] px-2 py-1 text-left text-[10.5px] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">{one}</button>
              ))}
            </div>
            {notice ? <p className="text-[10.5px] text-[var(--text-muted)]">{notice}</p> : null}
            {error ? <p className="text-[10.5px] leading-relaxed text-[var(--err)]">{error}</p> : null}
          </div>
        ) : null}

        {tab === 'run' ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-[10.5px] leading-relaxed text-[var(--text-faint)]">{configured === false ? t('storyboard.notConfigured') : t('storyboard.generateHint')}</p>
            {pipeline ? pipeline.steps.map((step) => {
              const color = step.state === 'done' ? 'bg-[var(--ok)]' : step.state === 'error' ? 'bg-[var(--err)]' : step.state === 'running' ? 'bg-[var(--accent)]' : step.state === 'skipped' ? 'bg-[var(--text-faint)]' : 'bg-[var(--border-strong)]';
              return (
                <div key={step.id} className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color} ${step.state === 'running' ? 'animate-pulse' : ''}`} />
                  <span className="min-w-0 text-[11px] text-[var(--text)]">{step.label}</span>
                  <span className="ml-auto min-w-0 max-w-[55%] truncate text-[9.5px] text-[var(--text-faint)]" title={step.detail}>{step.detail ?? step.state}</span>
                </div>
              );
            }) : [
              ['Brief', doc?.shots.length ? 'done' : 'idle'],
              ['Storyboard', doc?.shots.length ? 'done' : 'idle'],
              ['Match', doc?.shots.some((shot) => shot.match.candidates.length) ? 'done' : 'idle'],
              ['Review', doc?.shots.some((shot) => shot.match.state === 'review') ? 'waiting' : 'idle'],
            ].map(([name, state]) => (
              <div key={name} className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${state === 'done' ? 'bg-[var(--ok)]' : state === 'waiting' ? 'bg-[var(--warn)]' : 'bg-[var(--text-faint)]'}`} />
                <span className="text-[11px] text-[var(--text)]">{name}</span>
                <span className="ml-auto text-[10px] text-[var(--text-faint)]">{state}</span>
              </div>
            ))}
            {pipeline?.issues.length ? <div className="mt-1 rounded-lg border border-[rgba(255,191,54,.3)] bg-[rgba(255,191,54,.05)] p-2 text-[10px] leading-relaxed text-[var(--warn)]">{pipeline.issues.slice(0, 4).map((issue) => <p key={issue} className="truncate" title={issue}>· {issue}</p>)}</div> : null}
            {busy ? <p className="flex items-center gap-1.5 text-[10.5px] text-[var(--text-muted)]"><Loader2 size={11} className="animate-spin" />{t('storyboard.running')}</p> : null}
          </div>
        ) : null}

        {tab === 'history' ? (
          <div className="flex flex-col gap-1.5">
            {applied.length ? applied.map((item) => (
              <div key={item.id} className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5">
                <p className="text-[11px] text-[var(--text)]">{item.text}</p>
                <p className="mt-0.5 text-[10px] text-[var(--text-faint)]">{new Date(item.at).toLocaleTimeString()}</p>
              </div>
            )) : <p className="text-[10.5px] text-[var(--text-faint)]">{t('storyboard.noSelection')}</p>}
            {doc?.handedOffAt ? <p className="mt-1 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-[10.5px] text-[var(--text-muted)]">{t('storyboard.handoffDone')}</p> : null}
          </div>
        ) : null}
      </div>

      <div className="m-2.5 mt-0 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)]">
        <textarea
          ref={composer}
          value={ask}
          onChange={(event) => setAsk(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
          }}
          rows={3}
          placeholder={t('storyboard.composer')}
          aria-label={t('storyboard.composer')}
          className="block w-full resize-none rounded-t-lg bg-transparent px-2.5 pt-2 text-[11.5px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]"
        />
        <div className="flex items-center gap-2 px-2 pb-1.5">
          <span className="min-w-0 flex-1 truncate text-[9.5px] text-[var(--text-faint)]">{contextLabel}</span>
          <button type="button" disabled={!ask.trim() || working} onClick={() => void send()} aria-label={t('storyboard.send')}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--text)] text-[var(--panel)] transition disabled:opacity-30">
            {working ? <Loader2 size={13} className="animate-spin" /> : <ArrowUp size={14} />}
          </button>
        </div>
      </div>
    </aside>
  );
}
