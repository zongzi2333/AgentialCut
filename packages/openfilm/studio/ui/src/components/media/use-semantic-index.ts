/**
 * The media page's view of the semantic index: status, the running job, models, and search.
 *
 * The sidecar is optional. When it is not installed the page keeps its file search and shows the
 * reason instead of failing.
 */
import * as React from 'react';
import { api, ApiError, type SemanticHit, type SemanticSearchResponse, type SemanticStatus } from '@/api';

export interface SemanticIndexState {
  status: SemanticStatus | null;
  loading: boolean;
  error: string;
  hits: SemanticHit[];
  meta: SemanticSearchResponse['meta'] | null;
  searching: boolean;
  searchError: string;
  start: (options?: { modelId?: string; mode?: 'new' | 'update' | 'rebuild'; assetIds?: string[]; folders?: string[] }) => Promise<boolean>;
  startExternal: (libraryId: string, options?: { modelId?: string; mode?: 'new' | 'update' | 'rebuild' }) => Promise<boolean>;
  cancel: () => Promise<void>;
  remove: () => Promise<void>;
  search: (query: { type: 'text'; text: string } | { type: 'image'; dataUrl: string }, mode?: 'frame' | 'chunk', libraryIds?: string[]) => Promise<void>;
  clearSearch: () => void;
  addExternal: (path: string, name?: string, indexRoot?: string) => Promise<void>;
  removeExternal: (libraryId: string) => Promise<void>;
  importModel: (file: File) => Promise<void>;
  restart: () => Promise<void>;
  removeStore: (libraryId: string, storeId: string) => Promise<void>;
  setRoot: (path: string) => Promise<void>;
  setStores: (stores: readonly string[]) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useSemanticIndex(projectId?: string | null): SemanticIndexState {
  const [status, setStatus] = React.useState<SemanticStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [hits, setHits] = React.useState<SemanticHit[]>([]);
  const [meta, setMeta] = React.useState<SemanticSearchResponse['meta'] | null>(null);
  const [searching, setSearching] = React.useState(false);
  const [searchError, setSearchError] = React.useState('');
  const alive = React.useRef(true);

  const refresh = React.useCallback(async () => {
    try {
      const next = await api.semanticStatus(projectId ?? null);
      if (!alive.current) return;
      setStatus(next);
      setError('');
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [projectId]);

  React.useEffect(() => {
    alive.current = true;
    setLoading(true);
    setStatus(null);
    setHits([]);
    setMeta(null);
    setSearchError('');
    void refresh();
    return () => { alive.current = false; };
  }, [projectId, refresh]);

  const jobState = status?.project?.job?.state;
  const externalWorking = status?.libraries?.some((library) => library.job?.state === 'queued' || library.job?.state === 'running') ?? false;
  React.useEffect(() => {
    if (!status) return;
    const working = jobState === 'queued' || jobState === 'running' || externalWorking || status.sidecar.state === 'starting';
    if (!working) return undefined;
    const timer = setInterval(() => { void refresh(); }, 1500);
    return () => clearInterval(timer);
  }, [status, jobState, externalWorking, refresh]);
  /* While the page is open, files can be added, changed or deleted in a file manager: look again now and then. */
  React.useEffect(() => {
    if (status?.sidecar.state !== 'ready') return undefined;
    const timer = setInterval(() => { void refresh(); }, 15000);
    return () => clearInterval(timer);
  }, [status?.sidecar.state, refresh]);

  const start = React.useCallback(async (options: { modelId?: string; mode?: 'new' | 'update' | 'rebuild'; assetIds?: string[]; folders?: string[] } = {}) => {
    if (!projectId) return false;
    setError('');
    try {
      const modelId = options.modelId || status?.models?.[0]?.id;
      await api.semanticStart(projectId, { ...options, ...(modelId ? { modelId } : {}) });
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [projectId, refresh, status?.models]);

  const startExternal = React.useCallback(async (libraryId: string, options: { modelId?: string; mode?: 'new' | 'update' | 'rebuild' } = {}) => {
    setError('');
    try {
      const modelId = options.modelId || status?.models?.[0]?.id;
      await api.semanticStartExternal(libraryId, { ...options, ...(modelId ? { modelId } : {}) });
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      return false;
    }
  }, [refresh, status?.models]);

  const cancel = React.useCallback(async () => {
    const job = status?.project?.job;
    if (!job || !projectId) return;
    try {
      await api.semanticCancel(projectId, job.id);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    }
  }, [projectId, refresh, status?.project?.job]);

  const remove = React.useCallback(async () => {
    if (!projectId) return;
    try {
      await api.semanticDelete(projectId);
      setHits([]);
      setMeta(null);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    }
  }, [projectId, refresh]);

  const search = React.useCallback(async (query: { type: 'text'; text: string } | { type: 'image'; dataUrl: string }, mode: 'frame' | 'chunk' = 'chunk', libraryIds?: string[]) => {
    if (!projectId) return;
    setSearching(true);
    setSearchError('');
    try {
      const result = await api.semanticSearch(projectId, { query, mode, topK: 100, ...(libraryIds?.length ? { libraryIds } : {}) });
      setHits(result.hits);
      setMeta(result.meta);
    } catch (e) {
      setHits([]);
      setMeta(null);
      setSearchError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    } finally {
      setSearching(false);
    }
  }, [projectId]);

  const clearSearch = React.useCallback(() => {
    setHits([]);
    setMeta(null);
    setSearchError('');
  }, []);

  const addExternal = React.useCallback(async (path: string, name?: string, indexRoot?: string) => {
    await api.semanticAddLibrary({ path, name, indexRoot });
    await refresh();
  }, [refresh]);

  const removeExternal = React.useCallback(async (libraryId: string) => {
    await api.semanticRemoveLibrary(libraryId);
    await refresh();
  }, [refresh]);

  const importModel = React.useCallback(async (file: File) => {
    await api.semanticImportModel(file);
    await refresh();
  }, [refresh]);

  const restart = React.useCallback(async () => {
    try {
      await api.semanticRestart();
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  const removeStore = React.useCallback(async (libraryId: string, storeId: string) => {
    try {
      await api.semanticDeleteStore(libraryId, storeId);
      setHits([]);
      setMeta(null);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
    }
  }, [refresh]);

  const setRoot = React.useCallback(async (path: string) => {
    setError('');
    try {
      setStatus(await api.semanticSetRoot(projectId ?? null, path));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, [projectId]);

  const setStores = React.useCallback(async (stores: readonly string[]) => {
    if (!projectId) return;
    setError('');
    try {
      setStatus(await api.semanticSetStores(projectId, stores));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      throw e;
    }
  }, [projectId]);

  return { status, loading, error, hits, meta, searching, searchError, start, startExternal, cancel, remove, search, clearSearch, addExternal, removeExternal, importModel, restart, removeStore, setRoot, setStores, refresh };
}
