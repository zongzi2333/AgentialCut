#!/usr/bin/env python
"""
OpenFilm's local semantic index sidecar.

It is deliberately thin: the frame extraction, Chinese-CLIP encoder, and semantic chunking are
VideoSeek's own code. This process only adds the OpenFilm catalog (SQLite), per-library vector
stores (LanceDB), the job runner, and the local HTTP contract Studio speaks.

It never writes media. It reads registered media roots and writes only the registered index roots.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

import numpy as np

# ---------------------------------------------------------------------------------------------
# VideoSeek is imported after its config is pointed at a small sidecar-owned file. This keeps
# VideoSeek from reading or writing the desktop app's profile.
# ---------------------------------------------------------------------------------------------


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--token", default="")
    parser.add_argument("--videos-eek-root", required=True)
    parser.add_argument("--models-root", required=True)
    parser.add_argument("--config-dir", required=True)
    parser.add_argument("--prefer-gpu", action="store_true")
    return parser.parse_args()


ARGS = _parse_args()
TOKEN = ARGS.token or uuid.uuid4().hex
VIDEOSEEK_ROOT = os.path.abspath(ARGS.videos_eek_root)
MODELS_ROOT = os.path.abspath(ARGS.models_root)
CONFIG_DIR = os.path.abspath(ARGS.config_dir)
os.makedirs(CONFIG_DIR, exist_ok=True)
if VIDEOSEEK_ROOT not in sys.path:
    sys.path.insert(0, VIDEOSEEK_ROOT)

vs_config = os.path.join(CONFIG_DIR, "videoseek-config.json")
if not os.path.exists(vs_config):
    with open(vs_config, "w", encoding="utf-8") as fh:
        json.dump(
            {
                "prefer_gpu": bool(ARGS.prefer_gpu),
                "embedding_batch_size": 8,
                "data_root": os.path.join(CONFIG_DIR, "videoseek-data"),
            },
            fh,
        )
os.environ["VIDEOSEEK_CONFIG_PATH"] = vs_config
os.environ.setdefault("VIDEOSEEK_NO_UPDATE_CHECK", "1")

# The VideoSeek extractor locks its preprocess to the desktop profile. OpenFilm stores its own
# space metadata and always uses center-crop for new stores, so the extractor's lookup is pinned.
try:
    import src.services.embedding_preprocess as _embedding_preprocess

    _embedding_preprocess.resolve_embedding_preprocess = lambda config=None: "center_crop"
except Exception:
    pass

import cv2  # noqa: E402
import lancedb  # noqa: E402
from fastapi import FastAPI, HTTPException, Request  # noqa: E402
from fastapi.responses import JSONResponse, Response  # noqa: E402
import uvicorn  # noqa: E402

try:
    from src.core.chinese_clip_provider import ChineseCLIPOnnxEngine  # type: ignore
except Exception as exc:  # pragma: no cover - startup explains the missing dependency
    ChineseCLIPOnnxEngine = None
    CHINESE_CLIP_IMPORT_ERROR = str(exc)
else:
    CHINESE_CLIP_IMPORT_ERROR = ""

try:
    from src.core.extract_frames import stream_frames_with_ffmpeg  # type: ignore
except Exception as exc:  # pragma: no cover
    stream_frames_with_ffmpeg = None
    EXTRACT_IMPORT_ERROR = str(exc)
else:
    EXTRACT_IMPORT_ERROR = ""

try:
    from src.core.semantic_chunking import SemanticChunkStreamBuilder  # type: ignore
except Exception as exc:  # pragma: no cover
    SemanticChunkStreamBuilder = None
    CHUNK_IMPORT_ERROR = str(exc)
else:
    CHUNK_IMPORT_ERROR = ""

try:
    from src.media.probe import get_video_duration_seconds  # type: ignore
except Exception:  # pragma: no cover
    get_video_duration_seconds = None

try:
    from src.core.image_io import load_image_bgr  # type: ignore
except Exception:  # pragma: no cover
    load_image_bgr = None

APP_VERSION = "1"
MAX_QUERY_BYTES = 12 << 20
JPEG = "image/jpeg"
VIDEO_EXT = {".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"}


def now_ms() -> int:
    return int(time.time() * 1000)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def safe_join(root: str, rel: str) -> Path:
    root_path = Path(root).resolve()
    target = (root_path / rel.replace("\\", "/")).resolve()
    try:
        target.relative_to(root_path)
    except ValueError as exc:
        raise HTTPException(400, f"{rel} is not inside the library") from exc
    return target


def content_key(path: Path) -> str:
    size = path.stat().st_size
    digest = hashlib.sha256()
    digest.update(str(size).encode("ascii"))
    with open(path, "rb") as fh:
        digest.update(fh.read(10 * 1024 * 1024))
        if size > 11 * 1024 * 1024:
            fh.seek(max(0, size - 1024 * 1024))
            digest.update(fh.read(1024 * 1024))
    return digest.hexdigest()


def kind_of(name: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    if ext in VIDEO_EXT:
        return "video"
    if ext in IMAGE_EXT:
        return "image"
    if ext in {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac"}:
        return "audio"
    if ext in {".html", ".htm"}:
        return "mg"
    return "other"


def duration_ms(path: Path) -> int:
    if get_video_duration_seconds is None:
        return 0
    try:
        value = get_video_duration_seconds(str(path))
        return int(round(float(value) * 1000)) if value else 0
    except Exception:
        return 0


def decode_image(data_url: str) -> np.ndarray:
    text = str(data_url or "")
    if "," in text and text.startswith("data:"):
        text = text.split(",", 1)[1]
    raw = base64.b64decode(text)
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(400, "the query image cannot be read")
    return image


# ---------------------------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------------------------


class RemoteEmbeddingEngine:
    """An OpenAI-compatible embedding endpoint. It is used only when the card declares image input:
    text-only models would put queries and video frames in different spaces."""

    def __init__(self, model: dict[str, Any]):
        self.model = model
        self.dimension = int(model.get("dimension") or 0)
        self.base = str(model.get("baseUrl") or "").rstrip("/")
        self.key = str(model.get("apiKey") or "")
        self.remote = str(model.get("remoteModel") or model.get("variant") or model.get("id"))
        self.image_mode = str(model.get("imageMode") or "messages")
        self.image_field = str(model.get("imageField") or "image_url")
        self.image_prompt = str(model.get("imagePrompt") or "Represent the given image.")
        self.text_as_messages = bool(model.get("textAsMessages", True))

    def _post(self, payload: dict[str, Any]) -> list[float]:
        if not self.base:
            raise RuntimeError("remote embedding has no base URL")
        url = self.base if self.base.endswith("/embeddings") else f"{self.base}/embeddings"
        headers = {"content-type": "application/json"}
        if self.key:
            headers["authorization"] = f"Bearer {self.key}"
        request = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")[:500]
            raise RuntimeError(f"remote embedding answered {error.code}: {detail}") from error
        except Exception as error:
            raise RuntimeError(f"remote embedding failed: {error}") from error
        vector = None
        if isinstance(body, dict):
            data = body.get("data")
            if isinstance(data, list) and data:
                vector = data[0].get("embedding") if isinstance(data[0], dict) else None
            vector = vector or body.get("embedding")
        if not isinstance(vector, list) or not vector:
            raise RuntimeError("remote embedding returned no vector")
        result = np.asarray(vector, dtype=np.float32)
        if self.dimension and result.shape[0] != self.dimension:
            raise RuntimeError(f"remote embedding returned {result.shape[0]} dimensions, expected {self.dimension}")
        norm = float(np.linalg.norm(result))
        return (result / norm if norm else result).tolist()

    def encode_text(self, text: str) -> np.ndarray:
        if self.text_as_messages:
            vector = self._post({
                "model": self.remote,
                "messages": [{"role": "user", "content": [{"type": "text", "text": str(text or "")}]}],
                "encoding_format": "float",
            })
        else:
            vector = self._post({"model": self.remote, "input": [str(text or "")], "encoding_format": "float"})
        return np.asarray([vector], dtype=np.float32)

    def encode_images(self, images: list[np.ndarray]) -> np.ndarray:
        vectors = []
        for image in images:
            ok, encoded = cv2.imencode(".jpg", image, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
            if not ok:
                raise RuntimeError("could not encode a frame for the remote embedding")
            data_url = "data:image/jpeg;base64," + base64.b64encode(encoded.tobytes()).decode("ascii")
            if self.image_mode == "object":
                payload = {"model": self.remote, "input": [{self.image_field: data_url}], "encoding_format": "float"}
            else:
                payload = {
                    "model": self.remote,
                    "messages": [{"role": "user", "content": [
                        {"type": "text", "text": self.image_prompt},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ]}],
                    "encoding_format": "float",
                }
            vectors.append(self._post(payload))
        return np.asarray(vectors, dtype=np.float32)


class ModelRegistry:
    def __init__(self, root: str):
        self.root = root
        self.lock = threading.RLock()
        self.models: dict[str, dict[str, Any]] = {}
        self.engines: dict[str, Any] = {}
        self.scan()

    def scan(self) -> None:
        found: dict[str, dict[str, Any]] = {}
        if os.path.isdir(self.root):
            for current, _dirs, files in os.walk(self.root):
                if "model_manifest.json" not in files:
                    continue
                manifest_path = os.path.join(current, "model_manifest.json")
                try:
                    with open(manifest_path, "r", encoding="utf-8-sig") as fh:
                        manifest = json.load(fh)
                except Exception:
                    continue
                model_id = str(manifest.get("id") or "").strip()
                if not model_id:
                    continue
                required = manifest.get("required_files") or []
                if any(not os.path.isfile(os.path.join(current, name)) for name in required):
                    continue
                entry = {
                    "id": model_id,
                    "name": str(manifest.get("display_name") or model_id),
                    "provider": str(manifest.get("provider") or ""),
                    "variant": str(manifest.get("variant") or ""),
                    "dimension": int(manifest.get("embedding_dimension") or manifest.get("dimension") or 0),
                    "imageSize": int(manifest.get("image_size") or 224),
                    "languages": ["zh", "en"] if "chinese" in model_id.lower() else ["en"],
                    "path": current,
                    "license": str(manifest.get("license") or ""),
                    "manifest": manifest,
                }
                found[model_id] = entry
        remote_file = os.path.join(CONFIG_DIR, "remote-models.json")
        if os.path.isfile(remote_file):
            try:
                with open(remote_file, "r", encoding="utf-8") as fh:
                    remote = json.load(fh).get("models") or []
                for item in remote if isinstance(remote, list) else []:
                    if not isinstance(item, dict):
                        continue
                    model_id = str(item.get("id") or "").strip()
                    if not model_id:
                        continue
                    found[model_id] = {
                        "id": model_id,
                        "name": str(item.get("name") or model_id),
                        "provider": "remote_embedding",
                        "variant": str(item.get("variant") or ""),
                        "dimension": int(item.get("dimension") or 0),
                        "imageSize": int(item.get("imageSize") or 224),
                        "languages": item.get("languages") if isinstance(item.get("languages"), list) else ["zh", "en"],
                        "path": "",
                        "license": "",
                        "remote": True,
                        "vision": True,
                        "cardId": str(item.get("cardId") or ""),
                        "remoteModel": str(item.get("remoteModel") or ""),
                        "baseUrl": str(item.get("baseUrl") or ""),
                        "apiKey": str(item.get("apiKey") or ""),
                        "imageMode": str(item.get("imageMode") or "messages"),
                        "imageField": str(item.get("imageField") or "image_url"),
                        "imagePrompt": str(item.get("imagePrompt") or "Represent the given image."),
                        "textAsMessages": bool(item.get("textAsMessages", True)),
                    }
            except Exception:
                pass
        with self.lock:
            self.models = found
            self.engines = {k: v for k, v in self.engines.items() if k in found}

    def list(self) -> list[dict[str, Any]]:
        with self.lock:
            return [
                {**{k: v for k, v in model.items() if k not in {"manifest", "apiKey", "baseUrl"}}, "path": model.get("path", "")}
                for model in self.models.values()
            ]

    def get(self, model_id: str) -> dict[str, Any]:
        with self.lock:
            model = self.models.get(model_id)
        if not model:
            raise HTTPException(409, f"model {model_id} is not installed")
        return model

    def engine(self, model_id: str) -> Any:
        model = self.get(model_id)
        with self.lock:
            engine = self.engines.get(model_id)
            if engine is not None:
                return engine
            provider = model["provider"]
            if provider == "chinese_clip_onnx":
                if ChineseCLIPOnnxEngine is None:
                    raise HTTPException(503, f"Chinese CLIP support is unavailable: {CHINESE_CLIP_IMPORT_ERROR}")
                engine = ChineseCLIPOnnxEngine(
                    model["path"],
                    prefer_gpu=bool(ARGS.prefer_gpu),
                    image_size=int(model["imageSize"] or 224),
                )
            elif provider == "remote_embedding":
                if not model.get("vision"):
                    raise HTTPException(409, "a text-only embedding model cannot index video frames")
                engine = RemoteEmbeddingEngine(model)
            else:
                raise HTTPException(409, f"provider {provider} is not available in this sidecar")
            self.engines[model_id] = engine
            return engine


MODELS = ModelRegistry(MODELS_ROOT)


def _sha1_short(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:10]


def store_id_for(model: dict[str, Any], options: dict[str, Any]) -> str:
    raw = json.dumps(
        {
            "provider": model["provider"],
            "model": model["id"],
            "dimension": model["dimension"],
            "preprocess": "center_crop",
            "sampling": options.get("samplingFps") or "dynamic",
            "chunk": {
                "similarity": options.get("similarityThreshold", 0.87),
                "edge": options.get("chunkEdgeThreshold", 0.85),
                "minSize": options.get("minChunkSize", 2),
                "maxDuration": options.get("maxChunkDuration", 90.0),
            },
        },
        sort_keys=True,
    )
    return f"{model['id']}-{_sha1_short(raw)}"


def quality_options(raw: dict[str, Any] | None) -> dict[str, Any]:
    raw = raw or {}
    return {
        "samplingFps": raw.get("samplingFps") or None,
        "similarityThreshold": float(raw.get("similarityThreshold", 0.87)),
        "chunkEdgeThreshold": float(raw.get("chunkEdgeThreshold", 0.85)),
        "minChunkSize": int(raw.get("minChunkSize", 2)),
        "maxChunkDuration": float(raw.get("maxChunkDuration", 90.0)),
    }


# ---------------------------------------------------------------------------------------------
# Libraries and catalog
# ---------------------------------------------------------------------------------------------


class Library:
    def __init__(self, library_id: str, name: str, kind: str, media_root: str, index_root: str):
        self.id = library_id
        self.name = name
        self.kind = kind
        self.media_root = os.path.abspath(media_root)
        self.index_root = os.path.abspath(index_root)
        os.makedirs(os.path.join(self.index_root, "stores"), exist_ok=True)
        os.makedirs(os.path.join(self.index_root, "tmp"), exist_ok=True)
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(os.path.join(self.index_root, "catalog.sqlite"), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._init()

    def _init(self) -> None:
        with self.lock, self.conn:
            self.conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS assets (
                  rel_path TEXT PRIMARY KEY,
                  content_key TEXT,
                  name TEXT,
                  kind TEXT,
                  size INTEGER DEFAULT 0,
                  mtime_ms INTEGER DEFAULT 0,
                  duration_ms INTEGER DEFAULT 0,
                  state TEXT DEFAULT 'not-indexed',
                  error TEXT,
                  excluded INTEGER DEFAULT 0,
                  updated_at INTEGER DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS stores (
                  store_id TEXT PRIMARY KEY,
                  model_id TEXT,
                  model_json TEXT,
                  options_json TEXT,
                  created_at INTEGER,
                  state TEXT DEFAULT 'idle'
                );
                CREATE TABLE IF NOT EXISTS jobs (
                  id TEXT PRIMARY KEY,
                  store_id TEXT,
                  mode TEXT,
                  state TEXT,
                  progress REAL DEFAULT 0,
                  message TEXT,
                  error TEXT,
                  total INTEGER DEFAULT 0,
                  done INTEGER DEFAULT 0,
                  created_at INTEGER,
                  finished_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS job_items (
                  job_id TEXT,
                  rel_path TEXT,
                  state TEXT,
                  error TEXT
                );
                CREATE TABLE IF NOT EXISTS settings (
                  key TEXT PRIMARY KEY,
                  value TEXT
                );
                """
            )
            # Removing from the media library is a real removal now (link or copy); older catalogs may still carry
            # rows hidden by the previous view-only removal. They are visible and searchable again.
            self.conn.execute("UPDATE assets SET excluded = 0 WHERE excluded != 0")

    def asset(self, rel_path: str) -> sqlite3.Row | None:
        with self.lock:
            return self.conn.execute("SELECT * FROM assets WHERE rel_path = ?", (rel_path,)).fetchone()

    def assets(self) -> list[sqlite3.Row]:
        with self.lock:
            return list(self.conn.execute("SELECT * FROM assets").fetchall())

    def upsert_asset(self, rel_path: str, **fields: Any) -> None:
        current = self.asset(rel_path)
        data = dict(current) if current else {"rel_path": rel_path, "name": os.path.basename(rel_path), "kind": kind_of(rel_path)}
        data.update(fields)
        data["updated_at"] = now_ms()
        columns = list(data.keys())
        placeholders = ",".join("?" for _ in columns)
        updates = ",".join(f"{c}=excluded.{c}" for c in columns if c != "rel_path")
        with self.lock, self.conn:
            self.conn.execute(
                f"INSERT INTO assets ({','.join(columns)}) VALUES ({placeholders}) "
                f"ON CONFLICT(rel_path) DO UPDATE SET {updates}",
                [data[c] for c in columns],
            )

    def reconcile(self, assets: list[dict[str, Any]], scope: list[str] | None = None) -> None:
        """Mark new, changed and missing visual media without encoding anything.

        `scope` limits which existing rows can be marked missing: the global catalog holds absolute paths from
        several projects, and a project's scan must not make another project's rows look gone.
        """
        seen: set[str] = set()
        roots = [os.path.normcase(os.path.abspath(item)) for item in (scope or []) if item]
        def in_scope(value: str) -> bool:
            if not roots:
                return True
            path = os.path.normcase(os.path.abspath(value))
            return any(path == root or path.startswith(root.rstrip(os.sep) + os.sep) for root in roots)
        with self.lock, self.conn:
            for item in assets:
                rel_path = str(item.get("path") or "").strip()
                if not rel_path:
                    continue
                seen.add(rel_path)
                kind = str(item.get("kind") or kind_of(rel_path))
                if kind not in {"video", "image"}:
                    continue
                row = self.conn.execute("SELECT * FROM assets WHERE rel_path = ?", (rel_path,)).fetchone()
                size = int(item.get("size") or 0)
                mtime = int(item.get("mtimeMs") or 0)
                if row is None:
                    self.conn.execute(
                        "INSERT INTO assets (rel_path, name, kind, size, mtime_ms, duration_ms, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'not-indexed', ?)",
                        (rel_path, str(item.get("name") or os.path.basename(rel_path)), kind, size, mtime, int(item.get("durationMs") or 0), now_ms()),
                    )
                    continue
                state = str(row["state"] or "not-indexed")
                changed = size != int(row["size"] or 0) or (mtime and abs(mtime - int(row["mtime_ms"] or 0)) > 1000)
                if state == "missing" and not changed:
                    state = "not-indexed"
                if changed and state in {"ready", "error", "partial", "stale"}:
                    state = "stale"
                self.conn.execute(
                    "UPDATE assets SET name = ?, kind = ?, size = ?, mtime_ms = ?, state = ? WHERE rel_path = ?",
                    (str(item.get("name") or os.path.basename(rel_path)), kind, size, mtime, state, rel_path),
                )
            existing = self.conn.execute("SELECT rel_path, kind FROM assets").fetchall()
            for row in existing:
                if row["rel_path"] in seen:
                    continue
                if row["kind"] in {"video", "image"} and in_scope(row["rel_path"]):
                    self.conn.execute("UPDATE assets SET state = 'missing' WHERE rel_path = ?", (row["rel_path"],))

    def stores(self) -> list[sqlite3.Row]:
        with self.lock:
            return list(self.conn.execute("SELECT * FROM stores ORDER BY created_at DESC").fetchall())

    def store(self, store_id: str) -> sqlite3.Row | None:
        with self.lock:
            return self.conn.execute("SELECT * FROM stores WHERE store_id = ?", (store_id,)).fetchone()

    def ensure_store(self, store_id: str, model: dict[str, Any], options: dict[str, Any]) -> sqlite3.Row:
        existing = self.store(store_id)
        if existing is not None:
            return existing
        store_dir = os.path.join(self.index_root, "stores", store_id)
        os.makedirs(store_dir, exist_ok=True)
        meta = {
            "id": store_id,
            "modelId": model["id"],
            "provider": model["provider"],
            "dimension": model["dimension"],
            "imageSize": model["imageSize"],
            "preprocess": "center_crop",
            "options": options,
            "createdAt": now_ms(),
        }
        with open(os.path.join(store_dir, "meta.json"), "w", encoding="utf-8") as fh:
            json.dump(meta, fh, ensure_ascii=False, indent=2)
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO stores (store_id, model_id, model_json, options_json, created_at, state) VALUES (?, ?, ?, ?, ?, ?)",
                (store_id, model["id"], json.dumps(model, ensure_ascii=False), json.dumps(options), now_ms(), "idle"),
            )
        return self.store(store_id)

    def set_store_state(self, store_id: str, state: str) -> None:
        with self.lock, self.conn:
            self.conn.execute("UPDATE stores SET state = ? WHERE store_id = ?", (state, store_id))

    def set_default_store(self, store_id: str) -> None:
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO settings (key, value) VALUES ('default_store', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (store_id,),
            )

    def default_store(self) -> str:
        with self.lock:
            row = self.conn.execute("SELECT value FROM settings WHERE key = 'default_store'").fetchone()
            return str(row["value"] if row else "")

    def job(self, job_id: str) -> sqlite3.Row | None:
        with self.lock:
            return self.conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()

    def latest_job(self) -> sqlite3.Row | None:
        with self.lock:
            return self.conn.execute("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 1").fetchone()

    def create_job(self, job_id: str, store_id: str, mode: str, total: int) -> None:
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO jobs (id, store_id, mode, state, progress, total, done, created_at) VALUES (?, ?, ?, 'queued', 0, ?, 0, ?)",
                (job_id, store_id, mode, total, now_ms()),
            )

    def update_job(self, job_id: str, **fields: Any) -> None:
        if not fields:
            return
        columns = list(fields.keys())
        with self.lock, self.conn:
            self.conn.execute(
                f"UPDATE jobs SET {','.join(f'{c}=?' for c in columns)} WHERE id = ?",
                [fields[c] for c in columns] + [job_id],
            )

    def add_job_item(self, job_id: str, rel_path: str) -> None:
        with self.lock, self.conn:
            self.conn.execute("INSERT INTO job_items (job_id, rel_path, state) VALUES (?, ?, 'queued')", (job_id, rel_path))

    def update_job_item(self, job_id: str, rel_path: str, state: str, error: str | None = None) -> None:
        with self.lock, self.conn:
            self.conn.execute(
                "UPDATE job_items SET state = ?, error = ? WHERE job_id = ? AND rel_path = ?",
                (state, error, job_id, rel_path),
            )

    def status(self) -> dict[str, Any]:
        with self.lock:
            rows = list(self.conn.execute("SELECT state, COUNT(*) AS n FROM assets GROUP BY state").fetchall())
            counts = {row["state"]: row["n"] for row in rows}
            stores = []
            for store in self.stores():
                store_id = store["store_id"]
                store_dir = os.path.join(self.index_root, "stores", store_id)
                frames = chunks = 0
                try:
                    db = lancedb.connect(store_dir)
                    frames = db.open_table("frames").count_rows()
                    chunks = db.open_table("chunks").count_rows()
                except Exception:
                    pass
                model = json.loads(store["model_json"] or "{}")
                stores.append(
                    {
                        "id": store_id,
                        "modelId": model.get("id"),
                        "name": model.get("name"),
                        "provider": model.get("provider"),
                        "dimension": model.get("dimension"),
                        "state": store["state"],
                        "frames": frames,
                        "chunks": chunks,
                        "options": json.loads(store["options_json"] or "{}"),
                    }
                )
            job = self.latest_job()
        return {
            "id": self.id,
            "name": self.name,
            "kind": self.kind,
            "mediaRoot": self.media_root,
            "indexRoot": self.index_root,
            "assets": {
                "total": sum(counts.values()),
                "ready": counts.get("ready", 0),
                "stale": counts.get("stale", 0),
                "missing": counts.get("missing", 0),
                "error": counts.get("error", 0),
                "notIndexed": counts.get("not-indexed", 0) + counts.get("idle", 0),
                "unsupported": counts.get("unsupported", 0),
                "excluded": self._excluded_count(),
            },
            "stores": stores,
            "assetStates": {row["rel_path"]: row["state"] for row in self.conn.execute("SELECT rel_path, state FROM assets")},
            "job": dict(job) if job else None,
        }

    def _excluded_count(self) -> int:
        with self.lock:
            row = self.conn.execute("SELECT COUNT(*) AS n FROM assets WHERE excluded = 1").fetchone()
            return int(row["n"] if row else 0)

    def excluded_paths(self) -> set[str]:
        with self.lock:
            return {row["rel_path"] for row in self.conn.execute("SELECT rel_path FROM assets WHERE excluded = 1")}

    def close(self) -> None:
        with self.lock:
            self.conn.close()


