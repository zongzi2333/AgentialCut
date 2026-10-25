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

export interface StoryboardState {
  doc: StoryboardDocument | null;
  loading: boolean;
  saving: boolean;
  error: string;
  /** a generation, match, chat or handoff is running */
  busy: string;
  load: () => Promise<void>;
  update: (change: (draft: StoryboardDocument) => void) => void;
  flush: () => Promise<void>;
  undo: () => void;
  canUndo: boolean;
  generate: (body: { text?: string; prompt?: string; brief?: Partial<StoryboardDocument['brief']> }) => Promise<'success' | 'failed'>;
  match: (shotIds?: string[], topK?: number) => Promise<'success' | 'failed'>;
  fill: (shotId: string, prompt: string, duration?: number) => Promise<'success' | 'failed'>;
  chat: (text: string, selectedIds: string[]) => Promise<StoryboardChatResponse | null>;
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
  const past = React.useRef<StoryboardDocument[]>([]);
  const [canUndo, setCanUndo] = React.useState(false);

  const say = React.useCallback((value: unknown) => {
    setError(value instanceof ApiError ? value.message : value instanceof Error ? value.message : String(value ?? ''));
  }, []);

  const commit = React.useCallback((next: StoryboardDocument) => {
    current.current = next;
    dirty.current = false;
    if (!live.current) return;
    setDoc(next);
    setCanUndo(past.current.length > 0);
  }, []);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.storyboard(projectId);
      if (!live.current) return;
      past.current = [];
      commit(next);
      setError('');
    } catch (e) {
      say(e);
    } finally {
      if (live.current) setLoading(false);
    }
  }, [projectId, commit, say]);

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
    past.current = [...past.current.slice(-24), clone(prior)];
    commit(next);
    schedule(next);
  }, [commit, schedule]);

  const undo = React.useCallback(() => {
    const prior = past.current.at(-1);
    if (!prior) return;
    past.current = past.current.slice(0, -1);
    const next = clone(prior);
    /* undo restores the older content, not the older revision: save it on top of the current one */
    next.revision = current.current?.revision ?? next.revision;
    commit(next);
    schedule(next);
  }, [commit, schedule]);

  const generate = React.useCallback(async (body: { text?: string; prompt?: string; brief?: Partial<StoryboardDocument['brief']> }) => {
    setBusy('generate');
    try {
      const result = await api.generateStoryboard(projectId, body);
      past.current = [];
      commit(result.storyboard);
      setError('');
      return 'success' as const;
    } catch (e) {
      say(e);
      return 'failed' as const;
    } finally {
      setBusy('');
    }
  }, [projectId, commit, say]);

  const match = React.useCallback(async (shotIds?: string[], topK?: number) => {
    setBusy('match');
    try {
      const next = await api.matchStoryboard(projectId, { ...(shotIds?.length ? { shotIds } : {}), ...(topK ? { topK } : {}) });
      past.current = [...past.current.slice(-24), clone(current.current as StoryboardDocument)].filter(Boolean);
      commit(next);
      setError('');
      return 'success' as const;
    } catch (e) {
      say(e);
      return 'failed' as const;
    } finally {
      setBusy('');
    }
  }, [projectId, commit, say]);

  const fill = React.useCallback(async (shotId: string, prompt: string, duration?: number) => {
    setBusy('fill');
    try {
      const result = await api.fillStoryboard(projectId, { shotId, prompt, ...(duration ? { duration } : {}) });
      past.current = [...past.current.slice(-24), clone(current.current as StoryboardDocument)].filter(Boolean);
      commit(result.storyboard);
      setError('');
      return 'success' as const;
    } catch (e) {
      say(e);
      return 'failed' as const;
    } finally {
      setBusy('');
    }
  }, [projectId, commit, say]);

  const chat = React.useCallback(async (text: string, selectedIds: string[]) => {
    setBusy('chat');
    try {
      const result = await api.agentChat(projectId, { text, selectedIds, scope: 'storyboard' });
      if (!result.proposal) throw new Error('对话返回缺少分镜提案');
      setError('');
      return {
        reply: result.reply,
        operations: result.operations ?? [],
        proposal: result.proposal,
        ...(result.intent ? { intent: result.intent } : {}),
      };
    } catch (e) {
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
      past.current = [...past.current.slice(-24), clone(current.current as StoryboardDocument)].filter(Boolean);
      commit(next);
      setError('');
      return true;
    } catch (e) {
      say(e);
      return false;
    } finally {
      setBusy('');
    }
  }, [projectId, commit, say]);

  const handoff = React.useCallback(async () => {
    setBusy('handoff');
    try {
      const result = await api.handoffStoryboard(projectId);
      commit(result.storyboard);
      setError('');
      return { clips: result.clips, gaps: result.gaps };
    } catch (e) {
      say(e);
      return null;
    } finally {
      setBusy('');
    }
  }, [projectId, commit, say]);

  const flush = React.useCallback(async () => {
    if (!dirty.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (current.current) await saveNow(current.current);
  }, [saveNow]);

  return { doc, loading, saving, error, busy, load, update, flush, undo, canUndo, generate, match, fill, chat, apply, handoff };
}
