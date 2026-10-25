/**
 * The editing stage's AI conversation. It uses the same conversation agent and controlled tool
 * surface as the storyboard pane: answers about the cut, continuity, pacing and what to change,
 * and applies validated timeline operations. Studio's undo remains the safety net.
 */
import * as React from 'react';
import { ArrowUp, Loader2, Sparkles, X } from 'lucide-react';
import { api } from '@/api';
import { PANE_BAR, PANE_BTN, PANE_TITLE } from '../dock-pane-bar';

type Message = { id: string; role: 'user' | 'agent'; text: string };
const WELCOME = '我可以帮你分析节奏、连续性、镜头取舍和下一步怎么剪。告诉我你想改什么，或直接问当前时间线的问题。';

export function EditChatPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const [ask, setAsk] = React.useState('');
  const [messages, setMessages] = React.useState<Message[]>([
    { id: 'hello', role: 'agent', text: WELCOME },
  ]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const composer = React.useRef<HTMLTextAreaElement>(null);
  const scroller = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [messages, busy]);
  React.useEffect(() => {
    let live = true;
    void api.agentChatHistory(projectId, 'edit').then((stored) => {
      if (!live) return;
      setMessages(stored.length ? stored : [{ id: 'hello', role: 'agent', text: WELCOME }]);
    }).catch(() => { /* the panel still works when history cannot be read */ });
    return () => { live = false; };
  }, [projectId]);

  const send = async () => {
    const text = ask.trim();
    if (!text || busy) return;
    const id = `m_${Date.now()}`;
    setAsk('');
    setError('');
    setMessages((current) => [...current, { id, role: 'user', text }]);
    setBusy(true);
    try {
      const result = await api.agentChat(projectId, { text, scope: 'edit' });
      const reply = result.applied ? `${result.reply}（已应用到时间线）` : result.reply;
      setMessages((current) => [...current, { id: `${id}_a`, role: 'agent', text: reply }]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside data-edit-ai-chat className="pointer-events-auto flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[7px] bg-[var(--dock-pane)]">
      <div className={PANE_BAR}>
        <Sparkles size={14} className="shrink-0 text-[var(--text-dim)]" aria-hidden />
        <span className={PANE_TITLE}>AI 剪辑助手</span>
        <span className="shrink-0 rounded-full border border-[var(--border)] px-1.5 py-[1px] text-[10px] leading-4 text-[var(--text-faint)]">对话</span>
        <span className="min-w-0 flex-1" />
        <button type="button" aria-label="关闭 AI 聊天" onClick={onClose} className={PANE_BTN}><X size={14} /></button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2.5 py-2">
        <div className="flex flex-col gap-2">
          {messages.map((message) => (
            <div key={message.id} className={`rounded-lg border px-2.5 py-2 text-[11.5px] leading-relaxed ${message.role === 'user' ? 'border-[var(--border)] bg-[var(--bg)] text-[var(--text-muted)]' : 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-dim)]'}`}>
              {message.role === 'agent' ? <strong className="mr-1 text-[var(--text)]">AI</strong> : null}{message.text}
            </div>
          ))}
          {busy ? <p className="flex items-center gap-1.5 px-1 text-[10.5px] text-[var(--text-muted)]"><Loader2 size={11} className="animate-spin" />思考中…</p> : null}
          {error ? <p role="alert" className="px-1 text-[10.5px] leading-relaxed text-[var(--err)]">{error}</p> : null}
        </div>
      </div>
      <div className="m-2.5 mt-0 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)]">
        <textarea ref={composer} value={ask} onChange={(e) => setAsk(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
          rows={3} placeholder="例如：开头太拖了，帮我看看怎么剪；或问这段的连续性。"
          aria-label="给 AI 剪辑助手发消息" className="block w-full resize-none rounded-t-lg bg-transparent px-2.5 pt-2 text-[11.5px] leading-relaxed text-[var(--text)] outline-none placeholder:text-[var(--text-faint)]" />
        <div className="flex items-center gap-2 px-2 pb-1.5">
          <span className="min-w-0 flex-1 truncate text-[9.5px] text-[var(--text-faint)]">Enter 发送 · Shift+Enter 换行</span>
          <button type="button" disabled={!ask.trim() || busy} onClick={() => void send()} aria-label="发送"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-[var(--text)] text-[var(--panel)] transition disabled:opacity-30">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <ArrowUp size={14} />}
          </button>
        </div>
      </div>
    </aside>
  );
}
