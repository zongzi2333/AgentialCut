/**
 * How much of the selected model's context the latest request used.
 *
 * Studio already logs each provider call with its token usage; this reads the newest call after the chat request
 * started and pairs it with the model's advertised context window. No tokens are guessed from characters.
 */
import * as React from 'react';
import { api, type AgentChatScope } from '@/api';

const ROLE: Record<AgentChatScope, 'storyboard' | 'conversation' | 'audio'> = {
  storyboard: 'storyboard',
  edit: 'conversation',
  audio: 'audio',
};

const compact = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k` : String(value);

export function AgentContextMeter({ scope, requestAt }: { scope: AgentChatScope; requestAt: number | null }) {
  const [input, setInput] = React.useState<number | null>(null);
  const [limit, setLimit] = React.useState<number | null>(null);
  const [model, setModel] = React.useState('');

  React.useEffect(() => {
    let live = true;
    void Promise.all([api.agentCards(), api.providerCards()]).then(([agents, providers]) => {
      if (!live) return;
      const agent = agents.state.agents.find((item) => item.role === ROLE[scope]);
      const card = providers.state.cards.find((item) => item.id === agent?.cardId);
      const chosen = card?.models.find((item) => item.id === agent?.modelId)
        ?? card?.models.find((item) => item.id === card.defaultModelId)
        ?? card?.models.find((item) => typeof item.context === 'number');
      setLimit(typeof chosen?.context === 'number' && chosen.context > 0 ? chosen.context : null);
      setModel(chosen?.name ?? '');
    }).catch(() => { /* the meter stays hidden without card facts */ });
    return () => { live = false; };
  }, [scope]);

  React.useEffect(() => {
    if (requestAt == null) {
      setInput(null);
      return undefined;
    }
    let live = true;
    let timer = 0;
    let tries = 0;
    const read = () => {
      void api.modelLogs(80).then((entries) => {
        if (!live) return;
        const hit = entries.find((entry) => entry.at >= requestAt - 1500 && entry.role === ROLE[scope] && entry.usage?.input);
        if (hit?.usage?.input) {
          setInput(Number(hit.usage.input));
          return;
        }
        if (tries < 3) {
          tries += 1;
          timer = window.setTimeout(read, 500);
        }
      }).catch(() => { /* no meter without logs */ });
    };
    read();
    return () => { live = false; window.clearTimeout(timer); };
  }, [requestAt, scope]);

  if (input == null || input <= 0) return null;
  const percent = limit ? Math.min(100, (input / limit) * 100) : null;
  const title = limit
    ? `最近一次模型请求：输入 ${input} tokens / 上下文窗口 ${limit} tokens${model ? ` · ${model}` : ''}`
    : `最近一次模型请求：输入 ${input} tokens；上下文窗口未设置（设置 → 提供商 → 模型里的“窗口”）${model ? ` · ${model}` : ''}`;

  return (
    <span data-agent-context className="inline-flex shrink-0 items-center gap-1 text-[9px] text-[var(--text-faint)]" title={title}>
      <span>上下文</span>
      {percent != null ? (
        <span className="h-1 w-10 overflow-hidden rounded-full bg-[var(--border)]" aria-hidden>
          <span className={`block h-full rounded-full ${percent > 85 ? 'bg-[var(--err)]' : percent > 60 ? 'bg-[var(--warn)]' : 'bg-[var(--ok)]'}`} style={{ width: `${Math.max(2, percent)}%` }} />
        </span>
      ) : null}
      <span className="tabular-nums">{compact(input)}{limit ? `/${compact(limit)}` : '/—'}</span>
    </span>
  );
}
