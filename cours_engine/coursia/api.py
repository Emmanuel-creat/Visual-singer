"""API HTTP locale (FastAPI) — écoute uniquement sur 127.0.0.1.

Sert aussi les pages de Visual Singer : http://127.0.0.1:8091/cours.html
"""
from __future__ import annotations

import json
import shutil
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, llm, retrieval
from .config import APP_ROOT, DATA_DIR
from .hardware import detect, recommend
from .jobs import STEP_IDS, STEPS, get_runner
from .steps.analyze import fmt
from .steps.documents import soffice
from .store import Project, create_project, delete_project, file_fingerprint, list_projects

app = FastAPI(title="Visual Singer — Cours", version=__version__)
app.add_middleware(GZipMiddleware, minimum_size=2048)
app.add_middleware(CORSMiddleware, allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?", allow_methods=["*"], allow_headers=["*"])

MEDIA_EXT = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".webm", ".mp4", ".m4v", ".mkv", ".mov", ".avi", ".wmv", ".mpg", ".mpeg", ".ts"}
DOC_EXT = {".pdf", ".pptx", ".ppsx", ".pptm", ".ppt", ".odp", ".docx", ".doc", ".odt", ".txt", ".md", ".key"}


def _project(pid: str) -> Project:
    try:
        return Project(pid)
    except FileNotFoundError:
        raise HTTPException(404, "Cours introuvable")


@app.on_event("startup")
def _startup() -> None:
    get_runner().resume_interrupted()


# ------------------------------------------------------------------ système
@app.get("/api/system")
def system():
    hw = detect()
    return {"version": __version__, "hardware": hw.as_dict(), "recommend": recommend(), "llm": llm.status(),
            "libreoffice": bool(soffice()), "data_dir": str(DATA_DIR), "runner": get_runner().status(),
            "steps": [{"id": s, "label": l} for s, l in STEPS]}


# ------------------------------------------------------------------ projets
@app.get("/api/projects")
def projects():
    out = []
    for m in list_projects():
        out.append({k: m.get(k) for k in ("id", "title", "created", "updated", "media", "docs", "settings", "state", "course_title")})
    return out


@app.post("/api/projects")
async def new_project(req: Request):
    body = await req.json()
    p = create_project((body.get("title") or "Nouveau cours").strip()[:120])
    return p.meta()


@app.get("/api/projects/{pid}")
def project(pid: str):
    p = _project(pid)
    r = get_runner()
    return {**p.meta(), "state": p.state(), "logs": list(r.logs.get(pid, []))[-200:] or _file_logs(p),
            "running": r.current == pid, "queued": pid in r.pending}


def _file_logs(p: Project) -> list[str]:
    f = p.dir / "job.log"
    return f.read_text(encoding="utf-8", errors="replace").splitlines()[-200:] if f.exists() else []


@app.patch("/api/projects/{pid}")
async def update_project(pid: str, req: Request):
    p = _project(pid)
    body = await req.json()
    meta = p.meta()
    if "title" in body:
        meta["title"] = str(body["title"])[:120]
    if "settings" in body and isinstance(body["settings"], dict):
        meta["settings"] = {**(meta.get("settings") or {}), **body["settings"]}
    if "speaker_names" in body and isinstance(body["speaker_names"], list):
        meta["speaker_names"] = [str(x)[:60] for x in body["speaker_names"]]
    p.save_meta(meta)
    return meta


@app.delete("/api/projects/{pid}")
def remove_project(pid: str):
    _project(pid)
    get_runner().cancel(pid)
    delete_project(pid)
    return {"ok": True}


