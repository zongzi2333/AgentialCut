/**
 * The one preview used by storyboard cards and the material shelf: a video plays only its candidate
 * range (or the whole file), a still is shown as itself. Right-click, a click on the empty backdrop,
 * Escape, or the close button all dismiss it.
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
}

export function MediaPreviewDialog({ target, onClose }: { target: PreviewTarget | null; onClose: () => void }) {
  const video = React.useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!target) return undefined;
    setFailed(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); onClose(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [target, onClose]);

  React.useEffect(() => {
    if (!target || target.kind !== 'video') return;
    const el = video.current;
    if (!el) return;
    const start = (target.startMs ?? 0) / 1000;
    const end = target.endMs && target.endMs > (target.startMs ?? 0) ? target.endMs / 1000 : null;
    const seek = () => {
      try { el.currentTime = Math.max(0, start); } catch { /* the file may not be seekable yet */ }
      void el.play().catch(() => {});
    };
    const onTime = () => {
      if (end != null && el.currentTime >= end) {
        el.pause();
        try { el.currentTime = Math.max(0, start); } catch { /* ignore */ }
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
  return (
    <div className="fixed inset-0 z-[10200] flex items-center justify-center bg-black/70 p-5 backdrop-blur-[3px]"
      onClick={onClose} onContextMenu={(event) => { event.preventDefault(); onClose(); }}>
      <div className="relative flex max-h-[92vh] w-full max-w-[min(1100px,92vw)] flex-col overflow-hidden rounded-[10px] border border-white/15 bg-black shadow-[0_24px_80px_rgba(0,0,0,.5)]"
        onClick={(event) => event.stopPropagation()}>
        <div className="flex shrink-0 items-center gap-2 border-b border-white/10 px-3 py-2 text-white/70">
          <span className="min-w-0 flex-1 truncate text-[12px]">{target.title}</span>
          <button type="button" aria-label="关闭预览" onClick={onClose} className="flex h-6 w-6 items-center justify-center rounded hover:bg-white/10 hover:text-white"><X size={14} /></button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black">
          {failed ? <span className="p-8 text-[12px] text-white/60">无法加载这段媒体</span> : target.kind === 'image' ? (
            <img src={target.src} alt="" className="max-h-[82vh] max-w-full object-contain" draggable={false} onError={() => setFailed(true)} />
          ) : (
            <video ref={video} src={target.src} poster={target.poster} controls playsInline className="max-h-[82vh] max-w-full bg-black" onError={() => setFailed(true)} />
          )}
        </div>
        <div className="flex shrink-0 items-center justify-center gap-3 border-t border-white/10 px-3 py-1.5 text-[10px] text-white/45">
          <span>右键、点击空白处或 Esc 关闭</span>
          {target.kind === 'video' && target.endMs ? <span className="tabular-nums">{((target.startMs ?? 0) / 1000).toFixed(1)}s – {(target.endMs / 1000).toFixed(1)}s</span> : null}
        </div>
      </div>
    </div>
  );
}
