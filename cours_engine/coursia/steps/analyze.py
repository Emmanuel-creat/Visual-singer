"""Analyse par le LLM local, en deux temps (map → reduce) pour tenir sur des cours de plusieurs heures.

1. Pour chaque section thématique (≈ 3 à 15 min) : titre, résumé, points clés, notions et
   définitions, formules, exemples, à retenir, écarts avec les diapositives associées,
   questions de révision. Chaque section est mise en cache séparément : une analyse
   interrompue reprend à la section suivante.
2. Pour l'ensemble du cours : résumé court, résumé détaillé, plan structuré.
3. Croisement audio ↔ support et synthèse finale fusionnée.
"""
from __future__ import annotations

import re

import numpy as np

from .. import llm, retrieval
from ..store import Project, cache_key, read_json, write_json
from .index import unit_text

VERSION = "analyze-v1"

SYSTEM = (
    "Tu es un assistant pédagogique expert qui analyse des cours universitaires en français. "
    "Tu travailles uniquement à partir du contenu fourni (transcription orale et support de cours) : "
    "n'invente aucune information, ne complète pas avec des connaissances extérieures. "
    "La transcription automatique peut contenir des erreurs de reconnaissance : corrige-les silencieusement "
    "quand le contexte ou le support rend l'intention évidente (termes techniques, noms propres). "
    "Écris en français clair et précis. Les horodatages « moment » reprennent exactement les marqueurs [mm:ss] de la transcription."
)

SECTION_SCHEMA = {
    "type": "object",
    "properties": {
        "titre": {"type": "string"},
        "resume": {"type": "string"},
        "points_cles": {"type": "array", "items": {"type": "string"}},
        "notions": {"type": "array", "items": {"type": "object", "properties": {
            "terme": {"type": "string"}, "definition": {"type": "string"}, "moment": {"type": "string"}},
            "required": ["terme", "definition", "moment"]}},
        "formules": {"type": "array", "items": {"type": "object", "properties": {
            "formule": {"type": "string"}, "explication": {"type": "string"}, "moment": {"type": "string"}},
            "required": ["formule", "explication", "moment"]}},
        "exemples": {"type": "array", "items": {"type": "object", "properties": {
            "exemple": {"type": "string"}, "moment": {"type": "string"}}, "required": ["exemple", "moment"]}},
        "a_retenir": {"type": "array", "items": {"type": "string"}},
        "ecarts_support": {"type": "array", "items": {"type": "object", "properties": {
            "type": {"type": "string", "enum": ["contradiction", "difference", "ajout_oral", "non_explique"]},
            "detail": {"type": "string"}, "diapositive": {"type": ["integer", "null"]}, "moment": {"type": "string"}},
            "required": ["type", "detail", "moment"]}},
        "questions": {"type": "array", "items": {"type": "object", "properties": {
            "question": {"type": "string"}, "reponse": {"type": "string"}, "moment": {"type": "string"}},
            "required": ["question", "reponse", "moment"]}},
    },
    "required": ["titre", "resume", "points_cles", "notions", "formules", "exemples", "a_retenir", "ecarts_support", "questions"],
}

