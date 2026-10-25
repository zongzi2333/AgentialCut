/**
 * A stage's browser conversation, in the same pane on every step. The scope picks the agent and the
 * stored conversation: edit uses the conversation agent, sound the audio agent. They never share
 * history or an answer.
 */
import * as React from 'react';
import { ArrowUp, Loader2, RotateCcw, Sparkles, Square, Trash2, X } from 'lucide-react';
import { api, type AgentChatResponse, type AgentChatScope } from '@/api';
import { PANE_BAR, PANE_BTN, PANE_TITLE } from '../dock-pane-bar';
import { AgentRunDetails } from './AgentRunDetails';
import { AgentContextMeter } from './AgentContextMeter';

type Message = { id: string; role: 'user' | 'agent'; text: string };
const EDIT_WELCOME = '我可以帮你分析节奏、连续性、镜头取舍和下一步怎么剪。告诉我你想改什么，或直接问当前时间线的问题。';

/** The scroll spot a stage's chat was left at (the panel unmounts when the step changes). */
const scrollKey = (projectId: string, scope: AgentChatScope) => `openfilm.aiChat.scroll.${scope}.${projectId}`;
const readScroll = (projectId: string, scope: AgentChatScope): number | null => {
  try {
    const raw = localStorage.getItem(scrollKey(projectId, scope));
    if (raw == null) return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
};
const saveScroll = (projectId: string, scope: AgentChatScope, top: number) => {
  try { localStorage.setItem(scrollKey(projectId, scope), String(Math.max(0, Math.round(top)))); } catch { /* private mode */ }
};

export function EditChatPanel({ projectId, onClose, scope = 'edit', title = 'AI 剪辑助手', welcome = EDIT_WELCOME, placeholder = '例如：开头太拖了，帮我看看怎么剪；或问这段的连续性。', configured, onOpenSettings }: {
  projectId: string;
  onClose: () => void;
  /** Which agent and conversation this pane is: each stage has its own. */
  scope?: AgentChatScope;
  title?: string;
  welcome?: string;
  placeholder?: string;
  /** false: no agent is ready; null: still reading. Undefined: this pane does not check. */
  configured?: boolean | null;
  onOpenSettings?: () => void;
}) {
  const ready = configured !== false && configured !== null;
  const [ask, setAsk] = React.useState('');
  const [messages, setMessages] = React.useState<Message[]>([
    { id: 'hello', role: 'agent', text: welcome },
  ]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [hydrated, setHydrated] = React.useState(false);
  const [run, setRun] = React.useState<AgentChatResponse | null>(null);
  const [question, setQuestion] = React.useState('');
  const [questionOptions, setQuestionOptions] = React.useState<string[]>([]);
  const [lastText, setLastText] = React.useState('');
  const [stopped, setStopped] = React.useState(false);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [requestAt, setRequestAt] = React.useState<number | null>(null);
  const composer = React.useRef<HTMLTextAreaElement>(null);
  const scroller = React.useRef<HTMLDivElement>(null);
  const abort = React.useRef<AbortController | null>(null);
  const restored = React.useRef(false);
  /** Whether new lines should follow the bottom; scrolling up releases it, as a chat does. */
  const stick = React.useRef(true);

  /* History arrives after the first paint: put the view back where it was left, not at the top and not forced to the
     bottom. Once restored, only a view that is already at the bottom follows new lines. */
  React.useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !hydrated) return;
    if (!restored.current) {
      restored.current = true;
      const saved = readScroll(projectId, scope);
      if (saved != null) {
        el.scrollTop = saved;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
        return;
      }
      el.scrollTop = el.scrollHeight;
      stick.current = true;
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [messages, busy, hydrated, projectId, scope, run, question, error, stopped]);

  React.useEffect(() => {
    restored.current = false;
    setRun(null);
    setQuestion('');
    setQuestionOptions([]);
    setStopped(false);
    if (configured === false || configured === null) {
      setMessages([{ id: 'hello', role: 'agent', text: welcome }]);
      setHydrated(configured === false);
      return undefined;
    }
    let live = true;
    setHydrated(false);
    void api.agentChatHistory(projectId, scope).then((stored) => {
      if (!live) return;
      setMessages(stored.length ? stored : [{ id: 'hello', role: 'agent', text: welcome }]);
    }).catch(() => { /* the panel still works when history cannot be read */ })
      .finally(() => { if (live) setHydrated(true); });
    return () => { live = false; };
  }, [projectId, scope, welcome, configured]);

  const turn = async (text: string, echo: boolean) => {
    const clean = text.trim();
    if (!clean || busy || !ready) return;
    const id = `m_${Date.now()}`;
    if (echo) {
      setAsk('');
      setMessages((current) => [...current, { id, role: 'user', text: clean }]);
    }
    setLastText(clean);
    setError('');
    setStopped(false);
    setQuestion('');
    setQuestionOptions([]);
    setRun(null);
    setRequestAt(Date.now());
    stick.current = true;
    setBusy(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const result = await api.agentChat(projectId, { text: clean, scope, signal: controller.signal });
      setRun(result);
      setQuestion(result.question ?? '');
      setQuestionOptions(result.questionOptions ?? []);
      setMessages((current) => [...current, {
        id: `${id}_a`,
        role: 'agent',
        text: `${result.reply}${result.applied ? '（已应用到时间线）' : ''}`,
      }]);
    } catch (e) {
      if ((e as { name?: string } | null)?.name === 'AbortError') {
        setStopped(true);
        setMessages((current) => [...current, { id: `${id}_a`, role: 'agent', text: '已停止本轮。已完成的工具修改会保留，请检查当前时间线。' }]);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (abort.current === controller) abort.current = null;
      setBusy(false);
    }
  };

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
      await api.clearAgentChat(projectId, scope);
      setMessages([{ id: 'hello', role: 'agent', text: welcome }]);
      setRun(null);
      setQuestion('');
      setQuestionOptions([]);
      setStopped(false);
      setLastText('');
      setError('');
      setRequestAt(null);
      restored.current = false;
      try { localStorage.removeItem(scrollKey(projectId, scope)); } catch { /* private mode */ }
      if (scroller.current) scroller.current.scrollTop = 0;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const retryable = Boolean(lastText) && !busy && (stopped || Boolean(error) || run?.status === 'budget' || run?.status === 'error' || Boolean(run?.issues?.length && !run.applied));

  return (
    <aside data-edit-ai-chat data-agent-scope={scope} className="pointer-events-auto flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]">
      <div className={PANE_BAR}>
        <Sparkles size={14} className="shrink-0 text-[var(--text-dim)]" aria-hidden />
        <span className={PANE_TITLE}>{title}</span>
        <span className="shrink-0 rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[10px] leading-4 text-[var(--text-faint)]">对话</span>
        <span className="min-w-0 flex-1" />
        <button type="button" aria-label={confirmClear ? '确认删除对话记录' : '删除对话记录'} title={confirmClear ? '再点一次：永久删除' : '删除对话记录'}
          onClick={() => void clearConversation()} disabled={busy}
          className={`${PANE_BTN} ${confirmClear ? 'text-[var(--err)]' : ''} disabled:opacity-30`}><Trash2 size={13} /></button>
        <button type="button" aria-label={`关闭${title}`} onClick={onClose} className={PANE_BTN}><X size={14} /></button>
      </div>
      <div ref={scroller} onScroll={() => {
        const el = scroller.current;
        if (!el || !hydrated) return;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
        saveScroll(projectId, scope, el.scrollTop);
      }} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 py-2">
        <div className="flex flex-col gap-2">
          {configured === null ? (
            <p className="flex items-center gap-1.5 px-1 text-[10.5px] text-[var(--text-muted)]"><Loader2 size={11} className="animate-spin" />正在读取 {title}…</p>
          ) : configured === false ? (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
              <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">还没有可用的 {title}。请在设置 → 智能体 中启用并绑定模型。</p>
              {onOpenSettings ? (
                <button type="button" onClick={onOpenSettings}
                  className="mt-2 h-6 rounded-md bg-[var(--text)] px-2 text-[10.5px] font-medium text-[var(--panel)]">打开设置</button>
              ) : null}
            </div>
          ) : messages.map((message) => (
            <div key={message.id} className={`rounded-lg border px-2.5 py-2 text-[11.5px] leading-relaxed ${message.role === 'user' ? 'border-[var(--border)] bg-[var(--bg)] text-[var(--text-muted)]' : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-dim)]'}`}>
              {message.role === 'agent' ? <strong className="mr-1 text-[var(--text)]">AI</strong> : null}{message.text}
            </div>
          ))}
          {run ? <AgentRunDetails run={run} /> : null}
          {question ? (
            <div className="rounded-lg border border-[rgba(255,191,54,.3)] bg-[rgba(255,191,54,.05)] p-2.5">
              <p className="text-[11px] leading-relaxed text-[var(--warn)]">{question}</p>
              {questionOptions.length ? (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {questionOptions.map((option) => (
                    <button key={option} type="button" disabled={busy} onClick={() => void turn(option, true)}
                      className="rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-left text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40">{option}</button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {retryable ? (
            <button type="button" disabled={busy} onClick={retry}
              className="flex w-fit items-center gap-1 rounded-md border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] disabled:opacity-40">
              <RotateCcw size={11} />重试上一轮
            </button>
          ) : null}
          {busy ? <p className="flex items-center gap-1.5 px-1 text-[10.5px] text-[var(--text-muted)]"><Loader2 size={11} className="animate-spin" />思考中…</p> : null}
          {error ? <p role="alert" className="px-1 text-[10.5px] leading-relaxed text-[var(--err)]">{error}</p> : null}
        </div>
      </div>
      <div className="m-2.5 mt-0 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)]">
        <textarea ref={composer} value={ask} onChange={(e) => setAsk(e.target.value)}
          disabled={!ready}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          rows={3} placeholder={question ? '回答上面的问题…' : placeholder}
          aria-label={`给 ${title} 发消息`} className="block w-full resize-none rounded-t-lg bg-transparent px-2.5 pt-2 text-[11.5px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--text-faint)] disabled:opacity-50" />
        <div className="flex items-center gap-2 px-2 pb-1.5">
          <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <AgentContextMeter scope={scope} requestAt={requestAt} />
            <span className="truncate text-[9.5px] text-[var(--text-faint)]">Enter 发送 · Shift+Enter 换行</span>
          </span>
          {busy ? (
            <button type="button" onClick={stop} aria-label="停止本轮"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] ring-1 ring-inset ring-[var(--border)] hover:bg-[var(--bg-hover)] hover:text-[var(--err)]">
              <Square size={11} />
            </button>
          ) : null}
          <button type="button" disabled={!ask.trim() || busy || !ready} onClick={send} aria-label="发送"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--text)] text-[var(--panel)] transition disabled:opacity-30">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <ArrowUp size={14} />}
          </button>
        </div>
      </div>
    </aside>
  );
}
