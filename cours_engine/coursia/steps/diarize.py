"""Séparation des intervenants (diarisation).

Empreintes vocales ECAPA-TDNN (SpeechBrain, VoxCeleb) calculées sur chaque segment
de parole (les segments longs sont découpés en morceaux de ~6 s), puis
regroupement hiérarchique en distance cosinus. Le nombre d'intervenants est imposé
s'il est connu, sinon estimé (seuil de distance + fusion des groupes marginaux).
Les intervenants sont numérotés par temps de parole décroissant.
"""
from __future__ import annotations

import numpy as np

from ..config import MODELS_DIR, SPEAKER_MODEL
from ..hardware import detect, free_gpu
from ..store import Project, cache_key

VERSION = "diar-v1"
PIECE_S = 6.0
MIN_PIECE_S = 1.2
DIST_THRESHOLD = 0.62
SR = 16000

_enc = None


def _encoder():
    global _enc
    if _enc is None:
        from speechbrain.inference.speaker import EncoderClassifier
        try:
            from speechbrain.utils.fetching import LocalStrategy
            extra = {"local_strategy": LocalStrategy.COPY}   # pas de liens symboliques sous Windows
        except Exception:
            extra = {}
        _enc = EncoderClassifier.from_hparams(
            source=SPEAKER_MODEL, savedir=str(MODELS_DIR / "speechbrain" / "ecapa"),
            run_opts={"device": "cuda" if detect().torch_cuda else "cpu"}, **extra)
    return _enc


def release():
    global _enc
    _enc = None
    free_gpu()


def key(project: Project) -> str:
    s = project.settings()
    return cache_key(VERSION, project.key_of("transcribe"), s.get("speakers"), s.get("diarization"))


def _pieces(segments: list[dict]) -> list[tuple[int, float, float]]:
    out = []
    for i, seg in enumerate(segments):
        a, b = seg["start"], seg["end"]
        if b - a < MIN_PIECE_S:
            out.append((i, a, max(b, a + MIN_PIECE_S)))
            continue
        n = max(1, int(round((b - a) / PIECE_S)))
        step = (b - a) / n
        for k in range(n):
            out.append((i, a + k * step, a + (k + 1) * step))
    return out


def run(project: Project, ctx, transcript: dict) -> dict:
    s = project.settings()
    k = key(project)
    cached = project.cached("diarize", k)
    if cached is not None:
        return cached
    segments = transcript["segments"]
    if not s.get("diarization") or s.get("speakers") == 1 or len(segments) < 4:
        data = {"speakers": ["Intervenant 1"], "labels": [0] * len(segments), "method": "aucune"}
        project.put("diarize", k, data)
        return data

    import soundfile as sf
    import torch
    wav, sr = sf.read(str(project.work / "audio16k.wav"), dtype="float32", always_2d=False)
    pieces = _pieces(segments)
    ctx.log(f"Empreintes vocales de {len(pieces)} extraits…")
    enc = _encoder()
    embs = []
    batch = 32
    for i in range(0, len(pieces), batch):
        group = pieces[i:i + batch]
        clips = [wav[int(a * SR):int(b * SR)] for _, a, b in group]
        L = max(len(c) for c in clips)
        x = np.zeros((len(clips), L), dtype=np.float32)
        lens = np.zeros(len(clips), dtype=np.float32)
        for j, c in enumerate(clips):
            x[j, :len(c)] = c
            lens[j] = len(c) / L
        with torch.no_grad():
            e = enc.encode_batch(torch.from_numpy(x), torch.from_numpy(lens)).squeeze(1).cpu().numpy()
        embs.append(e)
        ctx.progress(min(0.9, (i + batch) / len(pieces) * 0.9))
    release()
    E = np.concatenate(embs)
    E /= np.linalg.norm(E, axis=1, keepdims=True) + 1e-9

    # Une empreinte moyenne par segment (pondérée par la durée des morceaux).
    seg_emb = np.zeros((len(segments), E.shape[1]), dtype=np.float32)
    seg_w = np.zeros(len(segments))
    for (si, a, b), e in zip(pieces, E):
        seg_emb[si] += e * (b - a)
        seg_w[si] += b - a
    seg_emb /= np.maximum(seg_w[:, None], 1e-9)
    seg_emb /= np.linalg.norm(seg_emb, axis=1, keepdims=True) + 1e-9

    from sklearn.cluster import AgglomerativeClustering
    n_spk = int(s.get("speakers") or 0)
    if n_spk > 1:
        cl = AgglomerativeClustering(n_clusters=n_spk, metric="cosine", linkage="average")
    else:
        cl = AgglomerativeClustering(n_clusters=None, metric="cosine", linkage="average", distance_threshold=DIST_THRESHOLD)
    labels = cl.fit_predict(seg_emb)

    durations = np.array([seg["end"] - seg["start"] for seg in segments])
    # Fusion des groupes marginaux (< 3 % du temps de parole) dans le plus proche.
    if n_spk <= 1:
        total = durations.sum()
        for _ in range(20):
            share = {c: durations[labels == c].sum() / total for c in np.unique(labels)}
            small = [c for c, v in share.items() if v < 0.03]
            big = [c for c in share if c not in small]
            if not small or not big:
                break
            cents = {c: seg_emb[labels == c].mean(0) for c in share}
            for c in small:
                best = max(big, key=lambda b: float(np.dot(cents[c], cents[b])))
                labels[labels == c] = best

    # Lissage : une intervention isolée très courte prend l'étiquette de ses voisins.
    for i in range(1, len(labels) - 1):
        if labels[i - 1] == labels[i + 1] != labels[i] and durations[i] < 2.0:
            labels[i] = labels[i - 1]

    # Numérotation par temps de parole décroissant.
    order = sorted(np.unique(labels), key=lambda c: -durations[labels == c].sum())
    remap = {c: i for i, c in enumerate(order)}
    final = [int(remap[c]) for c in labels]
    speakers = [f"Intervenant {i + 1}" for i in range(len(order))]
    shares = {speakers[i]: round(float(durations[np.array(final) == i].sum() / max(1e-9, durations.sum())), 3) for i in range(len(order))}
    ctx.log(f"{len(speakers)} intervenant(s) détecté(s) : " + ", ".join(f"{k} {v * 100:.0f} %" for k, v in shares.items()))
    data = {"speakers": speakers, "labels": final, "shares": shares, "method": "ecapa"}
    project.put("diarize", k, data)
    return data