COURSE_SCHEMA = {
    "type": "object",
    "properties": {
        "titre_cours": {"type": "string"},
        "resume_court": {"type": "string"},
        "resume_detaille": {"type": "string"},
        "plan": {"type": "array", "items": {"type": "object", "properties": {
            "titre": {"type": "string"}, "sections": {"type": "array", "items": {"type": "integer"}},
            "sous_parties": {"type": "array", "items": {"type": "string"}}}, "required": ["titre", "sections", "sous_parties"]}},
        "notions_essentielles": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["titre_cours", "resume_court", "resume_detaille", "plan", "notions_essentielles"],
}


def fmt(t: float) -> str:
    t = int(max(0, t))
    return f"{t // 3600}:{t % 3600 // 60:02d}:{t % 60:02d}" if t >= 3600 else f"{t // 60:02d}:{t % 60:02d}"


def parse_t(s, default: float | None = None) -> float | None:
    if s is None:
        return default
    m = re.search(r"(?:(\d+):)?(\d{1,2}):(\d{2})", str(s))
    if not m:
        return default
    h, mi, se = m.groups()
    return int(h or 0) * 3600 + int(mi) * 60 + int(se)


def section_prompt(sec: dict, paras: list[dict], speakers: list[str], units_by_id: dict, vocab: list[str]) -> str:
    lines = []
    for pi in sec["paras"]:
        p = paras[pi]
        spk = speakers[p["speaker"]] if len(speakers) > 1 and p["speaker"] < len(speakers) else ""
        lines.append(f"[{fmt(p['start'])}] {spk + ' : ' if spk else ''}{p['text']}")
    transcript = "\n".join(lines)
    if len(transcript) > 24000:
        transcript = transcript[:24000] + "\n[…]"
    support = []
    for uid in sec.get("units", [])[:6]:
        u = units_by_id.get(uid)
        if u:
            label = "Diapositive" if u["kind"] == "slide" else "Page" if u["kind"] == "page" else "Section"
            support.append(f"[{label} {u['n']} — {u.get('doc_name', '')}]\n{unit_text(u)[:1800]}")
    parts = [f"SECTION {sec['id'] + 1} ({fmt(sec['start'])} – {fmt(sec['end'])})", "", "TRANSCRIPTION :", transcript]
    if support:
        parts += ["", "SUPPORT DE COURS ASSOCIÉ À CE PASSAGE :", "\n\n".join(support)]
    else:
        parts += ["", "(Aucune diapositive/page associée à ce passage.)"]
    if vocab:
        parts += ["", "VOCABULAIRE DU SUPPORT (orthographe de référence) : " + ", ".join(vocab[:50])]
    parts += ["", (
        "Analyse ce passage du cours et remplis le JSON :\n"
        "- titre : titre court et informatif de la section ;\n"
        "- resume : 4 à 8 phrases fidèles ;\n"
        "- points_cles : les idées principales (phrases complètes) ;\n"
        "- notions : chaque notion importante avec sa définition telle qu'expliquée ;\n"
        "- formules : formules, équations, règles (en LaTeX si mathématique) avec leur explication ;\n"
        "- exemples : exemples ou cas concrets donnés à l'oral ;\n"
        "- a_retenir : ce que l'enseignant souligne comme important (« retenez », « attention », « c'est au programme »…) ;\n"
        "- ecarts_support : uniquement si un support est fourni — contradiction (l'oral contredit le support), difference "
        "(formulation ou valeur différente), ajout_oral (notion/explication donnée à l'oral absente du support), "
        "non_explique (élément important du support associé non abordé à l'oral) ; indique le numéro de diapositive/page si pertinent ;\n"
        "- questions : 2 à 4 questions de révision avec leur réponse, tirées de ce passage.\n"
        "Laisse une liste vide quand il n'y a rien de pertinent.")]
    return "\n".join(parts)


def key(project: Project) -> str:
    s = project.settings()
    return cache_key(VERSION, project.key_of("index"), s.get("llm_profile"), s.get("qa_count"))


def _norm(t: str) -> str:
    return re.sub(r"\W+", " ", t.lower()).strip()


def run(project: Project, ctx, paragraphs: dict, documents: dict, index: dict) -> dict:
    k = key(project)
    cached = project.cached("analyze", k)
    if cached is not None:
        return cached
    s = project.settings()
    paras = paragraphs["paragraphs"]
    speakers = paragraphs.get("speakers") or []
    units = documents.get("units") or []
    units_by_id = {u["id"]: u for u in units}
    vocab = documents.get("vocabulary") or []
    sections = index["sections"]
    model = llm.pick_model(s.get("llm_profile", "quality"))
    retrieval.release()
    ctx.log(f"Analyse par le LLM local {model} ({len(sections)} sections)…")

    # ---------------------------------------------------------------- map (avec reprise)
    part_file = project.cache / "analyze.sections.json"
    parts = read_json(part_file, {}) or {}
    results = []
    for i, sec in enumerate(sections):
        prompt = section_prompt(sec, paras, speakers, units_by_id, vocab)
        pk = cache_key(model, prompt)
        if parts.get(str(i), {}).get("_key") == pk:
            results.append(parts[str(i)]["data"])
            continue
        ctx.log(f"Section {i + 1}/{len(sections)} ({sec['label']})")
        out = llm.chat_json([{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}], model, SECTION_SCHEMA)
        out["section"] = i
        out["start"], out["end"] = sec["start"], sec["end"]
        out["units"] = sec.get("units", [])
        for lst in ("notions", "formules", "exemples", "ecarts_support", "questions"):
            for item in out.get(lst, []):
                item["t"] = parse_t(item.get("moment"), sec["start"])
        parts[str(i)] = {"_key": pk, "data": out}
        write_json(part_file, parts)
        results.append(out)
        ctx.progress((i + 1) / (len(sections) + 3) )
        ctx.check_cancel()

    # ---------------------------------------------------------------- reduce : cours entier
    ctx.log("Résumé global, plan et notions essentielles…")
    digest = []
    for r in results:
        digest.append(f"## Section {r['section'] + 1} — {r['titre']} ({fmt(r['start'])}–{fmt(r['end'])})\n{r['resume']}\n"
                      + "".join(f"- {p}\n" for p in r.get("points_cles", [])[:8])
                      + ("Notions : " + ", ".join(n["terme"] for n in r.get("notions", [])) + "\n" if r.get("notions") else ""))
    doc_titles = sorted({u.get("doc_name", "") for u in units if u.get("doc_name")})
    course_prompt = (
        "Voici l'analyse section par section d'un cours" + (f" (support : {', '.join(doc_titles)})" if doc_titles else "") + ".\n\n"
        + "\n".join(digest) + "\n\n"
        "Produis :\n- titre_cours : un titre précis pour l'ensemble du cours ;\n"
        "- resume_court : 5 à 8 lignes ;\n"
        "- resume_detaille : un résumé détaillé en Markdown (titres ##, paragraphes, listes), qui suit la progression du cours ;\n"
        "- plan : regroupe les sections (numéros à partir de 1) en grandes parties ordonnées, avec 2 à 6 sous-parties chacune ;\n"
        "- notions_essentielles : les 10 à 25 notions les plus importantes du cours.")
    course = llm.chat_json([{"role": "system", "content": SYSTEM}, {"role": "user", "content": course_prompt}], model, COURSE_SCHEMA,
                           num_ctx=max(llm.ctx_size(model), 24576))
    for p in course.get("plan", []):
        p["sections"] = [x - 1 for x in p.get("sections", []) if 1 <= x <= len(results)]
    ctx.progress((len(sections) + 1) / (len(sections) + 3))

    # ---------------------------------------------------------------- glossaire, formules, Q&R
    glossary: dict[str, dict] = {}
    for r in results:
        for n in r.get("notions", []):
            key_n = _norm(n["terme"])
            if not key_n:
                continue
            cur = glossary.get(key_n)
            if not cur or len(n["definition"]) > len(cur["definition"]):
                glossary[key_n] = {**n, "section": r["section"], "t": n.get("t") if not cur else min(cur["t"] or 1e9, n.get("t") or 1e9)}
    formulas = [{**f, "section": r["section"]} for r in results for f in r.get("formules", [])]
    examples = [{**e, "section": r["section"]} for r in results for e in r.get("exemples", [])]
    keep = [{"point": a, "section": r["section"], "t": r["start"]} for r in results for a in r.get("a_retenir", [])]
    all_q = [{**q, "section": r["section"]} for r in results for q in r.get("questions", [])]
    n_q = int(s.get("qa_count") or 20)
    if len(all_q) > n_q:
        step = len(all_q) / n_q
        all_q = [all_q[int(i * step)] for i in range(n_q)]

    # ---------------------------------------------------------------- croisement audio ↔ support
    cross = crossref(project, ctx, results, units, index, paras, glossary)

    # ---------------------------------------------------------------- synthèse finale
    ctx.log("Synthèse finale (audio + support)…")
    syn_prompt = (
        f"Cours : {course.get('titre_cours', '')}\n\nRÉSUMÉ DÉTAILLÉ :\n{course.get('resume_detaille', '')}\n\n"
        "NOTIONS ESSENTIELLES : " + ", ".join(course.get("notions_essentielles", [])) + "\n\n"
        "À RETENIR (souligné par l'enseignant) :\n" + "\n".join(f"- {k_['point']}" for k_ in keep[:40]) + "\n\n"
        "ÉCARTS ORAL / SUPPORT :\n" + "\n".join(f"- [{c['type']}] {c['detail']}" for c in cross["ecarts"][:40]) + "\n\n"
        "ÉLÉMENTS DU SUPPORT PEU OU PAS EXPLIQUÉS À L'ORAL :\n" + "\n".join(f"- {c['line']}" for c in cross["support_non_explique"][:30]) + "\n\n"
        "NOTIONS EXPLIQUÉES À L'ORAL ABSENTES DU SUPPORT :\n" + "\n".join(f"- {c['terme']}" for c in cross["oral_absent_support"][:30]) + "\n\n"
        "Rédige la SYNTHÈSE FINALE de révision en Markdown, fusionnant le cours oral et le support : "
        "## L'essentiel, ## Plan du cours, ## Notions et définitions clés, ## Formules et règles (si pertinent), "
        "## Ce que l'oral ajoute au support, ## Points du support à revoir, ## À retenir absolument. "
        "Sois complet mais dense, sans inventer.")
    synthesis = llm.chat([{"role": "system", "content": SYSTEM}, {"role": "user", "content": syn_prompt}], model,
                         temperature=0.3, num_ctx=max(llm.ctx_size(model), 24576))

    data = {
        "model": model, "course": course, "sections": results, "glossary": sorted(glossary.values(), key=lambda g: g.get("t") or 0),
        "formulas": formulas, "examples": examples, "keep": keep, "qa": all_q, "cross": cross, "synthesis": synthesis,
    }
    project.put("analyze", k, data)
    ctx.progress(1.0)
    return data


def crossref(project: Project, ctx, results: list[dict], units: list[dict], index: dict, paras: list[dict], glossary: dict) -> dict:
    """Croisement : écarts signalés par le LLM + couverture mesurée par similarité sémantique."""
    ecarts = []
    for r in results:
        for e in r.get("ecarts_support", []):
            ecarts.append({**e, "section": r["section"]})
    units_by_id = {u["id"]: u for u in units}
    # Lignes du support peu couvertes à l'oral.
    non_expl = []
    for c in index.get("coverage", []):
        if c["score"] < 0.48:
            u = units_by_id.get(c["unit"], {})
            non_expl.append({**c, "doc_name": u.get("doc_name", ""), "n": u.get("n"), "kind": u.get("kind")})
    non_expl.sort(key=lambda c: c["score"])
    # Notions orales absentes du support.
    oral_absent = []
    if units and glossary:
        from ..retrieval import open_index
        idx = open_index(project.index_dir)
        if idx is not None:
            doc_mask = np.array([c["kind"] == "doc" for c in idx.chunks])
            if doc_mask.any():
                terms = list(glossary.values())
                Q = retrieval.embed([f"{g['terme']} : {g['definition']}" for g in terms])
                S = Q @ idx.emb[doc_mask].T
                best = S.max(1)
                for g, sc in zip(terms, best):
                    if sc < 0.5:
                        oral_absent.append({**g, "score": round(float(sc), 3)})
            retrieval.release()
    return {
        "ecarts": ecarts,
        "support_non_explique": non_expl[:200],
        "oral_absent_support": oral_absent,
        "unit_times": index.get("unit_times", {}),
    }
