/**
 * The contract between the media library, Studio's index service, and the local sidecar.
 *
 * A media library is a set of files. A vector store (IndexStore) is one model's index for one
 * library; it never holds two models. Different stores are queried separately; their results may
 * be fused by rank, never by mixing vectors.
 *
 * P1 implements the visual engine only. Dialogue and tags are named for the future and are not
 * shown in the page.
 */
export type MediaSearchKind = 'visual' | 'dialogue' | 'tags';
export type MediaSearchMode = 'frame' | 'chunk';
export type IndexState = 'off' | 'idle' | 'queued' | 'indexing' | 'ready' | 'stale' | 'partial' | 'error' | 'missing';

export interface EncodingModel {
  id: string;
  name: string;
  /** local-onnx or remote-http; one store is one model and one provider. */
  provider: string;
  kind: 'local-onnx' | 'remote-http';
  modelVersion: string;
  dimension: number;
  imageSize: number;
  languages: string[];
  license?: string;
  /** frames and chunks both come from this model; a store is invalid if either tower is absent. */
  capabilities: { text: boolean; image: boolean; video?: boolean };
}

export interface IndexStore {
  id: string;
  libraryId: string;
  modelId: string;
  state: IndexState;
  indexedAssets: number;
  indexedUnits: number;
  progress?: number;
  lastError?: string;
}

export interface IndexLibrary {
  id: string;
  name: string;
  kind: 'project' | 'external';
  mediaRoot: string;
  indexRoot: string;
  assets: {
    total: number;
    ready: number;
    stale: number;
    missing: number;
    notIndexed: number;
    error: number;
  };
  stores: IndexStore[];
  job?: MediaIndexJob | null;
  offline?: boolean;
  /** Per-file state (`ready`, `stale`, `missing`, `not-indexed`), when the index gives it. */
  assetStates?: Record<string, string>;
}

export interface MediaIndexStatus {
  ready: boolean;
  sidecar: { state: 'off' | 'starting' | 'ready' | 'error'; reason?: string; device?: string };
  project: IndexLibrary | null;
  libraries: IndexLibrary[];
  models: EncodingModel[];
}

export interface MediaSearchRequest {
  libraryIds: string[];
  /** Optional: only these stores; otherwise each library's default store. */
  storeIds?: string[];
  query:
    | { type: 'text'; text: string }
    | { type: 'image'; dataUrl: string }
    | { type: 'vector'; vector: number[] };
  kinds?: MediaSearchKind[];
  mode?: MediaSearchMode;
  topK?: number;
  minScore?: number;
  filters?: {
    kinds?: string[];
    folder?: string;
    minDurationMs?: number;
    maxDurationMs?: number;
  };
  /** Fuse stores with reciprocal-rank fusion; raw scores from different models are incomparable. */
  fusion?: 'none' | 'rrf';
}

export interface MediaSearchHit {
  libraryId: string;
  libraryName?: string;
  storeId: string;
  modelId: string;
  providerId?: string;
  contentKey: string;
  assetId: string;
  path: string;
  name: string;
  kind?: string;
  startMs: number;
  endMs: number;
  anchorMs: number;
  /** score within this store */
  score: number;
  /** rank after RRF when several stores were searched */
  rankScore?: number;
  engine: MediaSearchKind;
  thumbUrl?: string;
  matchedText?: string;
  degraded?: string;
}

export interface MediaSearchResponse {
  hits: MediaSearchHit[];
  meta: {
    returned: number;
    elapsedMs: number;
    mode: MediaSearchMode;
    storeIds: string[];
    modelIds: string[];
    indexState: 'ready' | 'partial';
    degraded?: string;
  };
}

export interface MediaIndexJob {
  id: string;
  libraryId: string;
  storeId: string;
  mode: 'new' | 'update' | 'rebuild';
  state: 'queued' | 'running' | 'done' | 'cancelled' | 'error';
  progress: number;
  done: number;
  total: number;
  message?: string;
  error?: string;
}

/** What Studio's server and the sidecar agree on (the sidecar adds its HTTP envelope). */
export interface SemanticIndexDriver {
  health(): Promise<{ state: string; device?: string; reason?: string }>;
  models(): Promise<EncodingModel[]>;
  registerLibrary(library: IndexLibrary): Promise<IndexLibrary>;
  reconcileLibrary(library: IndexLibrary, assets: readonly unknown[]): Promise<IndexLibrary>;
  startJob(request: {
    libraryId: string;
    storeId?: string;
    modelId: string;
    mode: MediaIndexJob['mode'];
    assets: readonly unknown[];
  }): Promise<{ job: MediaIndexJob; storeId: string }>;
  job(libraryId: string, jobId: string): Promise<MediaIndexJob>;
  cancel(libraryId: string, jobId: string): Promise<void>;
  removeIndex(libraryId: string, storeId?: string): Promise<void>;
  search(request: MediaSearchRequest): Promise<MediaSearchResponse>;
}

/** The page's state while no sidecar is installed. */
export const NO_INDEX_STATUS: MediaIndexStatus = {
  ready: false,
  sidecar: { state: 'off' },
  project: null,
  libraries: [],
  models: [],
};
