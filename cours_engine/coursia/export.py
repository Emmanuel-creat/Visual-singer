"""Exports : Markdown complet, Word (.docx) et PDF (via LibreOffice si installé)."""
from __future__ import annotations

import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from .steps.analyze import fmt
from .steps.documents import soffice
from .store import Project


def build_markdown(project: Project, with_transcript: bool = True) -> str:
    meta = project.meta()
    a = project.result("analyze") or {}
    course = a.get("course", {})
    paras = (project.result("paragraphs") or {}).get("paragraphs", [])
    speakers = (project.result("paragraphs") or {}).get("speakers", [])
    out = [f"# {course.get('titre_cours') or meta.get('title', 'Cours')}", ""]
    if course.get("resume_court"):
        out += ["## Résumé court", "", course["resume_court"], ""]
    if a.get("synthesis"):
        out += ["# Synthèse finale (audio + support)", "", a["synthesis"].strip(), ""]
    if course.get("plan"):
        out += ["## Plan du cours", ""]
        secs = a.get("sections", [])
        for i, p in enumerate(course["plan"], 1):
            t0 = min((secs[s]["start"] for s in p.get("sections", []) if s < len(secs)), default=None)
            out.append(f"{i}. **{p['titre']}**" + (f" ({fmt(t0)})" if t0 is not None else ""))
            for sp in p.get("sous_parties", []):
                out.append(f"   - {sp}")
        out.append("")
    if course.get("resume_detaille"):
        out += ["## Résumé détaillé", "", course["resume_detaille"].strip(), ""]
    if a.get("glossary"):
        out += ["## Notions et définitions", ""]
        out += [f"- **{g['terme']}** ({fmt(g.get('t') or 0)}) : {g['definition']}" for g in a["glossary"]]
        out.append("")
    if a.get("formulas"):
        out += ["## Formules et règles", ""]
        out += [f"- `{f['formule']}` — {f['explication']} ({fmt(f.get('t') or 0)})" for f in a["formulas"]]
        out.append("")
    if a.get("examples"):
        out += ["## Exemples", ""] + [f"- {e['exemple']} ({fmt(e.get('t') or 0)})" for e in a["examples"]] + [""]
    if a.get("keep"):
        out += ["## À retenir", ""] + [f"- {k['point']}" for k in a["keep"]] + [""]
    cross = a.get("cross") or {}
    if cross.get("ecarts") or cross.get("support_non_explique") or cross.get("oral_absent_support"):
        out += ["## Croisement oral / support", ""]
        labels = {"contradiction": "Contradiction", "difference": "Différence", "ajout_oral": "Ajout à l'oral", "non_explique": "Non expliqué"}
        for e in cross.get("ecarts", []):
            out.append(f"- **{labels.get(e['type'], e['type'])}** ({fmt(e.get('t') or 0)}"
                       + (f", diapositive {e['diapositive']}" if e.get("diapositive") else "") + f") : {e['detail']}")
        if cross.get("oral_absent_support"):
            out += ["", "### Notions expliquées à l'oral, absentes du support", ""]
            out += [f"- {g['terme']} ({fmt(g.get('t') or 0)})" for g in cross["oral_absent_support"]]
        if cross.get("support_non_explique"):
            out += ["", "### Éléments du support peu ou pas expliqués à l'oral", ""]
            out += [f"- {c['line']} ({c.get('doc_name', '')}, {c.get('kind', 'page')} {c.get('n')})" for c in cross["support_non_explique"][:60]]
        out.append("")
    if a.get("qa"):
        out += ["## Questions de révision", ""]
        for i, q in enumerate(a["qa"], 1):
            out += [f"**{i}. {q['question']}**", "", f"> {q['reponse']}", ""]
    if a.get("sections"):
        out += ["## Détail par section", ""]
        for r in a["sections"]:
            out += [f"### {r['section'] + 1}. {r['titre']} ({fmt(r['start'])} – {fmt(r['end'])})", "", r["resume"], ""]
            out += [f"- {p}" for p in r.get("points_cles", [])] + [""]
    if with_transcript and paras:
        out += ["## Transcription", ""]
        for p in paras:
            spk = f"**{speakers[p['speaker']]}** " if len(speakers) > 1 else ""
            out += [f"[{fmt(p['start'])}] {spk}{p['text']}", ""]
    return "\n".join(out)


def _add_runs(par, text: str) -> None:
    """Gras **…** et code `…` minimalistes."""
    for tok in re.split(r"(\*\*[^*]+\*\*|`[^`]+`)", text):
        if not tok:
            continue
        if tok.startswith("**") and tok.endswith("**"):
            par.add_run(tok[2:-2]).bold = True
        elif tok.startswith("`") and tok.endswith("`"):
            r = par.add_run(tok[1:-1])
            r.font.name = "Consolas"
        else:
            par.add_run(tok)


def markdown_to_docx(md: str, path: Path) -> None:
    import docx
    from docx.shared import Pt
    d = docx.Document()
    d.styles["Normal"].font.name = "Calibri"
    d.styles["Normal"].font.size = Pt(11)
    for line in md.splitlines():
        s = line.rstrip()
        if not s:
            continue
        m = re.match(r"^(#{1,4})\s+(.*)", s)
        if m:
            d.add_heading(m.group(2), level=min(4, len(m.group(1))))
        elif re.match(r"^\s*[-*]\s+", s):
            indent = (len(s) - len(s.lstrip())) // 2
            p = d.add_paragraph(style="List Bullet" if indent == 0 else "List Bullet 2")
            _add_runs(p, re.sub(r"^\s*[-*]\s+", "", s))
        elif re.match(r"^\s*\d+\.\s+", s):
            p = d.add_paragraph(style="List Number")
            _add_runs(p, re.sub(r"^\s*\d+\.\s+", "", s))
        elif s.startswith(">"):
            p = d.add_paragraph(style="Intense Quote")
            _add_runs(p, s.lstrip("> "))
        else:
            _add_runs(d.add_paragraph(), s)
    d.save(str(path))


def export(project: Project, fmt_: str, with_transcript: bool = True) -> Path:
    md = build_markdown(project, with_transcript)
    title = re.sub(r"[^\w\- ]+", "", project.meta().get("title", "cours")).strip().replace(" ", "_")[:60] or "cours"
    project.exports.mkdir(exist_ok=True)
    if fmt_ == "md":
        p = project.exports / f"{title}.md"
        p.write_text(md, encoding="utf-8")
        return p
    docx_path = project.exports / f"{title}.docx"
    markdown_to_docx(md, docx_path)
    if fmt_ == "docx":
        return docx_path
    if fmt_ == "pdf":
        exe = soffice()
        if not exe:
            raise RuntimeError("L'export PDF nécessite LibreOffice (export Word disponible).")
        tmp = Path(tempfile.mkdtemp(prefix="coursia-pdf-"))
        subprocess.run([exe, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", str(tmp), str(docx_path)],
                       capture_output=True, timeout=600)
        pdfs = list(tmp.glob("*.pdf"))
        if not pdfs:
            raise RuntimeError("La conversion PDF a échoué")
        out = project.exports / f"{title}.pdf"
        shutil.move(str(pdfs[0]), out)
        shutil.rmtree(tmp, ignore_errors=True)
        return out
    raise ValueError(fmt_)
