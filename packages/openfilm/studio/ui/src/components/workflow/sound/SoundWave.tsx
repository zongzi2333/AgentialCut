/**
 * A sound's envelope, drawn once, clicked to find a place in it.
 *
 * It is the whole file (as the audition plays it), with the part a clip uses left bright and the rest dimmed, so a
 * trim reads at a glance; the playhead is a line over the picture, not a redrawing of it. Peaks come from
 * `GET audio/asset?what=wave` (or the film's own `media?what=wave`), 40 a second, 0..1.
 */
import * as React from 'react';
import { normalizeWavePeaks, waveformColumns } from '@/lib/waveform-columns';
import { useThemeChanges } from '@/lib/theme-changes';
import { clamp } from '@/lib/sound';

/** At most this many device pixels a canvas is given: past the browser's limit it goes blank. */
const MAX_CANVAS_PX = 4096;

export function SoundWave({
  peaks, durationMs, inMs = 0, outMs, posMs = 0, height = 88, color = 'var(--tl-wave)', onSeek, className = '',
}: {
  peaks: readonly number[] | null;
  /** The file's whole length, in ms. */
  durationMs: number;
  /** The part a clip plays (the whole file when no clip is selected). */
  inMs?: number;
  outMs?: number;
  /** The audition's place in the file. */
  posMs?: number;
  height?: number;
  /** A CSS color or variable: read back from the canvas as it draws, so a theme change redraws it. */
  color?: string;
  onSeek?: (ms: number) => void;
  className?: string;
}) {
  const boxRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);
  const theme = useThemeChanges();

  React.useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return undefined;
    const measure = () => setWidth(Math.max(0, Math.round(box.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  const usable = React.useMemo(() => (peaks?.length ? normalizeWavePeaks(peaks) : null), [peaks]);
  const from = Math.max(0, inMs);
  const to = Math.max(from, outMs ?? durationMs);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !usable?.length || !width || durationMs <= 0) return;
    const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, MAX_CANVAS_PX / width));
    canvas.width = Math.max(1, Math.round(width * dpr));
    canvas.height = Math.max(1, Math.round(height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    /* its color is the theme's: the variable is set as the element's color and read back computed */
    ctx.fillStyle = getComputedStyle(canvas).color || color;
    const columns = waveformColumns({ peaks: usable, durationMs }, 0, durationMs, width);
    ctx.beginPath();
    for (let x = 0; x < width; x += 1) {
      const v = columns[x] ?? 0;
      const h = Math.max(1, v * (height - 2));
      ctx.rect(x, height - h, 1, h);
    }
    ctx.fill();
    /* the parts this clip does not play are dimmed rather than cut: a trim is a window on the file, not another file */
    const xFrom = width * clamp(from / durationMs, 0, 1);
    const xTo = width * clamp(to / durationMs, 0, 1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
    if (xFrom > 0) ctx.fillRect(0, 0, xFrom, height);
    if (xTo < width) ctx.fillRect(xTo, 0, width - xTo, height);
  }, [usable, width, height, color, durationMs, from, to, theme]);

  const seek = React.useCallback((clientX: number) => {
    const box = boxRef.current;
    if (!box || !onSeek || durationMs <= 0) return;
    const rect = box.getBoundingClientRect();
    onSeek(clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1) * durationMs);
  }, [durationMs, onSeek]);

  const head = durationMs > 0 ? clamp(posMs / durationMs, 0, 1) : 0;
  return (
    <div
      ref={boxRef}
      data-sound-wave
      className={`relative overflow-hidden rounded-md bg-[var(--surface-2)] ${onSeek ? 'cursor-text' : ''} ${className}`}
      style={{ height: height + 2, color }}
      onPointerDown={(event) => {
        if (!onSeek || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        seek(event.clientX);
      }}
      onPointerMove={(event) => { if (dragging) seek(event.clientX); }}
      onPointerUp={(event) => {
        if (!dragging) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
      }}
      onPointerCancel={() => setDragging(false)}
    >
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-x-0 top-0" style={{ width, height }} />
      {usable?.length ? null : (
        <span className="absolute inset-0 flex items-center justify-center text-[10.5px] text-[var(--text-faint)]">—</span>
      )}
      {durationMs > 0 ? (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-0 top-0 w-px"
          style={{ left: `${head * 100}%`, background: 'var(--tl-playhead)' }}
        >
          <span className="absolute -left-[3px] top-0 h-[5px] w-[7px] rounded-[1px]" style={{ background: 'var(--tl-playhead)' }} />
        </span>
      ) : null}
    </div>
  );
}
