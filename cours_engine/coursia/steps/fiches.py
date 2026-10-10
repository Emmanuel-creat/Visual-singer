"""Fiches de révision : une fiche synthétique par chapitre + flashcards + tableau comparatif.

Structure identique pour toutes les fiches (hiérarchie visuelle constante) :
  en-tête : titre, objectif, 3 à 5 idées essentielles ;
  1. définitions et bases (définitions, chiffres et valeurs, classifications) ;
  2. mécanismes et raisonnement (étapes enchaînées) ;
  3. points critiques et exceptions (urgences, contre-indications, pièges, critères, seuils) ;
  4. auto-évaluation (5 à 10 questions) ;
plus des flashcards (une question précise, une réponse courte) et, si des notions proches
s'y prêtent, un tableau comparatif. Les chapitres sont les grandes parties du plan du cours ;
chaque fiche est mise en cache séparément (reprise après interruption).
"""
from __future__ import annotations

import hashlib
import re

from .. import llm, retrieval
from ..store import Project, cache_key, read_json, write_json
from .analyze import SYSTEM, fmt, parse_t
from .index import unit_text

VERSION = "fiches-v2"

_ITEM_T = {"moment": {"type": "string"}}
FICHE_SCHEMA = {
    "type": "object",
    "properties": {
        "titre": {"type": "string"},
        "objectif": {"type": "string"},
        "idees_essentielles": {"type": "array", "items": {"type": "string"}},
        "definitions": {"type": "array", "items": {"type": "object", "properties": {
            "terme": {"type": "string"}, "definition": {"type": "string"}, **_ITEM_T}, "required": ["terme", "definition", "moment"]}},
        "chiffres": {"type": "array", "items": {"type": "object", "properties": {
            "valeur": {"type": "string"}, "signification": {"type": "string"}, **_ITEM_T}, "required": ["valeur", "signification", "moment"]}},
        "classifications": {"type": "array", "items": {"type": "object", "properties": {
            "titre": {"type": "string"}, "elements": {"type": "array", "items": {"type": "string"}}}, "required": ["titre", "elements"]}},
        "mecanismes": {"type": "array", "items": {"type": "object", "properties": {
            "titre": {"type": "string"}, "etapes": {"type": "array", "items": {"type": "string"}}, **_ITEM_T},
            "required": ["titre", "etapes", "moment"]}},
        "points_critiques": {"type": "array", "items": {"type": "object", "properties": {
            "type": {"type": "string", "enum": ["urgence", "contre_indication", "piege", "exception", "critere", "seuil"]},
            "texte": {"type": "string"}, **_ITEM_T}, "required": ["type", "texte", "moment"]}},
        "a_ne_pas_oublier": {"type": "array", "items": {"type": "string"}},
        "comparatif": {"type": "object", "properties": {
            "titre": {"type": "string"}, "colonnes": {"type": "array", "items": {"type": "string"}},
            "lignes": {"type": "array", "items": {"type": "object", "properties": {
                "critere": {"type": "string"}, "valeurs": {"type": "array", "items": {"type": "string"}}},
                "required": ["critere", "valeurs"]}}},
            "required": ["titre", "colonnes", "lignes"]},
        "auto_evaluation": {"type": "array", "items": {"type": "object", "properties": {
            "question": {"type": "string"}, "reponse": {"type": "string"}, **_ITEM_T}, "required": ["question", "reponse", "moment"]}},
        "flashcards": {"type": "array", "items": {"type": "object", "properties": {
            "type": {"type": "string", "enum": ["definition", "critere", "liste", "classification", "distinction", "valeur", "mecanisme"]},
            "recto": {"type": "string"}, "verso": {"type": "string"}, **_ITEM_T}, "required": ["type", "recto", "verso", "moment"]}},
    },
    "required": ["titre", "objectif", "idees_essentielles", "definitions", "chiffres", "classifications", "mecanismes",
                 "points_critiques", "a_ne_pas_oublier", "comparatif", "auto_evaluation", "flashcards"],
}

