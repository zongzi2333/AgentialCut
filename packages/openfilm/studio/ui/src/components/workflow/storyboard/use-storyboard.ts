/**
 * The storyboard step's data hook: one document, a short debounce for inline edits, and explicit
 * operations for the things that must not be guessed (generate, match, chat, apply, handoff).
 *
 * The document is owned by the server (`.film/storyboard.json`). Inline edits are optimistic and
 * saved with the revision they were based on; a 409 means another window wrote first, so we stop
 * guessing and reload instead of overwriting it.
 */
import * as React from 'react';
import { api, ApiError, type StoryboardChatResponse, type StoryboardDocument, type StoryboardProposal } from '@/api';

export interface StoryboardHistory {
  /** Oldest first; the label is an i18n key. */
  steps: Array<{ label: string; at: number }>;
  /** Steps before the cursor are applied, after it undone. */
  cursor: number;
}

export interface StoryboardState {
  doc: StoryboardDocument | null;
  loading: boolean;
  saving: boolean;
  error: string;
  /** a generation, match, chat or handoff is running */
  busy: string;
  load: () => Promise<void>;
  /** Re-read after a server-side edit without unmounting the board; the old document stays undoable. */
  refresh: () => Promise<void>;
  update: (change: (draft: StoryboardDocument) => void) => void;
  flush: () => Promise<void>;
  undo: () => void;
  redo: () => void;
  rollbackTo: (cursor: number) => void;
  history: StoryboardHistory;
  canUndo: boolean;
  canRedo: boolean;
  generate: (body: { text?: string; prompt?: string; brief?: Partial<StoryboardDocument['brief']> }) => Promise<'success' | 'failed'>;
  match: (shotIds?: string[], topK?: number) => Promise<'success' | 'failed'>;
  fill: (shotId: string, prompt: string, duration?: number) => Promise<'success' | 'failed'>;
  chat: (text: string, selectedIds: string[], signal?: AbortSignal) => Promise<StoryboardChatResponse | null>;
  apply: (proposal: Pick<StoryboardProposal, 'baseRevision'>, operations: Array<Record<string, unknown>>) => Promise<boolean>;
  handoff: () => Promise<{ clips: { shotId: string; path: string; name: string; startMs: number; endMs: number; durationMs: number }[]; gaps: string[] } | null>;
}

const clone = <T,>(value: T): T => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)) as T);

