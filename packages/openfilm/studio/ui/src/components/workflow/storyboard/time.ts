/** Source time for a storyboard candidate: seconds matter here, so the tenth is kept. */
export function sourceTime(ms: number): string {
  const safe = Math.max(0, Math.round(Number(ms) || 0));
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const tenths = Math.floor((safe % 1000) / 100);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

export function durationSeconds(ms: number): string {
  return `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)}s`;
}