LIBRARIES: dict[str, Library] = {}
LIBRARIES_LOCK = threading.RLock()


def get_library(library_id: str) -> Library:
    with LIBRARIES_LOCK:
        library = LIBRARIES.get(library_id)
    if not library:
        raise HTTPException(404, f"library {library_id} is not registered")
    if not os.path.isdir(library.media_root):
        raise HTTPException(410, f"library {library_id} is offline")
    return library


# ---------------------------------------------------------------------------------------------
# Vector tables
# ---------------------------------------------------------------------------------------------


def store_dir(library: Library, store_id: str) -> str:
    return os.path.join(library.index_root, "stores", store_id)


def open_table(library: Library, store_id: str, name: str):
    try:
        return lancedb.connect(store_dir(library, store_id)).open_table(name)
    except Exception:
        return None


def delete_asset_rows(library: Library, store_id: str, rel_path: str) -> None:
    escaped = rel_path.replace("'", "''")
    for name in ("frames", "chunks"):
        table = open_table(library, store_id, name)
        if table is not None:
            try:
                table.delete(f"rel_path = '{escaped}'")
            except Exception:
                pass


def append_rows(library: Library, store_id: str, name: str, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    db = lancedb.connect(store_dir(library, store_id))
    table = None
    try:
        table = db.open_table(name)
    except Exception:
        table = db.create_table(name, data=rows)
        return
    table.add(rows)


def store_has_asset(library: Library, store_id: str, rel_path: str) -> bool:
    table = open_table(library, store_id, "frames")
    if table is None:
        return False
    escaped = rel_path.replace("'", "''")
    try:
        rows = table.search().where(f"rel_path = '{escaped}'").limit(1).to_list()
        return bool(rows)
    except Exception:
        return False


# ---------------------------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------------------------


JOB_LOCK = threading.Lock()
JOB_CANCEL: dict[str, threading.Event] = {}
ACTIVE_JOB: str | None = None


def run_job(library: Library, job_id: str, store_id: str, model: dict[str, Any], options: dict[str, Any], rel_paths: list[str], mode: str) -> None:
    global ACTIVE_JOB
    cancel = JOB_CANCEL[job_id]
    library.set_store_state(store_id, "indexing")
    library.update_job(job_id, state="running", message="")
    done = 0
    errors = 0
    try:
        engine = MODELS.engine(model["id"])
        for rel_path in rel_paths:
            if cancel.is_set():
                break
            asset = library.asset(rel_path)
            if asset is None:
                continue
            library.update_job_item(job_id, rel_path, "indexing")
            try:
                index_asset(library, store_id, engine, model, options, asset, cancel)
                library.update_job_item(job_id, rel_path, "done")
            except InterruptedError:
                library.update_job_item(job_id, rel_path, "cancelled")
                break
            except Exception as exc:
                errors += 1
                message = str(exc)
                library.upsert_asset(rel_path, state="error", error=message[:2000])
                library.update_job_item(job_id, rel_path, "error", message[:2000])
            done += 1
            progress = (done / max(1, len(rel_paths))) * 100
            library.update_job(job_id, done=done, progress=progress, message=os.path.basename(rel_path))
        if cancel.is_set():
            library.update_job(job_id, state="cancelled", progress=100, finished_at=now_ms())
        elif errors == len(rel_paths) and rel_paths:
            library.update_job(job_id, state="error", progress=100, finished_at=now_ms(), error=f"{errors} assets failed")
        else:
            library.update_job(job_id, state="done", progress=100, finished_at=now_ms())
        succeeded = done - errors
        library.set_store_state(store_id, "partial" if succeeded and errors else "ready" if succeeded else "error")
        if succeeded:
            library.set_default_store(store_id)
    except Exception as exc:
        library.set_store_state(store_id, "error")
        library.update_job(
            job_id,
            state="error",
            progress=100,
            error=f"{exc}\n{traceback.format_exc()[-4000:]}",
            finished_at=now_ms(),
        )
    finally:
        with JOB_LOCK:
            JOB_CANCEL.pop(job_id, None)
            if ACTIVE_JOB == job_id:
                ACTIVE_JOB = None


def index_asset(
    library: Library,
    store_id: str,
    engine: Any,
    model: dict[str, Any],
    options: dict[str, Any],
    asset: sqlite3.Row,
    cancel: threading.Event,
) -> None:
    rel_path = asset["rel_path"]
    path = Path(rel_path) if os.path.isabs(rel_path) else safe_join(library.media_root, rel_path)
    if not path.is_file():
        raise FileNotFoundError(f"{rel_path} is missing")
    kind = asset["kind"] or kind_of(rel_path)
    key = content_key(path)
    duration = duration_ms(path)
    library.upsert_asset(rel_path, content_key=key, size=path.stat().st_size, mtime_ms=int(round(path.stat().st_mtime * 1000)), duration_ms=duration, error=None)
    if kind not in {"video", "image"}:
        library.upsert_asset(rel_path, state="unsupported", error=f"{kind} is not indexed by the visual engine")
        return
    if kind == "video":
        if stream_frames_with_ffmpeg is None or SemanticChunkStreamBuilder is None:
            raise RuntimeError(EXTRACT_IMPORT_ERROR or CHUNK_IMPORT_ERROR or "VideoSeek frame extraction is unavailable")
        fps = options.get("samplingFps")
        if not fps:
            fps = 2.0 if (duration <= 600_000 or duration <= 0) else 1.0
        builder = SemanticChunkStreamBuilder(
            similarity_threshold=options["similarityThreshold"],
            chunk_edge_threshold=options["chunkEdgeThreshold"],
            min_chunk_size=options["minChunkSize"],
            min_chunk_duration=0.0,
            max_chunk_duration=options["maxChunkDuration"],
        )
        frame_rows: list[dict[str, Any]] = []
        batch: list[np.ndarray] = []
        batch_times: list[float] = []

        def flush_batch() -> None:
            if not batch:
                return
            vectors = engine.encode_images(batch)
            builder.extend(vectors, np.asarray(batch_times, dtype=np.float32))
            for index, timestamp in enumerate(batch_times):
                frame_rows.append(
                    {
                        "rel_path": rel_path,
                        "name": asset["name"],
                        "content_key": key,
                        "start_ms": int(round(timestamp * 1000)),
                        "frame_index": len(frame_rows),
                        "vector": vectors[index].astype(np.float32).tolist(),
                    }
                )
            batch.clear()
            batch_times.clear()

        for frame, timestamp in stream_frames_with_ffmpeg(
            str(path), fps_override=float(fps), should_stop=lambda: cancel.is_set()
        ):
            if cancel.is_set():
                raise InterruptedError("cancelled")
            batch.append(frame)
            batch_times.append(float(timestamp))
            if len(batch) >= 8:
                flush_batch()
        flush_batch()
        if not frame_rows:
            raise RuntimeError(f"{rel_path} has no readable frames")
        chunks = builder.finish()
        chunk_rows = [
            {
                "rel_path": rel_path,
                "name": asset["name"],
                "content_key": key,
                "start_ms": int(round(chunk["start"] * 1000)),
                "end_ms": int(round(chunk["end"] * 1000)),
                "frame_count": int(chunk.get("frame_count") or 0),
                "vector": np.asarray(chunk["embedding"], dtype=np.float32).tolist(),
            }
            for chunk in chunks
        ]
    else:
        image = load_image_bgr(str(path)) if load_image_bgr is not None else cv2.imread(str(path), cv2.IMREAD_COLOR)
        if image is None:
            raise RuntimeError(f"{rel_path} cannot be read as an image")
        vector = engine.encode_images([image])[0].astype(np.float32)
        frame_rows = [
            {
                "rel_path": rel_path,
                "name": asset["name"],
                "content_key": key,
                "start_ms": 0,
                "frame_index": 0,
                "vector": vector.tolist(),
            }
        ]
        chunk_rows = [
            {
                "rel_path": rel_path,
                "name": asset["name"],
                "content_key": key,
                "start_ms": 0,
                "end_ms": 0,
                "frame_count": 1,
                "vector": vector.tolist(),
            }
        ]

    if cancel.is_set():
        raise InterruptedError("cancelled")
    delete_asset_rows(library, store_id, rel_path)
    append_rows(library, store_id, "frames", frame_rows)
    append_rows(library, store_id, "chunks", chunk_rows)
    library.upsert_asset(rel_path, state="ready", error=None, content_key=key, duration_ms=duration)


def start_job(library: Library, store_id: str, model: dict[str, Any], options: dict[str, Any], rel_paths: list[str], mode: str) -> str:
    global ACTIVE_JOB
    with JOB_LOCK:
        if ACTIVE_JOB:
            raise HTTPException(409, "another index job is running")
        job_id = uuid.uuid4().hex
        JOB_CANCEL[job_id] = threading.Event()
        ACTIVE_JOB = job_id
        library.create_job(job_id, store_id, mode, len(rel_paths))
        for rel_path in rel_paths:
            library.add_job_item(job_id, rel_path)
        thread = threading.Thread(
            target=run_job,
            args=(library, job_id, store_id, model, options, rel_paths, mode),
            name=f"index-{job_id[:8]}",
            daemon=True,
        )
        thread.start()
        return job_id


# ---------------------------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------------------------


def merge_frame_hits(rows: list[dict[str, Any]], pad_ms: int = 3000) -> list[dict[str, Any]]:
    by_path: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        by_path.setdefault(row["rel_path"], []).append(row)
    merged: list[dict[str, Any]] = []
    for group in by_path.values():
        group.sort(key=lambda item: item["startMs"])
        current: dict[str, Any] | None = None
        for row in group:
            start = max(0, row["startMs"] - pad_ms)
            end = row["startMs"] + pad_ms
            if current and start <= current["endMs"] + 250:
                if row["score"] > current["score"]:
                    current["anchorMs"] = row["startMs"]
                current["endMs"] = max(current["endMs"], end)
                current["score"] = max(current["score"], row["score"])
            else:
                if current:
                    merged.append(current)
                current = {
                    "libraryId": row["libraryId"],
                    "libraryName": row["libraryName"],
                    "storeId": row["storeId"],
                    "modelId": row["modelId"],
                    "providerId": row["providerId"],
                    "contentKey": row["contentKey"],
                    "assetId": row["assetId"],
                    "path": row["path"],
                    "rel_path": row["rel_path"],
                    "name": row["name"],
                    "startMs": start,
                    "endMs": end,
                    "anchorMs": row["startMs"],
                    "score": row["score"],
                    "engine": "visual",
                }
        if current:
            merged.append(current)
    return merged


def search_store(library: Library, store: sqlite3.Row, query: dict[str, Any], mode: str, top_k: int, filters: dict[str, Any]) -> list[dict[str, Any]]:
    model = json.loads(store["model_json"] or "{}")
    if not model.get("id"):
        return []
    engine = MODELS.engine(model["id"])
    qtype = query.get("type") or "text"
    if qtype == "text":
        vector = engine.encode_text(str(query.get("text") or ""))[0]
    elif qtype == "image":
        image = decode_image(str(query.get("dataUrl") or ""))
        vector = engine.encode_images([image])[0]
    elif qtype == "vector":
        vector = np.asarray(query.get("vector") or [], dtype=np.float32)
    else:
        raise HTTPException(400, "query.type is text, image or vector")
    if vector.size == 0:
        raise HTTPException(400, "empty query vector")
    name = "chunks" if mode == "chunk" else "frames"
    table = open_table(library, store["store_id"], name)
    if table is None:
        return []
    limit = max(1, min(500, int(top_k or 100)))
    rows = table.search(np.asarray(vector, dtype=np.float32)).metric("cosine").limit(limit).to_list()
    excluded = library.excluded_paths()
    kinds = set(filters.get("kinds") or [])
    min_duration = int(filters.get("minDurationMs") or 0)
    max_duration = int(filters.get("maxDurationMs") or 0)
    folder = str(filters.get("folder") or "").strip("/")
    out: list[dict[str, Any]] = []
    for row in rows:
        rel_path = str(row.get("rel_path") or "")
        if not rel_path or rel_path in excluded:
            continue
        asset = library.asset(rel_path)
        if asset is None or asset["state"] != "ready":
            continue
        if not (Path(library.media_root) / rel_path.replace("\\", "/")).is_file():
            continue
        if kinds and asset["kind"] not in kinds:
            continue
        duration = int(asset["duration_ms"] or 0)
        if min_duration and duration < min_duration:
            continue
        if max_duration and duration > max_duration:
            continue
        if folder and not rel_path.startswith(folder.rstrip("/") + "/"):
            continue
        score = 1.0 - float(row.get("_distance", 1.0))
        score = clamp(score, -1.0, 1.0)
        if mode == "chunk":
            start = int(row.get("start_ms") or 0)
            end = int(row.get("end_ms") or start)
            out.append(
                {
                    "libraryId": library.id,
                    "libraryName": library.name,
                    "storeId": store["store_id"],
                    "modelId": model.get("id"),
                    "providerId": model.get("provider"),
                    "contentKey": row.get("content_key") or asset["content_key"],
                    "assetId": rel_path,
                    "path": rel_path,
                    "rel_path": rel_path,
                    "name": asset["name"],
                    "kind": asset["kind"],
                    "startMs": start,
                    "endMs": max(start, end),
                    "anchorMs": start,
                    "score": score,
                    "engine": "visual",
                }
            )
        else:
            start = int(row.get("start_ms") or 0)
            out.append(
                {
                    "libraryId": library.id,
                    "libraryName": library.name,
                    "storeId": store["store_id"],
                    "modelId": model.get("id"),
                    "providerId": model.get("provider"),
                    "contentKey": row.get("content_key") or asset["content_key"],
                    "assetId": rel_path,
                    "path": rel_path,
                    "rel_path": rel_path,
                    "name": asset["name"],
                    "kind": asset["kind"],
                    "startMs": start,
                    "endMs": start,
                    "anchorMs": start,
                    "score": score,
                    "engine": "visual",
                }
            )
    if mode == "frame":
        out = merge_frame_hits(out)
    return out


def search_libraries(library_ids: list[str], query: dict[str, Any], mode: str, top_k: int, filters: dict[str, Any], store_ids: list[str] | None) -> dict[str, Any]:
    started = time.perf_counter()
    per_store: list[tuple[str, list[dict[str, Any]]]] = []
    for library_id in library_ids:
        try:
            library = get_library(library_id)
        except HTTPException as exc:
            if exc.status_code in {404, 410}:
                continue
            raise
        stores = library.stores()
        if store_ids:
            stores = [store for store in stores if store["store_id"] in store_ids]
        else:
            default = library.default_store()
            if default:
                stores = [store for store in stores if store["store_id"] == default]
            else:
                stores = [store for store in stores if store["state"] in {"ready", "partial", "indexing"}][:1]
        for store in stores:
            if store["state"] not in {"ready", "partial", "indexing"}:
                continue
            hits = search_store(library, store, query, mode, top_k, filters)
            if hits:
                per_store.append((store["store_id"], hits))
    if not per_store:
        return {
            "hits": [],
            "meta": {
                "returned": 0,
                "elapsedMs": int((time.perf_counter() - started) * 1000),
                "mode": mode,
                "storeIds": store_ids or [],
                "modelIds": [],
                "indexState": "ready",
            },
        }
    fused: dict[str, dict[str, Any]] = {}
    multiple = len(per_store) > 1
    for _store_id, hits in per_store:
        hits.sort(key=lambda hit: hit["score"], reverse=True)
        for rank, hit in enumerate(hits, start=1):
            key = f"{hit['libraryId']}|{hit['path']}|{hit['startMs']}|{hit['endMs']}"
            current = fused.get(key)
            contribution = 1.0 / (60 + rank)
            if current is None:
                item = dict(hit)
                item["rankScore"] = contribution if multiple else hit["score"]
                fused[key] = item
            else:
                current["rankScore"] += contribution
                current["score"] = max(current["score"], hit["score"])
    hits = sorted(fused.values(), key=lambda hit: hit.get("rankScore", hit["score"]), reverse=True)[: max(1, min(500, top_k))]
    return {
        "hits": hits,
        "meta": {
            "returned": len(hits),
            "elapsedMs": int((time.perf_counter() - started) * 1000),
            "mode": mode,
            "storeIds": [store_id for store_id, _ in per_store],
            "modelIds": sorted({hit["modelId"] for hit in hits if hit.get("modelId")}),
            "indexState": "ready",
        },
    }


# ---------------------------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------------------------

app = FastAPI(title="OpenFilm Semantic Index", version=APP_VERSION)


@app.middleware("http")
async def authenticate(request: Request, call_next):
    if request.headers.get("authorization") != f"Bearer {TOKEN}":
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    return await call_next(request)


@app.get("/v1/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "version": APP_VERSION,
        "videoSeek": bool(ChineseCLIPOnnxEngine and stream_frames_with_ffmpeg and SemanticChunkStreamBuilder),
        "chineseClip": ChineseCLIPOnnxEngine is not None,
        "frameExtraction": stream_frames_with_ffmpeg is not None,
        "chunking": SemanticChunkStreamBuilder is not None,
        "modelsRoot": MODELS_ROOT,
        "models": len(MODELS.list()),
        "libraries": len(LIBRARIES),
        "device": "gpu" if ARGS.prefer_gpu else "cpu",
    }


@app.get("/v1/models")
def models() -> dict[str, Any]:
    MODELS.scan()
    return {"models": MODELS.list()}


@app.post("/v1/models/refresh")
def refresh_models() -> dict[str, Any]:
    MODELS.scan()
    return {"models": MODELS.list()}


@app.post("/v1/libraries")
async def register_library(request: Request) -> dict[str, Any]:
    payload = await request.json()
    library_id = str(payload.get("id") or "").strip()
    media_root = str(payload.get("mediaRoot") or "").strip()
    index_root = str(payload.get("indexRoot") or "").strip()
    if not library_id or not media_root or not index_root:
        raise HTTPException(400, "id, mediaRoot and indexRoot are required")
    if not os.path.isdir(media_root):
        raise HTTPException(404, "mediaRoot is not a directory")
    os.makedirs(index_root, exist_ok=True)
    try:
        probe = os.path.join(index_root, ".write-test")
        with open(probe, "w", encoding="utf-8") as fh:
            fh.write("ok")
        os.remove(probe)
    except Exception as exc:
        raise HTTPException(403, f"indexRoot is not writable: {exc}") from exc
    with LIBRARIES_LOCK:
        old = LIBRARIES.get(library_id)
        if old and os.path.normcase(old.media_root) == os.path.normcase(os.path.abspath(media_root)) and os.path.normcase(old.index_root) == os.path.normcase(os.path.abspath(index_root)):
            old.name = str(payload.get("name") or old.name)
            library = old
        else:
            if old:
                old.close()
            library = Library(
                library_id,
                str(payload.get("name") or library_id),
                str(payload.get("kind") or "project"),
                media_root,
                index_root,
            )
            LIBRARIES[library_id] = library
    return {"library": library.status()}


@app.delete("/v1/libraries/{library_id}")
def unregister_library(library_id: str) -> dict[str, Any]:
    with LIBRARIES_LOCK:
        library = LIBRARIES.pop(library_id, None)
    if library:
        library.close()
    return {"ok": True}


@app.get("/v1/libraries/{library_id}/status")
def library_status(library_id: str) -> dict[str, Any]:
    return {"library": get_library(library_id).status()}


@app.post("/v1/libraries/{library_id}/reconcile")
async def reconcile_library(library_id: str, request: Request) -> dict[str, Any]:
    library = get_library(library_id)
    payload = await request.json()
    assets = payload.get("assets") if isinstance(payload, dict) else []
    scope = payload.get("scope") if isinstance(payload, dict) else None
    library.reconcile(assets if isinstance(assets, list) else [], scope if isinstance(scope, list) else None)
    return {"library": library.status()}


def _job_dict(job: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(job) if job else None


@app.post("/v1/index/jobs")
async def create_job(request: Request) -> dict[str, Any]:
    payload = await request.json()
    library = get_library(str(payload.get("libraryId") or ""))
    model = MODELS.get(str(payload.get("modelId") or ""))
    options = quality_options(payload.get("options"))
    store_id = str(payload.get("storeId") or "").strip() or store_id_for(model, options)
    library.ensure_store(store_id, model, options)
    assets = payload.get("assets") or []
    if not isinstance(assets, list) or not assets:
        raise HTTPException(400, "assets is empty")
    rel_paths: list[str] = []
    mode = str(payload.get("mode") or "update")
    for asset in assets:
        rel_path = str(asset.get("path") or "").strip()
        if not rel_path:
            continue
        path = Path(rel_path) if os.path.isabs(rel_path) else safe_join(library.media_root, rel_path)
        if not path.is_file():
            continue
        current = library.asset(rel_path)
        size = int(asset.get("size") or path.stat().st_size)
        mtime = int(asset.get("mtimeMs") or round(path.stat().st_mtime * 1000))
        if mode != "rebuild" and current is not None and current["state"] == "ready":
            if size == int(current["size"] or 0) and abs(mtime - int(current["mtime_ms"] or 0)) <= 1000:
                if store_has_asset(library, store_id, rel_path):
                    continue
        library.upsert_asset(
            rel_path,
            name=str(asset.get("name") or os.path.basename(rel_path)),
            kind=str(asset.get("kind") or kind_of(rel_path)),
            size=size,
            mtime_ms=mtime,
            duration_ms=int(asset.get("durationMs") or 0),
            state="not-indexed",
        )
        rel_paths.append(rel_path)
    if not rel_paths:
        raise HTTPException(409, "nothing changed to index")
    job_id = start_job(library, store_id, model, options, rel_paths, mode)
    return {"job": _job_dict(library.job(job_id)), "storeId": store_id}


@app.get("/v1/index/jobs/{job_id}")
def job_status(job_id: str, libraryId: str) -> dict[str, Any]:
    library = get_library(libraryId)
    job = library.job(job_id)
    if not job:
        raise HTTPException(404, "no such job")
    with library.lock:
        items = [dict(row) for row in library.conn.execute("SELECT * FROM job_items WHERE job_id = ?", (job_id,))]
    return {"job": dict(job), "items": items}


@app.post("/v1/index/jobs/{job_id}/cancel")
def cancel_job(job_id: str, libraryId: str) -> dict[str, Any]:
    get_library(libraryId)
    with JOB_LOCK:
        cancel = JOB_CANCEL.get(job_id)
    if cancel:
        cancel.set()
    return {"ok": True}


@app.post("/v1/libraries/{library_id}/remove-source")
async def remove_source(library_id: str, request: Request) -> dict[str, Any]:
    library = get_library(library_id)
    payload = await request.json()
    root = os.path.abspath(str(payload.get("root") or ""))
    prefix = root.rstrip(os.sep) + os.sep
    rows = library.assets()
    removed = 0
    for row in rows:
        rel_path = str(row["rel_path"] or "")
        path = os.path.normcase(os.path.abspath(rel_path))
        if not (path == os.path.normcase(root) or path.startswith(os.path.normcase(prefix))):
            continue
        for store in library.stores():
            delete_asset_rows(library, store["store_id"], rel_path)
        with library.lock, library.conn:
            library.conn.execute("DELETE FROM assets WHERE rel_path = ?", (rel_path,))
        removed += 1
    return {"removed": removed, "library": library.status()}


@app.post("/v1/libraries/{library_id}/import-legacy")
async def import_legacy(library_id: str, request: Request) -> dict[str, Any]:
    """One-time import of the old per-project catalogs and Lance stores into the global library."""
    library = get_library(library_id)
    payload = await request.json()
    sources = payload.get("sources") if isinstance(payload, dict) else []
    imported_assets = imported_stores = 0
    for source in sources if isinstance(sources, list) else []:
        if not isinstance(source, dict):
            continue
        root = os.path.abspath(str(source.get("root") or ""))
        index_root = os.path.abspath(str(source.get("indexRoot") or ""))
        catalog = os.path.join(index_root, "catalog.sqlite")
        if not root or not os.path.isfile(catalog):
            continue
        try:
            old = sqlite3.connect(catalog)
            old.row_factory = sqlite3.Row
            old_stores = list(old.execute("SELECT * FROM stores").fetchall())
            for old_store in old_stores:
                model = json.loads(old_store["model_json"] or "{}")
                if not model.get("id"):
                    continue
                options = json.loads(old_store["options_json"] or "{}")
                store_id = str(old_store["store_id"])
                library.ensure_store(store_id, model, options)
                for name in ("frames", "chunks"):
                    try:
                        table = lancedb.connect(os.path.join(index_root, "stores", store_id)).open_table(name)
                        rows = table.to_arrow().to_pylist()
                    except Exception:
                        rows = []
                    if rows:
                        for row in rows:
                            rel = str(row.get("rel_path") or "")
                            if rel and not os.path.isabs(rel):
                                row["rel_path"] = os.path.normpath(os.path.join(root, rel))
                        append_rows(library, store_id, name, rows)
                library.set_store_state(store_id, str(old_store["state"] or "ready"))
                imported_stores += 1
            old_assets = list(old.execute("SELECT * FROM assets").fetchall())
            for row in old_assets:
                rel = str(row["rel_path"] or "")
                if not rel:
                    continue
                data = dict(row)
                data["rel_path"] = rel if os.path.isabs(rel) else os.path.normpath(os.path.join(root, rel))
                library.upsert_asset(
                    data["rel_path"],
                    name=data.get("name") or os.path.basename(rel),
                    kind=data.get("kind") or kind_of(rel),
                    content_key=data.get("content_key"),
                    size=int(data.get("size") or 0),
                    mtime_ms=int(data.get("mtime_ms") or 0),
                    duration_ms=int(data.get("duration_ms") or 0),
                    state=data.get("state") or "not-indexed",
                    error=data.get("error"),
                )
                imported_assets += 1
            old.close()
        except Exception:
            continue
    return {"importedAssets": imported_assets, "importedStores": imported_stores, "library": library.status()}


@app.delete("/v1/libraries/{library_id}/index")
def delete_index(library_id: str, storeId: str | None = None) -> dict[str, Any]:
    library = get_library(library_id)
    if storeId:
        store = library.store(storeId)
        if not store:
            raise HTTPException(404, "no such store")
        with library.lock, library.conn:
            library.conn.execute("DELETE FROM stores WHERE store_id = ?", (storeId,))
            remaining = int(library.conn.execute("SELECT COUNT(*) AS n FROM stores").fetchone()["n"])
            if remaining == 0:
                library.conn.execute("UPDATE assets SET state = 'not-indexed' WHERE state IN ('ready', 'stale', 'partial')")
        for name in ("frames", "chunks"):
            table = open_table(library, storeId, name)
            if table is not None:
                try:
                    table.delete("1 = 1")
                except Exception:
                    pass
        shutil.rmtree(os.path.join(library.index_root, "stores", storeId), ignore_errors=True)
        return {"ok": True}
    with library.lock, library.conn:
        stores = [row["store_id"] for row in library.conn.execute("SELECT store_id FROM stores")]
        library.conn.execute("DELETE FROM stores")
        library.conn.execute("UPDATE assets SET state = 'not-indexed', error = NULL")
    for store_id in stores:
        shutil.rmtree(os.path.join(library.index_root, "stores", store_id), ignore_errors=True)
    return {"ok": True}


@app.post("/v1/search")
async def search(request: Request) -> dict[str, Any]:
    payload = await request.json()
    library_ids = [str(value) for value in (payload.get("libraryIds") or []) if value]
    if not library_ids:
        raise HTTPException(400, "libraryIds is required")
    query = payload.get("query") or {}
    if not isinstance(query, dict):
        raise HTTPException(400, "query is required")
    mode = "frame" if payload.get("mode") == "frame" else "chunk"
    top_k = int(payload.get("topK") or 100)
    filters = payload.get("filters") or {}
    store_ids = payload.get("storeIds") or None
    return search_libraries(library_ids, query, mode, top_k, filters, store_ids)


@app.get("/v1/thumb")
def thumb(libraryId: str, path: str, ms: int = 0, w: int = 320):
    library = get_library(libraryId)
    if os.path.isabs(path) and library.asset(path) is None:
        raise HTTPException(404, "no such asset")
    source = Path(path) if os.path.isabs(path) else safe_join(library.media_root, path)
    if not source.is_file():
        raise HTTPException(404, "no such file")
    ext = source.suffix.lower()
    if ext in IMAGE_EXT:
        data = source.read_bytes()
        media = "image/jpeg" if ext in {".jpg", ".jpeg"} else "image/png"
        return Response(content=data, media_type=media)
    width = max(64, min(960, int(w or 320)))
    seconds = max(0.0, float(ms or 0) / 1000.0)
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-ss", f"{seconds:.3f}",
        "-i", str(source), "-frames:v", "1", "-vf", f"scale={width}:-2",
        "-f", "image2pipe", "-vcodec", "mjpeg", "-",
    ]
    try:
        result = subprocess.run(command, capture_output=True, timeout=30, check=False)
    except Exception as exc:
        raise HTTPException(500, f"thumbnail failed: {exc}") from exc
    if result.returncode != 0 or not result.stdout:
        raise HTTPException(404, "no frame at that time")
    return Response(content=result.stdout, media_type=JPEG)


def main() -> None:
    # Pick the port before uvicorn starts so the parent can be told immediately.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind((ARGS.host, int(ARGS.port or 0)))
    port = int(sock.getsockname()[1])
    sock.close()
    print(json.dumps({"port": port, "token": TOKEN}), flush=True)
    uvicorn.run(app, host=ARGS.host, port=port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
