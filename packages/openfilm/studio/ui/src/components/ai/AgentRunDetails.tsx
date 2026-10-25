/**
 * What a conversation turn actually did.
 *
 * The backend exposes bounded tool calls and a change summary, never prompts or provider
 * payloads. This pane keeps that record small and inspectable: name, arguments summary, result,
 * changed documents and issues. Older runs without a run record render nothing.
 */
import * as React from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Wrench } from 'lucide-react';
import type { AgentChatResponse, AgentToolCall } from '@/api';

type AgentRun = Pick<AgentChatResponse, 'runId' | 'status' | 'toolCalls' | 'changed' | 'issues' | 'rev' | 'applied'>;

const STATUS: Record<NonNullable<AgentRun['status']>, string> = {
  done: '已完成',
  needs_input: '等待回答',
  budget: '未完成 · 可重试',
  error: '未完成',
};

function oneLine(value: unknown): string {
  if (value == null) return '';
  try {
    return JSON.stringify(value).replace(/^\{"|"\}$/g, '').replace(/","/g, ' · ').replace(/":"/g, '：').slice(0, 160);
  } catch {
    return String(value).slice(0, 160);
  }
}

function argsText(call: AgentToolCall): string {
  if (call.error) return call.error;
  if (call.summary) return call.summary;
  return oneLine(call.arguments);
}

function changeText(run: AgentRun): string[] {
  const changed = run.changed;
  /* A read tool returns the document too; only an applied run is a change. */
  if (run.applied === false) return [];
  const lines: string[] = [];
  if (changed?.storyboard) {
    lines.push(`分镜${changed.shots != null ? ` ${changed.shots} 镜` : ''}${changed.revision != null ? ` · rev ${changed.revision}` : ''}`);
  }
  if (changed?.timeline) {
    lines.push(`时间线${changed.clips != null ? ` ${changed.clips} 片段` : ''}${changed.rev != null ? ` · ${changed.rev}` : ''}`);
  }
  if (changed?.audio) lines.push(`音频素材${changed.assets != null ? ` ${changed.assets} 个` : ''}`);
  if (changed?.captions) lines.push(`字幕已更新${changed.captionLines != null ? ` · ${changed.captionLines} 行` : ''}`);
  if (changed?.workspace) lines.push(`工作区已更新${changed.workspaceFiles != null ? ` · ${changed.workspaceFiles} 个文件` : ''}`);
  if (changed?.tracks != null) lines.push(`轨道 ${changed.tracks}`);
  if (changed?.gaps != null) lines.push(`缺口 ${changed.gaps}`);
  if (!lines.length && run.rev != null) lines.push(`修订 ${run.rev}`);
  return lines;
}

/** Frames, media probes and QC rows are optional: a run that has none is unchanged. */
function resultFrames(call: AgentToolCall): Array<{ url: string; label: string }> {
  const result = call.result && typeof call.result === 'object' ? call.result as Record<string, unknown> : null;
  const raw = result && Array.isArray(result.frames) ? result.frames : result && Array.isArray(result.images) ? result.images : [];
  return raw.flatMap((item) => {
    if (typeof item === 'string') return [{ url: item, label: call.name }];
    if (!item || typeof item !== 'object') return [];
    const frame = item as Record<string, unknown>;
    const url = [frame.url, frame.thumbUrl, frame.dataUrl].find((value) => typeof value === 'string' && value);
    if (!url) return [];
    const at = typeof frame.timeMs === 'number' ? `${(frame.timeMs / 1000).toFixed(1)}s` : '';
    return [{ url: String(url), label: [call.name, at].filter(Boolean).join(' · ') }];
  }).slice(0, 6);
}

function resultIssues(call: AgentToolCall): string[] {
  const result = call.result && typeof call.result === 'object' ? call.result as Record<string, unknown> : null;
  return Array.isArray(result?.issues) ? result.issues.map(String).slice(0, 6) : [];
}

