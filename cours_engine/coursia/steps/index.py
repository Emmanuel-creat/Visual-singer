"""Indexation sémantique, découpage en sections et rapprochement audio ↔ support.

1. Passages : paragraphes de transcription + morceaux du support (≤ 1 200 caractères).
2. Vecteurs BGE-M3 (GPU, fp16) → index/emb.npy, index/chunks.json.
3. Sections thématiques : creux de similarité entre fenêtres de paragraphes
   (méthode « TextTiling » sur vecteurs), contraintes de durée 3–15 min.
4. Alignement phrase → diapositive/page par programmation dynamique (Viterbi), à
   l'échelle de la phrase (horodatage au mot) pour suivre finement le support :
   la parole avance en général dans le support, les retours en arrière et les
   sauts sont permis mais pénalisés ; état « aucune diapositive » si rien ne correspond.
5. Couverture : chaque puce du support est comparée à la transcription
   (notions du support non expliquées oralement).
"""
from __future__ import annotations

import json
import re

import numpy as np

from .. import retrieval
from ..store import Project, cache_key, write_json

VERSION = "index-v2"
DOC_CHUNK = 1200


def _fmt(t: float) -> str:
    t = int(t)
    return f"{t // 3600}:{t % 3600 // 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60:02d}:{t % 60:02d}"


def unit_text(u: dict) -> str:
    parts = [u.get("title") or "", u.get("text") or ""]
    if u.get("tables"):
        parts.append("\n".join(u["tables"]))
    if u.get("notes"):
        parts.append("Notes : " + u["notes"])
    return "\n".join(p for p in parts if p).strip()


def doc_chunks(units: list[dict]) -> list[dict]:
    out = []
    for u in units:
        txt = unit_text(u)
        if not txt:
            continue
        pieces, buf = [], ""
        for line in txt.split("\n"):
            if len(buf) + len(line) > DOC_CHUNK and buf:
                pieces.append(buf)
                buf = ""
            buf += line + "\n"
        if buf.strip():
            pieces.append(buf)
        for j, p in enumerate(pieces):
            out.append({"id": f"{u['id']}#{j}", "kind": "doc", "unit": u["id"], "doc": u["doc"], "doc_name": u.get("doc_name", ""),
                        "n": u["n"], "unit_kind": u["kind"], "title": u.get("title", ""), "text": p.strip(), "image": u.get("image")})
    return out


def sections_from(paras: list[dict], E: np.ndarray, duration: float) -> list[dict]:
    """Découpage thématique : frontières aux creux de similarité entre fenêtres voisines."""
    n = len(paras)
    if n == 0:
        return []
    if n < 6:
        return [{"id": 0, "start": paras[0]["start"], "end": paras[-1]["end"], "paras": list(range(n))}]
    w = 3
    sims = np.ones(n)
    for i in range(1, n):
        a = E[max(0, i - w):i].mean(0)
        b = E[i:min(n, i + w)].mean(0)
        sims[i] = float(a @ b / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))
    # Profondeur des creux.
    depth = np.zeros(n)
    for i in range(1, n - 1):
        left = sims[max(0, i - 4):i + 1].max()
        right = sims[i:min(n, i + 5)].max()
        depth[i] = (left - sims[i]) + (right - sims[i])
    target = max(1, round(duration / 420))          # ~ une section toutes les 7 min
    min_s, max_s = 180.0, 900.0
    order = np.argsort(-depth)
    cuts = []
    for i in order:
        if depth[i] <= 0.02 or len(cuts) >= target * 2:
            break
        t = paras[i]["start"]
        if t - paras[0]["start"] < min_s or paras[-1]["end"] - t < min_s:
            continue
        if any(abs(t - paras[c]["start"]) < min_s for c in cuts):
            continue
        cuts.append(int(i))
    cuts = sorted(cuts)[: max(target, 1) * 2]
    # Sections trop longues : coupe supplémentaire au meilleur creux interne.
    bounds = [0, *cuts, n]
    changed = True
    while changed:
        changed = False
        for a, b in zip(bounds, bounds[1:]):
            if paras[b - 1]["end"] - paras[a]["start"] > max_s and b - a > 4:
                inner = [i for i in range(a + 2, b - 1) if paras[i]["start"] - paras[a]["start"] >= min_s * 0.7
                         and paras[b - 1]["end"] - paras[i]["start"] >= min_s * 0.7]
                if inner:
                    best = max(inner, key=lambda i: depth[i])
                    bounds = sorted(set(bounds + [best]))
                    changed = True
                    break
    return [{"id": j, "start": paras[a]["start"], "end": paras[b - 1]["end"], "paras": list(range(a, b))}
            for j, (a, b) in enumerate(zip(bounds, bounds[1:])) if b > a]