RULES = (
    "Rédige la FICHE DE RÉVISION de ce chapitre en remplissant le JSON. Règles :\n"
    "- objectif : une phrase, ce que l'étudiant doit savoir faire après ce chapitre ;\n"
    "- idees_essentielles : 3 à 5 idées, une phrase courte chacune ;\n"
    "- definitions : définitions courtes (une à deux phrases) des notions fondamentales, sans déformer le cours ;\n"
    "- chiffres : valeurs numériques, seuils, doses, pourcentages, dates, exactement comme dans le cours, avec leur signification ;\n"
    "- classifications : classifications, stades, types, listes à connaître (éléments courts) ;\n"
    "- mecanismes : raisonnements, physiopathologie, enchaînements causaux, démarches ; chaque étape est courte et suit la précédente ;\n"
    "- points_critiques : urgences, contre-indications, pièges, exceptions, critères essentiels, valeurs seuils ; une idée par élément ;\n"
    "- a_ne_pas_oublier : au plus 2 éléments, uniquement l'erreur classique ou l'exception majeure à ne surtout pas oublier (sinon liste vide) ;\n"
    "- comparatif : remplis-le dès que le chapitre oppose au moins deux éléments de même nature (deux types de lésion ou de fracture, "
    "deux pathologies, deux traitements, deux techniques, deux matériaux, deux populations comme sujet jeune et sujet âgé…) ; "
    "colonnes = les 2 à 4 éléments comparés (noms courts), lignes = 3 à 7 critères discriminants (localisation, mécanisme, risque, "
    "traitement, pronostic…), valeurs = une courte expression par colonne, dans l'ordre des colonnes ; "
    "laisse le titre vide et les listes vides seulement si le chapitre n'oppose vraiment rien ;\n"
    "- auto_evaluation : 5 à 10 questions de rappel actif couvrant le chapitre, réponse courte et exacte ;\n"
    "- titre : le nom du chapitre seul, sans « Fiche de révision » ;\n"
    "- flashcards : 6 à 15 cartes, une question précise par carte (critère, liste, classification, distinction difficile, valeur, définition), "
    "le recto formulé comme une vraie question terminée par « ? », "
    "réponse courte au verso ;\n"
    "- « moment » reprend un marqueur [mm:ss] de la transcription quand l'information y est dite, sinon chaîne vide.\n"
    "Une idée par élément, phrases courtes mais précises, aucun ajout extérieur au cours, valeurs et références exactes conservées. "
    "Ne condense pas à l'excès : mieux vaut une fiche de deux pages complète qu'une page illisible. Liste vide quand une rubrique ne s'applique pas."
)


def chapters(analysis: dict) -> list[dict]:
    """Grandes parties du plan (sinon une par section)."""
    secs = analysis.get("sections") or []
    out = []
    for p in (analysis.get("course") or {}).get("plan") or []:
        ids = [i for i in p.get("sections", []) if 0 <= i < len(secs)]
        if ids:
            out.append({"titre": p.get("titre") or secs[ids[0]]["titre"], "sections": ids, "sous_parties": p.get("sous_parties") or []})
    covered = {i for c in out for i in c["sections"]}
    for i, s in enumerate(secs):           # sections oubliées par le plan
        if i not in covered:
            out.append({"titre": s["titre"], "sections": [i], "sous_parties": []})
    out.sort(key=lambda c: min(c["sections"]))
    return out


def chapter_prompt(chap: dict, analysis: dict, paras: list[dict], units_by_id: dict) -> str:
    secs = analysis["sections"]
    parts = [f"CHAPITRE : {chap['titre']}"]
    if chap["sous_parties"]:
        parts.append("Sous-parties : " + " ; ".join(chap["sous_parties"]))
    unit_ids, para_ids = [], []
    for i in chap["sections"]:
        r = secs[i]
        parts += ["", f"## Section {i + 1} : {r['titre']} ({fmt(r['start'])} à {fmt(r['end'])})", r.get("resume", "")]
        for label, key, f in (("Points clés", "points_cles", str), ("À retenir", "a_retenir", str),
                              ("Notions", "notions", lambda n: f"{n['terme']} : {n['definition']}"),
                              ("Formules et règles", "formules", lambda x: f"{x['formule']} : {x['explication']}"),
                              ("Exemples", "exemples", lambda x: x["exemple"])):
            items = r.get(key) or []
            if items:
                parts.append(f"{label} :\n" + "\n".join(f"- {f(x)}" for x in items))
        unit_ids += [u for u in r.get("units", []) if u not in unit_ids]
    # Transcription du chapitre (valeurs exactes, formulations de l'enseignant).
    start, end = secs[chap["sections"][0]]["start"], secs[chap["sections"][-1]]["end"]
    lines = [f"[{fmt(p['start'])}] {p['text']}" for p in paras if p["start"] >= start - 1 and p["end"] <= end + 1]
    transcript = "\n".join(lines)
    if len(transcript) > 16000:
        transcript = transcript[:16000] + "\n[…]"
    parts += ["", "TRANSCRIPTION DU CHAPITRE :", transcript]
    support = []
    for uid in unit_ids[:10]:
        u = units_by_id.get(uid)
        if u:
            label = "Diapositive" if u["kind"] == "slide" else "Page" if u["kind"] == "page" else "Section"
            support.append(f"[{label} {u['n']}]\n{unit_text(u)[:1200]}")
    if support:
        parts += ["", "SUPPORT DE COURS DU CHAPITRE :", "\n\n".join(support)]
    parts += ["", RULES]
    return "\n".join(parts)