export function AgentRunDetails({ run, compact = false }: { run: AgentRun | null; compact?: boolean }) {
  if (!run) return null;
  const calls = run.toolCalls ?? [];
  const changes = changeText(run);
  const issues = run.issues ?? [];
  const status = run.status === 'done'
    ? run.applied ? '已应用' : issues.length ? '未完成' : '已回答'
    : run.status ? STATUS[run.status] : '';
  const tone = run.status === 'done'
    ? run.applied ? 'ok' : issues.length ? 'warn' : 'idle'
    : run.status === 'needs_input' ? 'warn' : run.status ? 'err' : 'idle';
  if (!calls.length && !changes.length && !issues.length && !status) return null;

  return (
    <div data-agent-run className={`rounded-lg border border-[var(--border)] bg-[var(--bg)] ${compact ? 'px-2 py-1.5' : 'p-2'}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[9.5px] text-[var(--text-faint)]">
        {run.status ? (
          <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-[1px] ${
            tone === 'ok' ? 'bg-[rgba(62,200,130,.1)] text-[var(--ok)]'
              : tone === 'warn' ? 'bg-[rgba(255,191,54,.1)] text-[var(--warn)]'
                : tone === 'err' ? 'bg-[rgba(235,77,77,.1)] text-[var(--err)]'
                  : 'bg-[var(--surface-2)] text-[var(--text-faint)]'
          }`}>
            {tone === 'ok' ? <CheckCircle2 size={10} /> : tone === 'warn' || tone === 'err' ? <AlertTriangle size={10} /> : <Loader2 size={10} />}
            {status}
          </span>
        ) : null}
        {run.runId ? <span className="truncate font-mono text-[9px] opacity-70" title={run.runId}>{run.runId}</span> : null}
      </div>

      {calls.length ? (
        <ul className="mt-1.5 flex flex-col gap-1">
          {calls.map((call, index) => (
            <li key={call.id ?? `${call.name}_${index}`} className="flex min-w-0 items-start gap-1.5 text-[10px] leading-relaxed">
              <Wrench size={10} className="mt-[2px] shrink-0 text-[var(--text-faint)]" />
              <span className={`shrink-0 font-mono ${call.status === 'error' ? 'text-[var(--err)]' : 'text-[var(--text)]'}`}>{call.name}</span>
              <span className={`min-w-0 flex-1 truncate ${call.status === 'error' ? 'text-[var(--err)]' : 'text-[var(--text-muted)]'}`} title={argsText(call)}>
                {argsText(call) || call.status}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {changes.length ? <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--text-muted)]">{changes.join(' · ')}</p> : null}
      {issues.length ? (
        <ul className="mt-1 flex flex-col gap-1 rounded-md border border-[rgba(255,191,54,.25)] bg-[rgba(255,191,54,.04)] px-1.5 py-1">
          {issues.slice(0, 4).map((issue) => (
            <li key={issue} className="truncate text-[10px] leading-relaxed text-[var(--warn)]" title={issue}>· {issue}</li>
          ))}
          {issues.length > 4 ? <li className="text-[9.5px] text-[var(--text-faint)]">另有 {issues.length - 4} 个问题</li> : null}
        </ul>
      ) : null}

      {calls.some((call) => resultFrames(call).length || resultIssues(call).length) ? (
        <div className="mt-1.5 flex flex-col gap-1">
          {calls.map((call, index) => (
            <React.Fragment key={`${call.id ?? call.name}_result_${index}`}>
              {resultFrames(call).length ? (
                <div className="flex flex-wrap gap-1">
                  {resultFrames(call).map((frame) => (
                    <figure key={frame.url} className="w-16">
                      <img src={frame.url} alt="" className="h-10 w-16 rounded object-cover ring-1 ring-inset ring-[var(--border)]" />
                      <figcaption className="truncate text-[8.5px] text-[var(--text-faint)]" title={frame.label}>{frame.label}</figcaption>
                    </figure>
                  ))}
                </div>
              ) : null}
              {resultIssues(call).map((issue) => <p key={`${call.id ?? call.name}_${issue}`} className="truncate text-[9.5px] text-[var(--warn)]" title={issue}>· {issue}</p>)}
            </React.Fragment>
          ))}
        </div>
      ) : null}
    </div>
  );
}
