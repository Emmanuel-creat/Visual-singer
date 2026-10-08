"""Recherche sémantique locale : BGE-M3 (vecteurs denses) + BM25 (mots-clés) + BGE-reranker.

L'index d'un projet est stocké dans index/ :
  chunks.json   passages (paragraphes de transcription + morceaux du support)
  emb.npy       vecteurs normalisés (float16)
La recherche hybride combine similarité cosinus et BM25, puis le reranker
(cross-encoder) réordonne les meilleurs candidats.
"""
from __future__ import annotations

import re
import threading
from functools import lru_cache
from pathlib import Path

import numpy as np

from .config import EMBED_MODEL, MODELS_DIR, RERANK_MODEL
from .hardware import detect, free_gpu

_lock = threading.RLock()
_embedder = None
_reranker = None


def embedder():
    global _embedder
    with _lock:
        if _embedder is None:
            from sentence_transformers import SentenceTransformer
            dev = "cuda" if detect().torch_cuda else "cpu"
            m = SentenceTransformer(EMBED_MODEL, device=dev, cache_folder=str(MODELS_DIR / "sentence-transformers"))
            m.max_seq_length = 1024
            if dev == "cuda":
                m.half()
            _embedder = m
        return _embedder


def reranker():
    global _reranker
    with _lock:
        if _reranker is None:
            from sentence_transformers import CrossEncoder
            dev = "cuda" if detect().torch_cuda else "cpu"
            r = CrossEncoder(RERANK_MODEL, max_length=512, device=dev, cache_folder=str(MODELS_DIR / "sentence-transformers"))
            if dev == "cuda":
                r.model.half()
            _reranker = r
        return _reranker


def release() -> None:
    global _embedder, _reranker
    with _lock:
        _embedder = None
        _reranker = None
    free_gpu()


def embed(texts: list[str], progress=None, batch: int = 16) -> np.ndarray:
    m = embedder()
    out = []
    for i in range(0, len(texts), batch):
        out.append(m.encode(texts[i:i + batch], batch_size=batch, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False))
        if progress:
            progress(min(1.0, (i + batch) / max(1, len(texts))))
    return np.concatenate(out).astype(np.float32) if out else np.zeros((0, 1024), np.float32)


def rerank(query: str, texts: list[str]) -> np.ndarray:
    if not texts:
        return np.zeros(0)
    with _lock:
        scores = reranker().predict([(query, t) for t in texts], batch_size=16, show_progress_bar=False)
    return np.asarray(scores, dtype=np.float32)


TOKEN_RE = re.compile(r"[\wÀ-ÖØ-öø-ÿ]+", re.UNICODE)


def tokenize(text: str) -> list[str]:
    return [t.lower() for t in TOKEN_RE.findall(text) if len(t) > 1]


class Index:
    def __init__(self, folder: Path):
        import json
        self.folder = folder
        self.chunks = json.loads((folder / "chunks.json").read_text(encoding="utf-8"))
        self.emb = np.load(folder / "emb.npy").astype(np.float32)
        from rank_bm25 import BM25Okapi
        self.bm25 = BM25Okapi([tokenize(c["text"]) or ["∅"] for c in self.chunks])

    def search(self, query: str, k: int = 10, kinds: tuple[str, ...] | None = None, use_rerank: bool = True) -> list[dict]:
        if not self.chunks:
            return []
        q = embed([query])[0]
        dense = self.emb @ q
        bm = np.asarray(self.bm25.get_scores(tokenize(query)), dtype=np.float32)
        if bm.max() > 0:
            bm = bm / bm.max()
        score = 0.65 * dense + 0.35 * bm
        if kinds:
            mask = np.array([c["kind"] in kinds for c in self.chunks])
            score = np.where(mask, score, -1e9)
        cand = np.argsort(-score)[: max(k * 4, 30)]
        cand = [int(i) for i in cand if score[i] > -1e8]
        results = [{**self.chunks[i], "score": float(score[i]), "dense": float(dense[i])} for i in cand]
        if use_rerank and results:
            rr = rerank(query, [r["text"][:1500] for r in results])
            for r, s in zip(results, rr):
                r["rerank"] = float(s)
            results.sort(key=lambda r: -r["rerank"])
        return results[:k]


@lru_cache(maxsize=4)
def _load(folder: str, stamp: float) -> Index:
    return Index(Path(folder))


def open_index(folder: Path) -> Index | None:
    if not (folder / "chunks.json").exists() or not (folder / "emb.npy").exists():
        return None
    return _load(str(folder), (folder / "emb.npy").stat().st_mtime)
