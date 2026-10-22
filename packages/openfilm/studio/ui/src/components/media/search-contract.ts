/**
 * The contract the media library is built against, before any index service exists.
 *
 * The library itself (import, browse, preview, properties) needs none of this. Search does: a local sidecar
 * (ONNX encoders, a vector store, OCR/tag indexes — the same model families VideoSeek uses) answers these shapes, and
 * Studio's server proxies it. The page renders the states below even while every engine is `off`, so wiring the
 * service later changes data, not layout.
 *
 * Nothing here performs a request yet; the types are what the UI and the future sidecar agree on.
 */

export type MediaSearchKind = 'visual' | 'dialogue' | 'tags';
export type MediaSearchMode = 'frame' | 'chunk';
export type SearchIndexState = 'off' | 'idle' | 'indexing' | 'stale' | 'error';

export interface EncodingModel {
  id: string;
  /** openai-clip | chinese-clip | siglip2 (the families VideoSeek ships), base or large */
  family: string;
  variant: string;
  /** the vector's width; a collection is keyed by model and width */
  dimension: number;
  metric: 'cosine';
  /** what the vectors mean together, versioned: a change invalidates the collection */
  embeddingSpace: string;
  bytes?: number;
  license?: string;
}

export interface IndexEngineStatus {
  engine: MediaSearchKind;
  /** absent while the engine is off (no model chosen, or the sidecar is not installed) */
  model?: EncodingModel;
  state: SearchIndexState;
  indexedAssets: number;
  /** frames for visual, cues for dialogue, chunks for tags */
  indexedUnits: number;
  progress?: number;
  lastError?: string;
}

export interface MediaIndexStatus {
  ready: boolean;
  engines: Record<MediaSearchKind, IndexEngineStatus>;
  device: 'gpu' | 'cpu' | 'auto';
  queue: { pending: number; running?: { jobId: string; assetId?: string; progress: number } };
  /** libraries the sidecar knows: the project's, and any external folder added to it */
  libraries: MediaLibraryRef[];
}

export interface MediaLibraryRef {
  id: string;
  name: string;
  path: string;
  kind: 'project' | 'external';
  assetCount?: number;
  indexState?: SearchIndexState;
}

export interface MediaSearchRequest {
  libraryId?: string;
  query:
    | { type: 'text'; text: string }
    | { type: 'image'; dataUrl: string }
    | { type: 'vector'; vector: number[] };
  kinds?: MediaSearchKind[];
  mode?: MediaSearchMode;
  scope?: { assetIds?: string[]; folders?: string[] };
  filters?: {
    kinds?: string[];
    minDurationMs?: number;
    maxDurationMs?: number;
    /** only assets the given engine has indexed, or only those it has not */
    indexed?: 'any' | MediaSearchKind | 'none';
  };
  topK?: number;
  minScore?: number;
  /** several queries fused with RRF (video search's "enhance") */
  enhance?: boolean;
  /** image queries only */
  precision?: 'fast' | 'precise';
}

export interface MediaSearchHit {
  assetId: string;
  libraryId?: string;
  path: string;
  startMs: number;
  endMs: number;
  score: number;
  kind: MediaSearchKind;
  matchedText?: string;
  anchorMs?: number;
  thumbUrl?: string;
}

export interface MediaSearchResponse {
  hits: MediaSearchHit[];
  meta: {
    returned: number;
    elapsedMs: number;
    mode: MediaSearchMode;
    model?: string;
    indexState: 'ready' | 'indexing' | 'stale';
    /** set when the answer is partial: indexing in progress, an engine failed, a timeout was shortened */
    degraded?: string;
  };
}

export interface MediaIndexJob {
  id: string;
  libraryId: string;
  assetIds: string[];
  engines: MediaSearchKind[];
  state: 'queued' | 'running' | 'done' | 'cancelled' | 'error';
  progress: number;
}

/** What the page shows while no sidecar is connected: every engine off, nothing indexed. */
export const NO_INDEX_STATUS: MediaIndexStatus = {
  ready: false,
  engines: {
    visual: { engine: 'visual', state: 'off', indexedAssets: 0, indexedUnits: 0 },
    dialogue: { engine: 'dialogue', state: 'off', indexedAssets: 0, indexedUnits: 0 },
    tags: { engine: 'tags', state: 'off', indexedAssets: 0, indexedUnits: 0 },
  },
  device: 'auto',
  queue: { pending: 0 },
  libraries: [],
};