export function useStoryboard(projectId: string): StoryboardState {
  const [doc, setDoc] = React.useState<StoryboardDocument | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState('');
  const live = React.useRef(true);
  const current = React.useRef<StoryboardDocument | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  /** There are inline edits not yet written to the server. `flush` must not save an unchanged
      document: saving bumps the revision, and an AI edit based on the old revision would then be
      rejected as a conflict. */
  const dirty = React.useRef(false);
  /** Every commit that made a new document is a step; undo/redo/rollback only move the cursor. */
  const history = React.useRef<Array<{ doc: StoryboardDocument; label: string; at: number }>>([]);
  const cursor = React.useRef(0);
  const [historyVersion, setHistoryVersion] = React.useState(0);
  const [canUndo, setCanUndo] = React.useState(false);
  const [canRedo, setCanRedo] = React.useState(false);

  const say = React.useCallback((value: unknown) => {
    setError(value instanceof ApiError ? value.message : value instanceof Error ? value.message : String(value ?? ''));
  }, []);

  const syncHistory = React.useCallback(() => {
    /* cursor counts applied steps: the opening document is step 1, so undo never goes behind it. */
    setCanUndo(cursor.current > 1);
    setCanRedo(cursor.current < history.current.length);
    setHistoryVersion((value) => value + 1);
  }, []);

  const resetHistory = React.useCallback((next: StoryboardDocument, label: string) => {
    history.current = [{ doc: clone(next), label, at: Date.now() }];
    cursor.current = 1;
    syncHistory();
  }, [syncHistory]);

  const pushHistory = React.useCallback((next: StoryboardDocument, label: string) => {
    const steps = history.current.slice(0, cursor.current);
    steps.push({ doc: clone(next), label, at: Date.now() });
    history.current = steps.slice(-100);
    cursor.current = history.current.length;
    syncHistory();
  }, [syncHistory]);

  const commit = React.useCallback((next: StoryboardDocument) => {
    current.current = next;
    dirty.current = false;
    if (!live.current) return;
    setDoc(next);
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.storyboard(projectId);
      if (!live.current) return;
      commit(next);
      resetHistory(next, 'history.stepOpenStoryboard');
      setError('');
    } catch (e) {
      say(e);
    } finally {
      if (live.current) setLoading(false);
    }
  }, [projectId, commit, resetHistory, say]);

  React.useEffect(() => {
    live.current = true;
    current.current = null;
    setDoc(null);
    void load();
    return () => {
      live.current = false;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        /* leaving the step is not a reason to lose the last inline edit */
        if (current.current) void api.saveStoryboard(projectId, current.current, current.current.revision).catch(() => {});
      }
    };
  }, [load]);

  const saveNow = React.useCallback(async (next: StoryboardDocument) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (!next || next.revision < 0) return;
    setSaving(true);
    try {
      const saved = await api.saveStoryboard(projectId, next, next.revision);
      if (!live.current) return;
      commit(saved);
      setError('');
    } catch (e) {
      say(e);
      /* someone else wrote first: show theirs rather than silently overwrite */
      if (e instanceof ApiError && e.status === 409) await load();
    } finally {
      if (live.current) setSaving(false);
    }
  }, [projectId, commit, say, load]);

  const schedule = React.useCallback((next: StoryboardDocument) => {
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { void saveNow(next); }, 650);
  }, [saveNow]);

  const update = React.useCallback((change: (draft: StoryboardDocument) => void) => {
    const prior = current.current;
    if (!prior) return;
    const next = clone(prior);
    change(next);
    next.updatedAt = Date.now();
    commit(next);
    pushHistory(next, 'history.stepStoryboardEdit');
    schedule(next);
  }, [commit, pushHistory, schedule]);

  /** Read a server-applied document without blanking the stage; the old one joins the undo stack. */
  const refresh = React.useCallback(async () => {
    const next = await api.storyboard(projectId);
    if (!live.current) return;
    commit(next);
    pushHistory(next, 'history.stepAiStoryboard');
    setError('');
  }, [projectId, commit, pushHistory]);

  const goTo = React.useCallback((applied: number) => {
    const index = applied - 1;
    const step = history.current[index];
    if (!step || !current.current || applied < 1 || applied > history.current.length) return;
    cursor.current = applied;
    syncHistory();
    const next = clone(step.doc);
    /* restore the older content on top of the current revision */
    next.revision = current.current.revision;
    commit(next);
    schedule(next);
  }, [commit, schedule, syncHistory]);

  const undo = React.useCallback(() => goTo(cursor.current - 1), [goTo]);
  const redo = React.useCallback(() => goTo(cursor.current + 1), [goTo]);
  const rollbackTo = React.useCallback((index: number) => goTo(index), [goTo]);

  const generate = React.useCallback(async (body: { text?: string; prompt?: string; brief?: Partial<StoryboardDocument['brief']> }) => {
    setBusy('generate');
    try {
      const result = await api.generateStoryboard(projectId, body);
      commit(result.storyboard);
      resetHistory(result.storyboard, 'history.stepGenerateStoryboard');
      setError('');
      return 'success' as const;
    } catch (e) {
      say(e);
      return 'failed' as const;
    } finally {
      setBusy('');
    }
  }, [projectId, commit, resetHistory, say]);

  const match = React.useCallback(async (shotIds?: string[], topK?: number) => {
    setBusy('match');
    try {
      const next = await api.matchStoryboard(projectId, { ...(shotIds?.length ? { shotIds } : {}), ...(topK ? { topK } : {}) });
      commit(next);
      pushHistory(next, 'history.stepMatchStoryboard');
      setError('');
      return 'success' as const;
    } catch (e) {
      say(e);
      return 'failed' as const;
    } finally {
      setBusy('');
    }
  }, [projectId, commit, pushHistory, say]);

  const fill = React.useCallback(async (shotId: string, prompt: string, duration?: number) => {
    setBusy('fill');
    try {
      const result = await api.fillStoryboard(projectId, { shotId, prompt, ...(duration ? { duration } : {}) });
      commit(result.storyboard);
      pushHistory(result.storyboard, 'history.stepFillStoryboard');
      setError('');
      return 'success' as const;
    } catch (e) {
      say(e);
      return 'failed' as const;
    } finally {
      setBusy('');
    }
  }, [projectId, commit, pushHistory, say]);

  const chat = React.useCallback(async (text: string, selectedIds: string[], signal?: AbortSignal) => {
    setBusy('chat');
    try {
      const result = await api.agentChat(projectId, { text, selectedIds, scope: 'storyboard', signal });
      setError('');
      return result as StoryboardChatResponse;
    } catch (e) {
      /* Aborting the fetch is the stop button, not a failed storyboard edit. */
      if ((e as { name?: string } | null)?.name === 'AbortError') {
        setError('');
        return { reply: '已停止本轮。已完成的工具修改会保留，请检查当前分镜。', issues: ['本轮由用户停止'] } as StoryboardChatResponse;
      }
      say(e);
      return null;
    } finally {
      setBusy('');
    }
  }, [projectId, say]);

  const apply = React.useCallback(async (proposal: Pick<StoryboardProposal, 'baseRevision'>, operations: Array<Record<string, unknown>>) => {
    setBusy('apply');
    try {
      const next = await api.applyStoryboard(projectId, { baseRevision: proposal.baseRevision, operations });
      commit(next);
      pushHistory(next, 'history.stepAiStoryboard');
      setError('');
      return true;
    } catch (e) {
      say(e);
      return false;
    } finally {
      setBusy('');
    }
  }, [projectId, commit, pushHistory, say]);

  const handoff = React.useCallback(async () => {
    setBusy('handoff');
    try {
      const result = await api.handoffStoryboard(projectId);
      commit(result.storyboard);
      pushHistory(result.storyboard, 'history.stepHandoffStoryboard');
      setError('');
      return { clips: result.clips, gaps: result.gaps };
    } catch (e) {
      say(e);
      return null;
    } finally {
      setBusy('');
    }
  }, [projectId, commit, pushHistory, say]);

  const flush = React.useCallback(async () => {
    if (!dirty.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (current.current) await saveNow(current.current);
  }, [saveNow]);

  const historyView = React.useMemo<StoryboardHistory>(() => ({
    steps: history.current.map(({ label, at }) => ({ label, at })),
    cursor: cursor.current,
  }), [historyVersion]);

  return {
    doc, loading, saving, error, busy, load, refresh, update, flush,
    undo, redo, rollbackTo, history: historyView, canUndo, canRedo,
    generate, match, fill, chat, apply, handoff,
  };
}
