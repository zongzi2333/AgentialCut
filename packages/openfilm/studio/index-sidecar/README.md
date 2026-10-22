# OpenFilm semantic index sidecar

A local-only HTTP process. Studio starts it with:

```text
python server.py --videos-eek-root <VideoSeek checkout> --models-root <models folder> \
  --config-dir <Studio data folder> --token <random> [--prefer-gpu]
```

The sidecar reuses VideoSeek's Chinese CLIP encoder, FFmpeg frame extractor and semantic
chunker. It adds OpenFilm's SQLite catalog, per-library Lance stores and the HTTP contract in
`TEMP/素材库设计方案.md`.

It must run with a Python environment that has VideoSeek's dependencies (`onnxruntime`,
`lancedb`, `opencv-python`, `fastapi`, `uvicorn`, `tokenizers`). In a checkout, Studio uses
`D:\Tools\VideoSeek\.venv\Scripts\python.exe` when it exists, or `OPENFILM_INDEX_PYTHON`.

It writes only to the registered index root (`<project>/.film/index` or an external library's
`.openfilm/index`). Media roots are read-only.
