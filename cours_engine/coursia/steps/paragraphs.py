"""Regroupement des segments de transcription en paragraphes lisibles.

Un paragraphe = un même intervenant, ≤ ~45 s, coupé de préférence en fin de phrase
ou sur une pause marquée. C'est l'unité de base de l'affichage, de la recherche et
du rapprochement avec le support.
"""
from __future__ import annotations

from ..store import Project, cache_key

VERSION = "para-v1"
MAX_S = 45.0
MIN_S = 12.0
PAUSE_S = 2.5


def key(project: Project) -> str:
    return cache_key(VERSION, project.key_of("transcribe"), project.key_of("diarize"))


def run(project: Project, ctx, transcript: dict, diar: dict) -> dict:
    k = key(project)
    cached = project.cached("paragraphs", k)
    if cached is not None:
        return cached
    segs = transcript["segments"]
    labels = diar.get("labels") or [0] * len(segs)
    speakers = diar.get("speakers") or ["Intervenant 1"]
    paras, cur = [], None

    def flush():
        if cur and cur["text"].strip():
            cur["id"] = len(paras)
            cur["text"] = cur["text"].strip()
            paras.append(cur)

    for i, seg in enumerate(segs):
        spk = labels[i] if i < len(labels) else 0
        if cur is not None:
            dur = seg["end"] - cur["start"]
            gap = seg["start"] - cur["end"]
            sentence_end = cur["text"].rstrip().endswith((".", "?", "!", "…", ":"))
            if spk != cur["speaker"] or gap > PAUSE_S or dur > MAX_S * 1.6 or (dur > MAX_S and sentence_end) \
                    or (cur["end"] - cur["start"] > MIN_S and sentence_end and gap > 1.2):
                flush()
                cur = None
        if cur is None:
            cur = {"start": seg["start"], "end": seg["end"], "speaker": spk, "text": "", "segs": []}
        cur["text"] += " " + seg["text"]
        cur["end"] = seg["end"]
        cur["segs"].append(seg["id"])
    flush()
    data = {"paragraphs": paras, "speakers": speakers}
    project.put("paragraphs", k, data)
    ctx.log(f"{len(paras)} paragraphes")
    return data