def align(paras: list[dict], P: np.ndarray, units: list[dict], U: np.ndarray) -> list[dict]:
    """Viterbi : état = diapositive/page (dans l'ordre des documents) ou « aucune »."""
    n, m = len(paras), len(units)
    if n == 0 or m == 0:
        return [{"unit": None, "score": 0.0} for _ in paras]
    S = P @ U.T                                        # similarités paragraphes × unités
    NONE_EMIT = 0.42                                   # similarité équivalente de l'état « aucune »
    emit = np.concatenate([S, np.full((n, 1), NONE_EMIT)], axis=1)
    order_doc = [u["doc"] for u in units]
    idx_in_doc = [u["n"] for u in units]

    def trans(a: int, b: int) -> float:
        if a == m or b == m:
            return -0.04
        if a == b:
            return 0.0
        if order_doc[a] != order_doc[b]:
            return -0.10
        d = idx_in_doc[b] - idx_in_doc[a]
        if d == 1:
            return -0.015
        if 1 < d <= 4:
            return -0.05
        if d > 4:
            return -0.09
        return -0.08 if d >= -2 else -0.12           # retour en arrière

    T = np.array([[trans(a, b) for b in range(m + 1)] for a in range(m + 1)], dtype=np.float32)
    score = emit[0].copy()
    back = np.zeros((n, m + 1), dtype=np.int32)
    for i in range(1, n):
        cand = score[:, None] + T * 4.0                 # pondération des transitions
        back[i] = np.argmax(cand, axis=0)
        score = cand[back[i], np.arange(m + 1)] + emit[i]
    path = [int(np.argmax(score))]
    for i in range(n - 1, 0, -1):
        path.append(int(back[i][path[-1]]))
    path.reverse()
    out = []
    for i, st in enumerate(path):
        if st == m:
            out.append({"unit": None, "score": 0.0})
        else:
            out.append({"unit": units[st]["id"], "score": round(float(S[i, st]), 3)})
    return out


BULLET_SPLIT = re.compile(r"\n+")


SENT_END = re.compile(r"[.!?…:;]$")


def sentences(paras: list[dict], segments: list[dict]) -> list[dict]:
    """Phrases horodatées (à partir des mots) ; unité fine pour l'alignement et la couverture."""
    by_id = {x["id"]: x for x in segments}
    out = []
    for p in paras:
        words = [w for sid in p.get("segs", []) for w in (by_id.get(sid, {}).get("words") or [])]
        if not words:
            out.append({"para": p["id"], "start": p["start"], "end": p["end"], "text": p["text"]})
            continue
        cur = []
        for w in words:
            cur.append(w)
            txt = "".join(x["w"] for x in cur).strip()
            if (SENT_END.search(w["w"].strip()) and len(txt) >= 25) or len(txt) > 320:
                out.append({"para": p["id"], "start": cur[0]["s"], "end": cur[-1]["e"], "text": txt})
                cur = []
        if cur:
            txt = "".join(x["w"] for x in cur).strip()
            if out and out[-1]["para"] == p["id"] and len(txt) < 25:
                out[-1]["text"] += " " + txt
                out[-1]["end"] = cur[-1]["e"]
            else:
                out.append({"para": p["id"], "start": cur[0]["s"], "end": cur[-1]["e"], "text": txt})
    return out


def coverage(units: list[dict], S_emb: np.ndarray, sents: list[dict], ctx) -> list[dict]:
    """Couverture orale de chaque puce/ligne du support (comparée aux phrases et paires de phrases)."""
    items = []
    for u in units:
        lines = [l.strip(" •-–\t") for l in BULLET_SPLIT.split((u.get("text") or "")) if len(l.strip(" •-–\t")) >= 12]
        if u.get("title") and len(u["title"]) >= 15 and lines:
            lines = [u["title"]] + lines
        for l in lines[:40]:
            items.append((u, l))
    if not items or len(S_emb) == 0:
        return []
    L = retrieval.embed([l for _, l in items], progress=lambda p: ctx.progress(0.85 + 0.1 * p))
    # Fenêtres de deux phrases consécutives : une puce est souvent expliquée sur plusieurs phrases.
    W = S_emb
    if len(S_emb) > 1:
        pair = S_emb[:-1] + S_emb[1:]
        pair = pair / (np.linalg.norm(pair, axis=1, keepdims=True) + 1e-9)
        W = np.concatenate([S_emb, pair])
    sim = L @ W.T
    best = sim.argmax(1)
    n = len(S_emb)
    out = []
    for (u, line), j, row in zip(items, best, sim):
        si = int(j) if j < n else int(j - n)
        out.append({"unit": u["id"], "line": line, "score": round(float(row[j]), 3),
                    "para": sents[si]["para"], "t": sents[si]["start"]})
    return out


