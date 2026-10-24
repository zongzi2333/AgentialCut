/**
 * The developer's model-call log: a floating, non-modal window. It shows what Studio asked an LLM
 * or vision model, which agent/provider/model served it, how long it took, the reply and token
 * counts. It never covers the page with an overlay and never takes focus from the editor; the
 * header is the drag handle. HTTP endpoint noise is not shown here.
 */
import * as React from 'react';
import { ChevronDown, ChevronRight, Loader2, Trash2, X } from 'lucide-react';
import { api, type ModelLogEntry } from '@/api';

function tokens(entry: ModelLogEntry) {
  const usage = entry.usage;
  if (!usage) return '';
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  return `${input}→${output} tok`;
}

export function ApiLogWindow({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [entries, setEntries] = React.useState<ModelLogEntry[]>([]);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [expanded, setExpanded] = React.useState<number | null>(null);
  const [pos, setPos] = React.useState({ x: Math.max(16, window.innerWidth - 820), y: 48 });
  const drag = React.useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const read = React.useCallback(async () => {
    try { setEntries(await api.modelLogs(250)); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  React.useEffect(() => {
    if (!open) return undefined;
    setLoading(true);
    void read().finally(() => setLoading(false));
    const timer = setInterval(() => void read(), 1200);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { clearInterval(timer); window.removeEventListener('keydown', onKey); };
  }, [open, read, onClose]);

  React.useEffect(() => {
    if (!open) return undefined;
    const move = (event: PointerEvent) => {
      const held = drag.current;
      if (!held) return;
      setPos({
        x: Math.max(4, Math.min(window.innerWidth - 180, held.left + event.clientX - held.x)),
        y: Math.max(4, Math.min(window.innerHeight - 100, held.top + event.clientY - held.y)),
      });
    };
    const up = () => { drag.current = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed z-[10010] flex h-[470px] w-[800px] max-w-[calc(100vw-16px)] flex-col overflow-hidden rounded-[10px] border border-[var(--border-strong)] bg-[var(--panel)] shadow-[0_20px_70px_rgba(0,0,0,.4)]"
      style={{ left: pos.x, top: pos.y }}>
      <div className="flex h-9 shrink-0 cursor-grab items-center gap-2 border-b border-[var(--border-soft)] bg-[var(--surface-2)] px-3 active:cursor-grabbing"
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('button')) return;
          drag.current = { x: event.clientX, y: event.clientY, left: pos.x, top: pos.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}>
        <span className="text-[11.5px] font-medium text-[var(--text)]">模型调用日志</span>
        <span className="text-[10px] tabular-nums text-[var(--text-faint)]">{entries.length} 条 · 实时</span>
        <span className="min-w-0 flex-1" />
        {loading ? <Loader2 size={12} className="animate-spin text-[var(--text-faint)]" /> : null}
        <button type="button" aria-label="清空模型调用日志" onClick={() => void api.clearModelLogs().then(read).catch(() => {})} className="flex h-6 items-center gap-1 rounded px-1.5 text-[10px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"><Trash2 size={11} />清空</button>
        <button type="button" aria-label="关闭模型调用日志" onClick={onClose} className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"><X size={13} /></button>
      </div>
      {error ? <p className="px-3 py-2 text-[10.5px] text-[var(--err)]">{error}</p> : null}
      <div className="min-h-0 flex-1 overflow-auto font-mono text-[10.5px] leading-5">
        {entries.length ? entries.map((entry) => {
          const ok = entry.status === 'ok';
          const running = entry.status === 'running';
          const isOpen = expanded === entry.id;
          return (
            <div key={entry.id} className="border-b border-[var(--border-soft)]/60">
              <button type="button" onClick={() => setExpanded(isOpen ? null : entry.id)}
                className="grid w-full grid-cols-[52px_78px_minmax(140px,1fr)_92px_44px_58px_82px] items-center gap-2 px-3 py-1 text-left hover:bg-[var(--bg-hover)]">
                <span className="tabular-nums text-[var(--text-faint)]">{new Date(entry.at).toLocaleTimeString([], { hour12: false })}</span>
                <span className="truncate text-[var(--text-muted)]" title={`${entry.role}${entry.agent ? ` · ${entry.agent}` : ''}`}>{entry.role}{entry.agent ? ` · ${entry.agent}` : ''}</span>
                <span className="min-w-0 truncate text-[var(--text)]" title={`${entry.provider} · ${entry.model}`}>{entry.provider} · {entry.model}</span>
                <span className={`truncate ${running ? 'text-[var(--text-faint)]' : ok ? 'text-[var(--ok)]' : 'text-[var(--err)]'}`}>
                  {running ? <><Loader2 size={10} className="mr-1 inline animate-spin" />running</> : entry.status}
                </span>
                <span className="tabular-nums text-[var(--text-faint)]">{entry.ms} ms</span>
                <span className="truncate text-[9.5px] tabular-nums text-[var(--text-faint)]">{tokens(entry)}</span>
                <span className="flex items-center justify-end gap-1 text-[9.5px] text-[var(--text-faint)]">{entry.protocol}{isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</span>
              </button>
              {isOpen ? (
                <div className="grid gap-2 border-t border-[var(--border-soft)] bg-[var(--surface-2)] px-3 py-2 text-[10px]">
                  {entry.request.system ? (
                    <div>
                      <p className="mb-0.5 text-[var(--text-faint)]">System prompt</p>
                      <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--bg)] p-2 text-[var(--text-muted)]">{entry.request.system}</pre>
                    </div>
                  ) : null}
                  <div>
                    <p className="mb-0.5 text-[var(--text-faint)]">Messages</p>
                    {entry.request.messages.map((message, index) => (
                      <pre key={`${entry.id}_${index}`} className="mb-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--bg)] p-2 text-[var(--text-muted)]"><span className="text-[var(--text-faint)]">{message.role}: </span>{message.content}</pre>
                    ))}
                  </div>
                  <div>
                    <p className="mb-0.5 text-[var(--text-faint)]">{entry.status === 'error' ? 'Error' : 'Reply'}</p>
                    <pre className={`max-h-44 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--bg)] p-2 ${entry.status === 'error' ? 'text-[var(--err)]' : 'text-[var(--text)]'}`}>{entry.status === 'error' ? entry.error : entry.reply || '（等待返回）'}</pre>
                  </div>
                </div>
              ) : null}
            </div>
          );
        }) : <p className="px-3 py-4 text-[11px] text-[var(--text-faint)]">还没有模型调用。</p>}
      </div>
      <div className="shrink-0 border-t border-[var(--border-soft)] px-3 py-1 text-[9.5px] text-[var(--text-faint)]">记录 Agent 的模型请求与返回、耗时和 token；不记录密钥。</div>
    </div>
  );
}
