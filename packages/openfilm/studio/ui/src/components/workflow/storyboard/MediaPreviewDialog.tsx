/**
 * The one preview used by storyboard cards and the material shelf: a video plays, a still is shown as
 * itself. I and O mark an in/out range without cutting the file; the range is handed back when the
 * dialog closes so using the material can take only that part, and opening it again can widen it.
 * Right-click, a click on the empty backdrop, Escape, or the close button all dismiss it.
 */
import * as React from 'react';
import { X } from 'lucide-react';

export interface PreviewTarget {
  title: string;
  src: string;
  poster?: string;
  kind: 'video' | 'image' | 'other';
  startMs?: number;
  endMs?: number;
  /** the library path, when this preview can remember a range for a material */
  id?: string;
  /** when the preview is a candidate, where it belongs */
  shotId?: string;
  candidateId?: string;
}

export interface PreviewRange {
  startMs: number;
  endMs: number;
  /** the person pressed I or O; a range merely shown is not a choice to keep */
  edited?: boolean;
}

const time = (ms: number) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

export function MediaPreviewDialog({ target, onClose }: { target: PreviewTarget | null; onClose: (range?: PreviewRange) => void }) {
  const video = React.useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = React.useState(false);
  const [durationMs, setDurationMs] = React.useState(0);
  const [markIn, setMarkIn] = React.useState(0);
  const [markOut, setMarkOut] = React.useState<number | null>(null);
  const edited = React.useRef(false);

  React.useEffect(() => {
    if (!target) return;
    setFailed(false);
    edited.current = false;
    setMarkIn(Math.max(0, target.startMs ?? 0));
    setMarkOut(target.endMs && target.endMs > (target.startMs ?? 0) ? target.endMs : null);
    setDurationMs(target.endMs && target.endMs > (target.startMs ?? 0) ? target.endMs : 0);
  }, [target]);

  const range = React.useCallback((): PreviewRange | undefined => {
    if (!target || target.kind !== 'video') return undefined;
    const end = markOut ?? durationMs;
    if (!(end > markIn)) return undefined;
    return { startMs: Math.max(0, Math.round(markIn)), endMs: Math.round(end), edited: edited.current };
  }, [target, markIn, markOut, durationMs]);
  const finish = React.useCallback(() => onClose(range()), [onClose, range]);

  React.useEffect(() => {
    if (!target) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        finish();
        return;
      }
      if (target.kind !== 'video') return;
      const key = event.key.toLowerCase();
      if (key !== 'i' && key !== 'o') return;
      const el = video.current;
      if (!el) return;
      event.preventDefault();
      event.stopPropagation();
      edited.current = true;
      const at = Math.round(el.currentTime * 1000);
      if (key === 'i') {
        setMarkIn(at);
        setMarkOut((current) => current != null && current <= at ? null : current);
      } else {
        setMarkOut(at > markIn ? at : null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [target, markIn, finish]);

  const bounds = React.useRef({ startMs: 0, endMs: 0 });
  bounds.current = { startMs: markIn, endMs: markOut ?? durationMs };

  React.useEffect(() => {
    if (!target || target.kind !== 'video') return;
    const el = video.current;
    if (!el) return;
    const seek = () => {
      const start = bounds.current.startMs / 1000;
      try { el.currentTime = Math.max(0, start); } catch { /* not seekable yet */ }
      void el.play().catch(() => {});
    };
    const onTime = () => {
      const { startMs, endMs } = bounds.current;
      if (endMs > startMs && el.currentTime >= endMs / 1000) {
        el.pause();
        try { el.currentTime = Math.max(0, startMs / 1000); } catch { /* ignore */ }
      }
    };
    el.addEventListener('loadedmetadata', seek);
    el.addEventListener('timeupdate', onTime);
    if (el.readyState >= 1) seek();
    return () => {
      el.removeEventListener('loadedmetadata', seek);
      el.removeEventListener('timeupdate', onTime);
      el.pause();
    };
  }, [target]);

  if (!target) return null;
  const endMs = markOut ?? durationMs;
  return (
    <div data-media-preview="" role="dialog" aria-modal="true" className="fixed inset-0 z-[10200] flex items-center justify-center bg-black/70 p-5 backdrop-blur-[3px]"
      onClick={finish} onContextMenu={(event) => { event.preventDefault(); finish(); }}>
      <div className="relative flex max-h-[92vh] w-full max-w-[min(1100px,92vw)] flex-col overflow-hidden rounded-[10px] border border-white/15 bg-black shadow-[0_24px_80px_rgba(0,0,0,.5)]"
        onClick={(event) => event.stopPropagation()}>
        <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2 text-white/70">
          <span className="min-w-0 flex-1 truncate text-[12px]">{target.title}</span>
          <button type="button" aria-label="关闭预览" onClick={finish} className="flex h-6 w-6 items-center justify-center rounded hover:bg-white/10 hover:text-white"><X size={14} /></button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
          {failed ? <span className="p-8 text-[12px] text-white/60">无法加载这段媒体</span> : target.kind === 'image' ? (
            <img src={target.src} alt="" className="max-h-[82vh] max-w-full object-contain" draggable={false} onError={() => setFailed(true)} />
          ) : (
            <video ref={video} src={target.src} poster={target.poster} controls playsInline
              className="max-h-[82vh] max-w-full bg-black" onError={() => setFailed(true)}
              onLoadedMetadata={(event) => { const ms = Math.round(event.currentTarget.duration * 1000); if (Number.isFinite(ms) && ms > 0) { setDurationMs(ms); setMarkOut((current) => current ?? ms); } }} />
          )}
        </div>
        {target.kind === 'video' ? (
          <div className="shrink-0 border-t border-white/10 px-3 py-2 text-[10px] text-white/55">
            <div className="relative mx-0.5 h-1.5 rounded-full bg-white/20">
              {durationMs > 0 ? <span className="absolute inset-y-0 rounded-full bg-white/45" style={{ left: `${Math.min(100, (markIn / durationMs) * 100)}%`, right: `${Math.min(100, 100 - (endMs / durationMs) * 100)}%` }} /> : null}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>I 入点 <b className="font-mono font-normal text-white/85">{time(markIn)}</b></span>
              <span>O 出点 <b className="font-mono font-normal text-white/85">{endMs > 0 ? time(endMs) : '—'}</b></span>
              <span>片段 <b className="font-mono font-normal text-white/85">{endMs > markIn ? time(endMs - markIn) : '—'}</b></span>
              <span className="ml-auto">I / O 设置入点、出点；可再次打开扩大范围</span>
            </div>
          </div>
        ) : null}
        <div className="flex shrink-0 items-center justify-center gap-3 border-t border-white/10 px-3 py-1.5 text-[10px] text-white/45">
          <span>右键、点击空白处或 Esc 关闭</span>
          {target.kind === 'video' && endMs > 0 ? <span className="tabular-nums">{time(markIn)} – {time(endMs)}</span> : null}
        </div>
      </div>
    </div>
  );
}