def key(project: Project) -> str:
    s = project.settings()
    return cache_key(VERSION, project.key_of("analyze"), s.get("llm_profile"))


def run(project: Project, ctx, paragraphs: dict, documents: dict, analysis: dict) -> dict:
    k = key(project)
    cached = project.cached("fiches", k)
    if cached is not None:
        return cached
    s = project.settings()
    model = llm.pick_model(s.get("llm_profile", "quality"))
    retrieval.release()
    paras = paragraphs["paragraphs"]
    units_by_id = {u["id"]: u for u in documents.get("units") or []}
    chaps = chapters(analysis)
    ctx.log(f"Fiches de révision : {len(chaps)} chapitre(s) avec {model}…")

    part_file = project.cache / "fiches.parts.json"
    parts = read_json(part_file, {}) or {}
    fiches = []
    for i, chap in enumerate(chaps):
        prompt = chapter_prompt(chap, analysis, paras, units_by_id)
        pk = cache_key(model, prompt)
        if parts.get(str(i), {}).get("_key") == pk:
            fiches.append(parts[str(i)]["data"])
            continue
        ctx.log(f"Fiche {i + 1}/{len(chaps)} : {chap['titre']}")
        f = llm.chat_json([{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}], model, FICHE_SCHEMA,
                          num_ctx=max(llm.ctx_size(model), 24576))
        secs = analysis["sections"]
        t0 = secs[chap["sections"][0]]["start"]
        f.update(id=i, sections=chap["sections"], start=t0, end=secs[chap["sections"][-1]]["end"],
                 units=[u for j in chap["sections"] for u in secs[j].get("units", [])][:12])
        titre = re.sub(r"^\s*fiche(\s+de\s+r[ée]vision)?\s*[:\-]\s*", "", f.get("titre") or "", flags=re.I).strip()
        titre = re.sub(r"^\s*chapitre\s+[IVXLC\d]+\s*[:.\-]\s*", "", titre, flags=re.I).strip()
        titre = re.sub(r"^\s*(?:[IVXLC]+|\d+)\s*[.)]\s+", "", titre).strip()
        f["titre"] = titre or chap["titre"]
        f["idees_essentielles"] = (f.get("idees_essentielles") or [])[:5]
        f["a_ne_pas_oublier"] = (f.get("a_ne_pas_oublier") or [])[:2]
        f["auto_evaluation"] = (f.get("auto_evaluation") or [])[:10]
        comp = f.get("comparatif") or {}
        if len(comp.get("colonnes") or []) < 2 or not comp.get("lignes"):
            f["comparatif"] = None
        for lst in ("definitions", "chiffres", "mecanismes", "points_critiques", "auto_evaluation", "flashcards"):
            for item in f.get(lst) or []:
                item["t"] = parse_t(item.get("moment"), None)
        for c in f.get("flashcards") or []:
            c["id"] = hashlib.sha1(f"{c.get('recto', '')}|{c.get('verso', '')}".encode()).hexdigest()[:12]
        parts[str(i)] = {"_key": pk, "data": f}
        write_json(part_file, parts)
        fiches.append(f)
        ctx.progress((i + 1) / len(chaps))
        ctx.check_cancel()

    data = {"model": model, "fiches": fiches}
    project.put("fiches", k, data)
    ctx.progress(1.0)
    return data
