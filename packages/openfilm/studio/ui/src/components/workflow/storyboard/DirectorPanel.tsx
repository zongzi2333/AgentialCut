/**
 * The storyboard's conversation pane.
 *
 * It is a conversation about a draft, not a second editor. A structural request is applied directly
 * (the storyboard's undo is the safety net); the run and history tabs make the agents' work and the
 * applied changes inspectable without inventing a chain-of-thought.
 */
import * as React from 'react';
import { ArrowUp, ListRestart, Loader2, Redo2, RotateCcw, Settings2, Sparkles, Square, Trash2, X } from 'lucide-react';
import { useT } from '@/i18n';
import { api, type PipelineRun, type StoryboardChatResponse, type StoryboardDocument, type StoryboardProposal } from '@/api';
import { PANE_BAR, PANE_BTN, PANE_TITLE } from '../../dock-pane-bar';
import { AgentRunDetails } from '../../ai/AgentRunDetails';
import { AgentContextMeter } from '../../ai/AgentContextMeter';
import { OperationHistory, type SessionTimeline } from '../../OperationHistory';

type Tab = 'chat' | 'run' | 'history';
type Message = { id: string; role: 'user' | 'agent'; text: string };
type Applied = { id: string; text: string; at: number };

const scrollKey = (projectId: string, tab: Tab) => `openfilm.aiChat.scroll.storyboard.${tab}.${projectId}`;
const readScroll = (projectId: string, tab: Tab): number | null => {
  try {
    const raw = localStorage.getItem(scrollKey(projectId, tab));
    if (raw == null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
};
const saveScroll = (projectId: string, tab: Tab, top: number) => {
  try { localStorage.setItem(scrollKey(projectId, tab), String(Math.max(0, Math.round(top)))); } catch { /* private mode */ }
};

export function DirectorPanel({
  projectId,
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
  onRedo,
  canUndo,
  canRedo,
  history,
  onRollback,
  onRetry,
  onCancel,
  onReload,
  onClose,
  pipeline,
}: {
  projectId: string;
  doc: StoryboardDocument | null;
  pipeline?: PipelineRun | null;
  selectedIds: readonly string[];
  busy: string;
  error: string;
  configured: boolean | null;
  chat: (text: string, selectedIds: string[], signal?: AbortSignal) => Promise<StoryboardChatResponse | null>;
  apply: (proposal: Pick<StoryboardProposal, 'baseRevision'>, operations: Array<Record<string, unknown>>) => Promise<boolean>;
  onMatch: (ids?: string[]) => Promise<'success' | 'failed'>;
  onGenerateFromPrompt: (text: string) => Promise<boolean>;
  onOpenSettings: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  history: SessionTimeline;
  onRollback: (cursor: number) => void;
  onRetry: () => void;
  onCancel: () => void;
  onReload: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [tab, setTab] = React.useState<Tab>('chat');
  const [ask, setAsk] = React.useState('');
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [applied, setApplied] = React.useState<Applied[]>([]);
  const [notice, setNotice] = React.useState('');
  const [run, setRun] = React.useState<StoryboardChatResponse | null>(null);
  const [question, setQuestion] = React.useState('');
  const [questionOptions, setQuestionOptions] = React.useState<string[]>([]);
  const [lastText, setLastText] = React.useState('');
  const [stopped, setStopped] = React.useState(false);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [localError, setLocalError] = React.useState('');
  const [requestAt, setRequestAt] = React.useState<number | null>(null);
  const [hydrated, setHydrated] = React.useState(false);
  const composer = React.useRef<HTMLTextAreaElement>(null);
  const scroller = React.useRef<HTMLDivElement>(null);
  const restoredTab = React.useRef<Tab | null>(null);
  const stick = React.useRef(true);
  const abort = React.useRef<AbortController | null>(null);
  const historyBox = React.useRef<HTMLSpanElement | null>(null);
  const [historyAnchor, setHistoryAnchor] = React.useState<DOMRect | null>(null);
  const selected = doc?.shots.filter((shot) => selectedIds.includes(shot.id)) ?? [];
  const working = busy === 'chat' || busy === 'apply' || busy === 'generate';

  React.useEffect(() => {
    let live = true;
    restoredTab.current = null;
    stick.current = true;
    setHydrated(false);
    setRun(null);
    setQuestion('');
    setQuestionOptions([]);
    setStopped(false);
    setRequestAt(null);
    void api.agentChatHistory(projectId, 'storyboard').then((stored) => {
      if (!live) return;
      setMessages(stored);
    }).catch(() => { /* the hint remains when history cannot be read */ })
      .finally(() => { if (live) setHydrated(true); });
    return () => { live = false; };
  }, [projectId]);

  /* The conversation, the plan and the applied list remember where each was left. Chat waits for its history;
     the other tabs can restore as soon as they show. */
  React.useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || (tab === 'chat' && !hydrated)) return;
    if (restoredTab.current !== tab) {
      restoredTab.current = tab;
      const saved = readScroll(projectId, tab);
      el.scrollTop = saved ?? (tab === 'chat' ? el.scrollHeight : 0);
      stick.current = tab === 'chat' && el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
      return;
    }
    if (tab === 'chat' && stick.current) el.scrollTop = el.scrollHeight;
  }, [tab, messages, hydrated, busy, run, question, error, pipeline, applied, projectId]);

  const turn = React.useCallback(async (text: string, echo: boolean) => {
    const clean = text.trim();
    if (!clean || working) return;
    const id = `m_${Date.now()}`;
    if (echo) {
      setAsk('');
      setMessages((current) => [...current, { id, role: 'user', text: clean }]);
    }
    setNotice('');
    setLocalError('');
    setLastText(clean);
    setStopped(false);
    setRequestAt(Date.now());
    setQuestion('');
    setQuestionOptions([]);
    setRun(null);
    if (!doc?.shots.length) {
      const made = await onGenerateFromPrompt(clean);
      setMessages((current) => [...current, { id: `${id}_a`, role: 'agent', text: made ? t('storyboard.started') : t('storyboard.error') }]);
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    const response = await chat(clean, [...selectedIds], controller.signal);
    if (abort.current === controller) abort.current = null;
    if (!response) {
      setStopped(true);
      setMessages((current) => [...current, { id: `${id}_a`, role: 'agent', text: t('storyboard.error') }]);
      return;
    }
    setRun(response);
    setQuestion(response.question ?? '');
    setQuestionOptions(response.questionOptions ?? []);
    const wasStopped = Boolean(response.issues?.includes('本轮由用户停止'));
    setStopped(wasStopped);
    /* A stop can happen after a tool already wrote: show that document without blanking the pane. */
    if (wasStopped) await onReload();
    /* New runs apply their tools on the server. Only a legacy response with operations and a
       proposal still goes through the old page-side apply path. */
    let appliedNow = response.applied === true;
    if (!appliedNow && response.operations?.length && response.proposal) {
      appliedNow = await apply(response.proposal, response.operations);
      setNotice(appliedNow ? '已直接应用，可用上方的撤销按钮恢复。' : '这次修改没有通过校验，分镜未改变。');
    } else if (appliedNow) {
      await onReload();
      setNotice('已由 Agent 直接应用，可用上方的撤销按钮恢复。');
    }
    if (appliedNow) setApplied((current) => [{ id: response.runId ?? response.proposal?.id ?? id, text: response.reply, at: Date.now() }, ...current].slice(0, 30));
    setMessages((current) => [...current, { id: `${id}_a`, role: 'agent', text: `${response.reply}${appliedNow ? '（已应用）' : ''}` }]);
    if (response.intent === 'match' && !appliedNow) await onMatch(selectedIds.length ? [...selectedIds] : undefined);
  }, [working, selectedIds, chat, t, onMatch, onReload, doc?.shots.length, onGenerateFromPrompt, apply]);

  const send = () => {
    if (ask.trim()) void turn(ask, true);
  };
  const retry = () => {
    if (lastText) void turn(lastText, false);
  };
  const stop = () => {
    abort.current?.abort();
  };
  const clearConversation = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      window.setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    setConfirmClear(false);
    try {
      await api.clearAgentChat(projectId, 'storyboard');
      setMessages([]);
      setApplied([]);
      setRun(null);
      setQuestion('');
      setQuestionOptions([]);
      setStopped(false);
      setLastText('');
      setRequestAt(null);
      setLocalError('');
      setNotice('');
      try { localStorage.removeItem(scrollKey(projectId, 'chat')); } catch { /* private mode */ }
      restoredTab.current = null;
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    }
  };
  const retryable = Boolean(lastText) && !working && (stopped || run?.status === 'budget' || run?.status === 'error' || Boolean(run?.issues?.length && !run.applied));

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
        <button type="button" aria-label={t('storyboard.undo')} onClick={onUndo} disabled={!canUndo} className={`${PANE_BTN} disabled:opacity-30`}><RotateCcw size={13} /></button>
        <button type="button" aria-label={t('history.redo')} onClick={onRedo} disabled={!canRedo} className={`${PANE_BTN} disabled:opacity-30`}><Redo2 size={13} /></button>
        <span ref={historyBox} className="flex">
          <button type="button" aria-label={t('history.opsTitle')} aria-pressed={historyAnchor != null}
            onClick={() => setHistoryAnchor((open) => (open ? null : historyBox.current?.getBoundingClientRect() ?? null))}
            className={`${PANE_BTN} ${historyAnchor ? 'bg-[var(--bg-hover)] text-[var(--text)]' : ''}`}><ListRestart size={13} /></button>
        </span>
        <button type="button" aria-label={confirmClear ? '确认删除对话记录' : '删除对话记录'} title={confirmClear ? '再点一次：永久删除' : '删除对话记录'}
          onClick={() => void clearConversation()} disabled={working}
          className={`${PANE_BTN} ${confirmClear ? 'text-[var(--err)]' : ''} disabled:opacity-30`}><Trash2 size={13} /></button>
        <button type="button" aria-label="关闭 AI 分镜助手" onClick={onClose} className={PANE_BTN}><X size={14} /></button>
      </div>
      {historyAnchor ? (
        <OperationHistory ops={history} anchor={historyAnchor} trigger={historyBox.current}
          onRollback={onRollback} onClose={() => setHistoryAnchor(null)} />
      ) : null}

      <div role="tablist" className="mx-2.5 mb-2 flex shrink-0 items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--bg)] p-[2px]">
        {(['chat', 'run', 'history'] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={`flex-1 rounded-md px-2 py-[5px] text-[12px] font-medium transition ${tab === id ? 'bg-[var(--surface-3)] text-[var(--text)] shadow-[var(--shadow-sm)]' : 'text-[var(--text-muted)] hover:text-[var(--text)]'}`}>
            {t(`storyboard.${id}`)}
          </button>
        ))}
      </div>

      <div ref={scroller} onScroll={() => {
        const el = scroller.current;
        if (!el || (tab === 'chat' && !hydrated)) return;
        stick.current = tab === 'chat' && el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
        saveScroll(projectId, tab, el.scrollTop);
      }} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 pb-3">
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
              </div>
            )) : <p className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-[11px] leading-relaxed text-[var(--text-muted)]">{t('storyboard.generateHint')}</p>}

            {run ? <AgentRunDetails run={run} /> : null}
            {question ? (
              <div className="rounded-lg border border-[rgba(255,191,54,.3)] bg-[rgba(255,191,54,.05)] p-2.5">
                <p className="text-[11px] leading-relaxed text-[var(--warn)]">{question}</p>
                {questionOptions.length ? (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {questionOptions.map((option) => (
                      <button key={option} type="button" disabled={working} onClick={() => void turn(option, true)}
                        className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-left text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40">{option}</button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {retryable ? (
              <button type="button" disabled={working} onClick={retry}
                className="flex w-fit items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40">
                <RotateCcw size={11} />重试上一轮
              </button>
            ) : null}

            <div className="flex flex-wrap gap-1">
              {['压缩到 30 秒', '补齐缺镜', '减少重复镜头', '保持开头三镜'].map((one) => (
                <button key={one} type="button" onClick={() => quick(one)} className="max-w-full truncate rounded-md bg-[var(--bg)] px-2 py-1 text-left text-[10.5px] text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">{one}</button>
              ))}
            </div>
            {notice ? <p className="text-[10.5px] text-[var(--text-muted)]">{notice}</p> : null}
            {error || localError ? <p className="text-[10.5px] leading-relaxed text-[var(--err)]">{error || localError}</p> : null}
          </div>
        ) : null}

        {tab === 'run' ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-[10.5px] leading-relaxed text-[var(--text-faint)]">{configured === false ? t('storyboard.notConfigured') : t('storyboard.generateHint')}</p>
            {pipeline?.plan ? (
              <div className="mb-1 flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[9.5px] text-[var(--text-faint)]">
                <span className="truncate" title={pipeline.plan.goal}>{pipeline.plan.goal}</span>
                <span className="ml-auto shrink-0">{pipeline.plan.planner === 'model' ? '计划 Agent' : '默认计划'} · {pipeline.plan.state}</span>
                {pipeline.plan.replans ? <span className="shrink-0 text-[var(--warn)]">重规划 {pipeline.plan.replans}</span> : null}
              </div>
            ) : null}
            {pipeline ? (pipeline.plan?.steps ?? pipeline.steps).map((step) => {
              const color = step.state === 'done' ? 'bg-[var(--ok)]' : step.state === 'error' ? 'bg-[var(--err)]' : step.state === 'running' ? 'bg-[var(--accent)]' : step.state === 'skipped' ? 'bg-[var(--text-faint)]' : 'bg-[var(--border-strong)]';
              const role = 'role' in step ? ` · ${step.role}` : '';
              const attempts = 'attempts' in step && typeof step.attempts === 'number' && step.attempts > 1 ? ` · 第${step.attempts}次` : '';
              const dependsOn = 'dependsOn' in step && Array.isArray(step.dependsOn) && step.dependsOn.length ? `依赖 ${step.dependsOn.join(' → ')}` : '';
              return (
                <div key={step.id} className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5">
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${color} ${step.state === 'running' ? 'animate-pulse' : ''}`} />
                  <span className="min-w-0 text-[11px] text-[var(--text)]">{step.label}{role}</span>
                  <span className="ml-auto min-w-0 max-w-[55%] truncate text-[9.5px] text-[var(--text-faint)]" title={[step.detail, dependsOn].filter(Boolean).join(' · ')}>{step.detail ?? step.state}{attempts}{dependsOn ? ` · ${dependsOn}` : ''}</span>
                </div>
              );
            }) : [
              ['Brief', doc?.shots.length ? 'done' : 'idle'],
              ['Storyboard', doc?.shots.length ? 'done' : 'idle'],
              ['Match', doc?.shots.some((shot) => shot.match.candidates.length) ? 'done' : 'idle'],
              ['Review', doc?.shots.some((shot) => shot.match.state === 'review') ? 'waiting' : 'idle'],
              ['Handoff', doc?.handedOffAt ? 'done' : 'idle'],
            ].map(([name, state]) => (
              <div key={name} className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${state === 'done' ? 'bg-[var(--ok)]' : state === 'waiting' ? 'bg-[var(--warn)]' : 'bg-[var(--text-faint)]'}`} />
                <span className="text-[11px] text-[var(--text)]">{name}</span>
                <span className="ml-auto text-[10px] text-[var(--text-faint)]">{state}</span>
              </div>
            ))}
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              {pipeline?.state === 'running' ? (
                <button type="button" onClick={onCancel} className="rounded-md border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--err)]">停止计划</button>
              ) : null}
              {pipeline?.state === 'error' ? <button type="button" onClick={onRetry} className="rounded-md border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]">重试失败计划</button> : null}
              {pipeline?.state === 'done' ? (
                <span className={`text-[10px] ${pipeline.issues.length ? 'text-[var(--warn)]' : 'text-[var(--ok)]'}`}>
                  最终验收{pipeline.issues.length ? ` · ${pipeline.issues.length} 个问题` : '通过'}
                </span>
              ) : null}
              {pipeline?.applied.length ? <span className="text-[10px] text-[var(--text-faint)]">已应用 {pipeline.applied.length} 项</span> : null}
            </div>
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
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); }
          }}
          rows={3}
          placeholder={question ? '回答上面的问题…' : t('storyboard.composer')}
          aria-label={t('storyboard.composer')}
          className="block w-full resize-none rounded-t-lg bg-transparent px-2.5 pt-2 text-[11.5px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]"
        />
        <div className="flex items-center gap-2 px-2 pb-1.5">
          <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <AgentContextMeter scope="storyboard" requestAt={requestAt} />
            <span className="truncate text-[9.5px] text-[var(--text-faint)]">{contextLabel}</span>
          </span>
          {working ? (
            <button type="button" onClick={stop} aria-label="停止本轮"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] hover:bg-[var(--bg-hover)] hover:text-[var(--err)]">
              <Square size={11} />
            </button>
          ) : null}
          <button type="button" disabled={!ask.trim() || working} onClick={send} aria-label={t('storyboard.send')}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--text)] text-[var(--panel)] transition disabled:opacity-30">
            {working ? <Loader2 size={13} className="animate-spin" /> : <ArrowUp size={14} />}
          </button>
        </div>
      </div>
    </aside>
  );
}