def key(project: Project) -> str:
    return cache_key(VERSION, project.key_of("paragraphs"), project.key_of("documents"), project.key_of("transcribe"))


def run(project: Project, ctx, paragraphs: dict, documents: dict, duration: float, transcript: dict | None = None) -> dict:
    k = key(project)
    cached = project.cached("index", k)
    if cached is not None and (project.index_dir / "emb.npy").exists():
        return cached
    paras = paragraphs["paragraphs"]
    units = documents.get("units") or []
    speakers = paragraphs.get("speakers") or []

    ctx.log("Calcul des vecteurs sémantiques (BGE-M3)…")
    para_chunks = [{"id": f"t{p['id']}", "kind": "audio", "para": p["id"], "start": p["start"], "end": p["end"],
                    "speaker": speakers[p["speaker"]] if p["speaker"] < len(speakers) else "", "text": p["text"]} for p in paras]
    dchunks = doc_chunks(units)
    texts = [c["text"] for c in para_chunks] + [c["text"] for c in dchunks]
    E = retrieval.embed(texts, progress=lambda p: ctx.progress(p * 0.6))
    P = E[: len(para_chunks)]
    D = E[len(para_chunks):]

    project.index_dir.mkdir(parents=True, exist_ok=True)
    (project.index_dir / "chunks.json").write_text(json.dumps(para_chunks + dchunks, ensure_ascii=False), encoding="utf-8")
    np.save(project.index_dir / "emb.npy", E.astype(np.float16))

    ctx.log("Découpage en sections thématiques…")
    sections = sections_from(paras, P, duration)

    alignment, cov, sents, sent_align = [], [], [], []
    if units:
        ctx.log("Rapprochement transcription ↔ diapositives/pages (phrase par phrase)…")
        sents = sentences(paras, (transcript or {}).get("segments", []))
        SE = retrieval.embed([x["text"] for x in sents], progress=lambda p: ctx.progress(0.6 + p * 0.1))
        U = retrieval.embed([unit_text(u)[:2000] or u.get("title", "") for u in units], progress=lambda p: ctx.progress(0.7 + p * 0.1))
        sent_align = align(sents, SE, units, U)
        # Diapositive d'un paragraphe : celle sur laquelle il passe le plus de temps.
        for p in paras:
            tally, best_score = {}, {}
            for x, a in zip(sents, sent_align):
                if x["para"] == p["id"] and a["unit"]:
                    tally[a["unit"]] = tally.get(a["unit"], 0) + (x["end"] - x["start"])
                    best_score[a["unit"]] = max(best_score.get(a["unit"], 0), a["score"])
            if tally:
                u = max(tally, key=tally.get)
                alignment.append({"unit": u, "score": best_score[u]})
            else:
                alignment.append({"unit": None, "score": 0.0})
        cov = coverage(units, SE, sents, ctx)
        # Diapositives associées à chaque section (par temps passé dessus).
        for s in sections:
            tally = {}
            for pi in s["paras"]:
                a = alignment[pi]
                if a["unit"]:
                    tally[a["unit"]] = tally.get(a["unit"], 0) + (paras[pi]["end"] - paras[pi]["start"])
            s["units"] = [u for u, _ in sorted(tally.items(), key=lambda x: -x[1])]
    for s in sections:
        s.setdefault("units", [])
        s["label"] = f"{_fmt(s['start'])} – {_fmt(s['end'])}"

    # Plages de temps par unité du support (à la phrase près).
    unit_times: dict[str, list] = {}
    for x, a in zip(sents, sent_align):
        if a["unit"]:
            rng = unit_times.setdefault(a["unit"], [])
            if rng and x["start"] - rng[-1][1] < 20:
                rng[-1][1] = x["end"]
            else:
                rng.append([x["start"], x["end"]])
    retrieval.release()
    data = {"sections": sections, "alignment": alignment, "coverage": cov, "unit_times": unit_times,
            "sentences": [{**x, "unit": a["unit"]} for x, a in zip(sents, sent_align)],
            "n_chunks": len(texts)}
    project.put("index", k, data)
    ctx.log(f"{len(sections)} sections, {len(texts)} passages indexés")
    return data
