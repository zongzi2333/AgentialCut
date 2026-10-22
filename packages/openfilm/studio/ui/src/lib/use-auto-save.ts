/**
 * Debounced auto-saving for the editable Settings pages.
 *
 * A value is saved a short moment after it stops changing. Saves run one after another; a save that
 * returns a newer server value does not overwrite edits made while it was in flight. `markSaved` is
 * called once after the initial read, so opening a page never writes it back unchanged.
 */
import * as React from 'react';

export type AutoSaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface AutoSave<T> {
  status: AutoSaveStatus;
  error: string;
  /** call once with the value read from the server */
  markSaved: (value: T) => void;
  /** save the latest value now (leaving the page, applying a destructive action) */
  flush: () => Promise<void>;
}

export function useAutoSave<T>({
  value,
  save,
  enabled = true,
  delay = 700,
  onSaved,
}: {
  value: T;
  save: (value: T) => Promise<T>;
  enabled?: boolean;
  delay?: number;
  onSaved?: (saved: T) => void;
}): AutoSave<T> {
  const [status, setStatus] = React.useState<AutoSaveStatus>('idle');
  const [error, setError] = React.useState('');
  const [ready, setReady] = React.useState(false);
  const latest = React.useRef(value);
  const saved = React.useRef('');
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = React.useRef<Promise<void>>(Promise.resolve());
  const alive = React.useRef(true);
  const saveRef = React.useRef(save);
  const savedRef = React.useRef(onSaved);
  latest.current = value;
  saveRef.current = save;
  savedRef.current = onSaved;
  const fingerprint = React.useMemo(() => JSON.stringify(value), [value]);

  React.useEffect(() => () => { alive.current = false; }, []);

  const markSaved = React.useCallback((next: T) => {
    saved.current = JSON.stringify(next);
    setReady(true);
    setStatus('idle');
    setError('');
  }, []);

  const run = React.useCallback(async (next: T) => {
    if (JSON.stringify(next) === saved.current) return;
    setStatus('saving');
    setError('');
    try {
      const result = await saveRef.current(next);
      if (!alive.current) return;
      saved.current = JSON.stringify(result);
      savedRef.current?.(result);
      setStatus('saved');
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, []);

  const flush = React.useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const next = latest.current;
    chain.current = chain.current.then(() => run(next)).catch(() => {});
    await chain.current;
  }, [run]);

  React.useEffect(() => {
    if (!ready) return;
    if (!enabled) { setStatus('pending'); return; }
    if (fingerprint === saved.current) return;
    if (timer.current) clearTimeout(timer.current);
    setStatus('pending');
    timer.current = setTimeout(() => {
      timer.current = null;
      const next = latest.current;
      chain.current = chain.current.then(() => run(next)).catch(() => {});
    }, delay);
    return () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  }, [fingerprint, enabled, ready, delay, run]);

  /* leaving the page is not a reason to lose the last character typed */
  React.useEffect(() => () => {
    if (!ready || timer.current == null) return;
    clearTimeout(timer.current);
    timer.current = null;
    void saveRef.current(latest.current).catch(() => {});
  }, [ready]);

  return { status, error, markSaved, flush };
}