async def _save_upload(f: UploadFile, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with open(tmp, "wb") as out:
        while chunk := await f.read(8 << 20):
            out.write(chunk)
    tmp.replace(dest)


def _safe_name(name: str) -> str:
    name = Path(name).name
    return "".join(c for c in name if c.isalnum() or c in " ._-()[]àâäéèêëîïôöùûüçÀÂÄÉÈÊËÎÏÔÖÙÛÜÇ").strip() or f"fichier-{uuid.uuid4().hex[:6]}"


@app.post("/api/projects/{pid}/media")
async def upload_media(pid: str, file: UploadFile = File(...)):
    p = _project(pid)
    ext = Path(file.filename or "").suffix.lower()
    if ext not in MEDIA_EXT:
        raise HTTPException(400, f"Format audio/vidéo non pris en charge : {ext}")
    name = _safe_name(file.filename)
    dest = p.originals / name
    await _save_upload(file, dest)
    meta = p.meta()
    old = meta.get("media")
    if old and old["file"] != name:
        (p.originals / old["file"]).unlink(missing_ok=True)
    meta["media"] = {"file": name, "name": file.filename, "size": dest.stat().st_size, "fingerprint": file_fingerprint(dest), "added": time.time()}
    p.save_meta(meta)
    return meta["media"]


@app.post("/api/projects/{pid}/docs")
async def upload_docs(pid: str, files: list[UploadFile] = File(...)):
    p = _project(pid)
    meta = p.meta()
    added = []
    for f in files:
        ext = Path(f.filename or "").suffix.lower()
        if ext not in DOC_EXT:
            raise HTTPException(400, f"Format de document non pris en charge : {ext}")
        did = f"d{uuid.uuid4().hex[:6]}"
        name = f"{did}_{_safe_name(f.filename)}"
        dest = p.originals / name
        await _save_upload(f, dest)
        d = {"id": did, "file": name, "name": f.filename, "size": dest.stat().st_size, "fingerprint": file_fingerprint(dest), "added": time.time()}
        meta.setdefault("docs", []).append(d)
        added.append(d)
    p.save_meta(meta)
    return added


@app.delete("/api/projects/{pid}/docs/{did}")
def remove_doc(pid: str, did: str):
    p = _project(pid)
    meta = p.meta()
    docs = meta.get("docs") or []
    keep = [d for d in docs if d["id"] != did]
    for d in docs:
        if d["id"] == did:
            (p.originals / d["file"]).unlink(missing_ok=True)
            shutil.rmtree(p.docs_dir / did, ignore_errors=True)
    meta["docs"] = keep
    p.save_meta(meta)
    return {"ok": True}


# ------------------------------------------------------------------ traitement
@app.post("/api/projects/{pid}/process")
def process(pid: str):
    _project(pid)
    get_runner().enqueue(pid)
    return {"ok": True}


@app.post("/api/projects/{pid}/cancel")
def cancel(pid: str):
    get_runner().cancel(pid)
    return {"ok": True}


@app.post("/api/projects/{pid}/reset")
async def reset(pid: str, req: Request):
    """Force le recalcul à partir d'une étape (les fichiers d'origine ne sont jamais touchés)."""
    p = _project(pid)
    body = await req.json()
    start = body.get("from", "audio")
    if start not in STEP_IDS:
        raise HTTPException(400, "Étape inconnue")
    for s in STEP_IDS[STEP_IDS.index(start):]:
        (p.cache / f"{s}.json").unlink(missing_ok=True)
        if s == "analyze":
            (p.cache / "analyze.sections.json").unlink(missing_ok=True)
        if s == "transcribe":
            (p.cache / "transcribe.partial.jsonl").unlink(missing_ok=True)
        p.set_step(s, status="pending", progress=0)
    return {"ok": True}


# ------------------------------------------------------------------ résultats
@app.get("/api/projects/{pid}/data")
def data(pid: str, words: bool = False):
    p = _project(pid)
    meta = p.meta()
    tr = p.result("transcribe") or {}
    segs = tr.get("segments", [])
    if not words:
        segs = [{k: v for k, v in s.items() if k != "words"} for s in segs]
    docs = p.result("documents") or {}
    speakers = (p.result("paragraphs") or {}).get("speakers") or []
    names = meta.get("speaker_names") or []
    speakers = [names[i] if i < len(names) and names[i] else s for i, s in enumerate(speakers)]
    return {
        "meta": meta, "state": p.state(),
        "audio": p.result("audio"),
        "transcript": {"language": tr.get("language"), "model": tr.get("model"), "segments": segs},
        "paragraphs": (p.result("paragraphs") or {}).get("paragraphs", []),
        "speakers": speakers,
        "units": docs.get("units", []), "vocabulary": docs.get("vocabulary", []),
        "index": p.result("index"),
        "analysis": p.result("analyze"),
    }


@app.get("/api/projects/{pid}/words")
def words(pid: str, start: float = 0, end: float = 1e9):
    tr = _project(pid).result("transcribe") or {}
    return [{"id": s["id"], "words": s.get("words", [])} for s in tr.get("segments", []) if s["end"] >= start and s["start"] <= end]


@app.get("/api/projects/{pid}/file/{path:path}")
def file(pid: str, path: str):
    p = _project(pid)
    target = (p.dir / path).resolve()
    if p.dir.resolve() not in target.parents or not target.is_file():
        raise HTTPException(404)
    return FileResponse(target)          # gère les requêtes partielles (Range) pour la lecture


@app.get("/api/projects/{pid}/search")
def search(pid: str, q: str, k: int = 12, kind: str = "all", rerank: bool = True):
    p = _project(pid)
    idx = retrieval.open_index(p.index_dir)
    if idx is None:
        raise HTTPException(409, "Index pas encore construit")
    kinds = None if kind == "all" else (kind,)
    res = idx.search(q, k=k, kinds=kinds, use_rerank=rerank)
    return [{k_: v for k_, v in r.items()} for r in res]


# ------------------------------------------------------------------ chat (RAG)
CHAT_SYSTEM = (
    "Tu es un tuteur qui répond aux questions sur un cours, uniquement à partir des SOURCES fournies "
    "(extraits de la transcription et du support). Réponds en français, de façon claire et structurée. "
    "Cite tes sources avec leurs étiquettes entre crochets, par exemple [S2] ou [S1][S4], juste après l'information. "
    "Si les sources ne permettent pas de répondre, dis-le explicitement plutôt que d'inventer."
)


@app.post("/api/projects/{pid}/chat")
async def chat(pid: str, req: Request):
    p = _project(pid)
    body = await req.json()
    question = (body.get("question") or "").strip()
    history = body.get("history") or []
    if not question:
        raise HTTPException(400, "Question vide")
    idx = retrieval.open_index(p.index_dir)
    if idx is None:
        raise HTTPException(409, "Le cours n'est pas encore indexé")
    hits = idx.search(question, k=8, use_rerank=True)
    sources, blocks = [], []
    for i, h in enumerate(hits, 1):
        tag = f"S{i}"
        if h["kind"] == "audio":
            label = f"Transcription {fmt(h['start'])}–{fmt(h['end'])}" + (f" ({h['speaker']})" if h.get("speaker") else "")
        else:
            kind = {"slide": "Diapositive", "page": "Page"}.get(h.get("unit_kind"), "Section")
            label = f"{kind} {h['n']} — {h.get('title', '')[:60]} ({h.get('doc_name', '')})"
        sources.append({"tag": tag, "label": label, **{k: h.get(k) for k in ("kind", "start", "end", "unit", "n", "doc", "image", "para", "title")}})
        blocks.append(f"[{tag}] {label}\n{h['text'][:1600]}")
    a = p.result("analyze") or {}
    summary = (a.get("course") or {}).get("resume_court", "")
    model = llm.pick_model(p.settings().get("llm_profile", "quality"))
    msgs = [{"role": "system", "content": CHAT_SYSTEM}]
    for h in history[-6:]:
        if h.get("role") in ("user", "assistant") and h.get("content"):
            msgs.append({"role": h["role"], "content": str(h["content"])[:4000]})
    msgs.append({"role": "user", "content": (f"RÉSUMÉ DU COURS : {summary}\n\n" if summary else "") + "SOURCES :\n\n" + "\n\n".join(blocks)
                 + f"\n\nQUESTION : {question}"})

    def gen():
        yield f"event: sources\ndata: {json.dumps(sources, ensure_ascii=False)}\n\n"
        try:
            for piece in llm.stream(msgs, model):
                yield f"data: {json.dumps(piece, ensure_ascii=False)}\n\n"
        except Exception as e:
            yield f"event: error\ndata: {json.dumps(str(e), ensure_ascii=False)}\n\n"
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ------------------------------------------------------------------ export
@app.post("/api/projects/{pid}/export")
async def export(pid: str, req: Request):
    from .export import export as do_export
    p = _project(pid)
    body = await req.json()
    fmt_ = body.get("format", "md")
    if fmt_ not in ("md", "docx", "pdf"):
        raise HTTPException(400, "Format inconnu")
    try:
        path = do_export(p, fmt_, bool(body.get("transcript", True)))
    except Exception as e:
        raise HTTPException(500, str(e))
    return FileResponse(path, filename=path.name)


# Pages de Visual Singer (cours.html, sommeil.html, index.html…).
app.mount("/", StaticFiles(directory=str(APP_ROOT), html=True), name="app")
