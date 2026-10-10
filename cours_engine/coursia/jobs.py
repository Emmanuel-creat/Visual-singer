"""File de traitements : un seul travail lourd à la fois (le GPU est partagé),
progression par étape, journal, annulation et reprise automatique au redémarrage.

Ordre du pipeline :
  audio → documents → transcription → intervenants → paragraphes → index
  (sections + rapprochement + couverture) → analyse LLM (sections, cours, croisement, synthèse)

Chaque étape a une clé de cache dérivée de ses entrées et paramètres : si rien n'a
changé, elle est sautée. La transcription et l'analyse enregistrent aussi des
points de reprise internes (tranche par tranche, section par section).
"""
from __future__ import annotations

import queue
import threading
import time
import traceback
from collections import deque

from . import llm
from .hardware import free_gpu
from .store import Project, list_projects

STEPS = [
    ("audio", "Extraction audio"),
    ("documents", "Lecture du support"),
    ("transcribe", "Transcription"),
    ("diarize", "Intervenants"),
    ("paragraphs", "Paragraphes"),
    ("index", "Indexation & rapprochement"),
    ("analyze", "Analyse & synthèse"),
    ("fiches", "Fiches de révision"),
]
STEP_IDS = [s for s, _ in STEPS]


class Cancelled(Exception):
    pass


class StepCtx:
    """Passé à chaque étape : progression, journal, annulation."""

    def __init__(self, runner: "Runner", project: Project, step: str, lo: float = 0.0, hi: float = 1.0):
        self.r, self.p, self.step, self.lo, self.hi = runner, project, step, lo, hi

    def progress(self, x: float) -> None:
        val = self.lo + (self.hi - self.lo) * max(0.0, min(1.0, x))
        now = time.time()
        if now - self.r.last_progress_write > 0.7 or val >= 0.999:
            self.r.last_progress_write = now
            self.p.set_step(self.step, progress=round(val, 4))
        self.r.current_progress = val

    def log(self, msg: str) -> None:
        self.r.log(self.p.id, f"[{dict(STEPS).get(self.step, self.step)}] {msg}")

    def sub(self, lo: float, hi: float) -> "StepCtx":
        return StepCtx(self.r, self.p, self.step, self.lo + (self.hi - self.lo) * lo, self.lo + (self.hi - self.lo) * hi)

    def check_cancel(self) -> None:
        if self.r.cancel_flag.is_set():
            raise Cancelled()


class Runner:
    def __init__(self):
        self.q: "queue.Queue[str]" = queue.Queue()
        self.pending: list[str] = []
        self.current: str | None = None
        self.current_step: str | None = None
        self.current_progress = 0.0
        self.last_progress_write = 0.0
        self.cancel_flag = threading.Event()
        self.logs: dict[str, deque] = {}
        self.listeners: list = []
        self._thread = threading.Thread(target=self._loop, daemon=True, name="coursia-runner")
        self._thread.start()

    # -------------------------------------------------------------- API
    def enqueue(self, pid: str) -> None:
        if pid == self.current or pid in self.pending:
            return
        self.pending.append(pid)
        Project(pid).set_step("_job", status="queued")
        self.q.put(pid)

    def cancel(self, pid: str) -> None:
        if pid == self.current:
            self.cancel_flag.set()
        elif pid in self.pending:
            self.pending.remove(pid)
            Project(pid).set_step("_job", status="cancelled")

    def log(self, pid: str, msg: str) -> None:
        line = f"{time.strftime('%H:%M:%S')} {msg}"
        self.logs.setdefault(pid, deque(maxlen=400)).append(line)
        print(f"[{pid[:24]}] {msg}", flush=True)
        try:
            with open(Project(pid).dir / "job.log", "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:
            pass

    def resume_interrupted(self) -> None:
        """Au démarrage : relance les traitements interrompus (arrêt, plantage, coupure)."""
        for m in list_projects():
            job = (m.get("state") or {}).get("_job", {})
            if job.get("status") in ("running", "queued"):
                self.log(m["id"], "Reprise du traitement interrompu")
                self.enqueue(m["id"])

    def status(self) -> dict:
        return {"current": self.current, "step": self.current_step, "progress": self.current_progress, "pending": list(self.pending)}

    # -------------------------------------------------------------- boucle
    def _loop(self) -> None:
        while True:
            pid = self.q.get()
            if pid not in self.pending:
                continue
            self.pending.remove(pid)
            self.current = pid
            self.cancel_flag.clear()
            try:
                self._run_pipeline(Project(pid))
            except Exception:
                traceback.print_exc()
            finally:
                self.current = None
                self.current_step = None
                free_gpu()

    def _run_pipeline(self, p: Project) -> None:
        from .steps import analyze, audio, diarize, documents, fiches, index, paragraphs, transcribe
        p.set_step("_job", status="running", started=time.time(), error=None)
        self.log(p.id, "Début du traitement")
        res: dict = {}
        try:
            for step, label in STEPS:
                self.current_step = step
                self.current_progress = 0.0
                ctx = StepCtx(self, p, step)
                meta = p.meta()
                if step == "documents" and not meta.get("docs"):
                    res["documents"] = {"units": [], "vocabulary": []}
                    p.set_step(step, status="skipped", progress=1.0)
                    continue
                if step == "fiches" and not res.get("analyze"):
                    p.set_step(step, status="skipped", progress=1.0)
                    continue
                if step in ("analyze", "fiches") and not llm.models_available():
                    p.set_step(step, status="error", error="Ollama ne répond pas (lancez Ollama puis relancez l'analyse)")
                    self.log(p.id, "Analyse LLM impossible : Ollama ne répond pas")
                    continue
                p.set_step(step, status="running", progress=0.0, started=time.time(), error=None)
                if step in ("transcribe", "diarize", "index", "documents"):
                    llm.unload_all()          # libère la VRAM occupée par un LLM resté chargé
                t0 = time.time()
                if step == "audio":
                    res["audio"] = audio.run(p, ctx)
                elif step == "documents":
                    res["documents"] = documents.run(p, ctx)
                elif step == "transcribe":
                    res["transcribe"] = transcribe.run(p, ctx, res["documents"].get("vocabulary", []))
                    transcribe.unload()
                elif step == "diarize":
                    res["diarize"] = diarize.run(p, ctx, res["transcribe"])
                elif step == "paragraphs":
                    res["paragraphs"] = paragraphs.run(p, ctx, res["transcribe"], res["diarize"])
                elif step == "index":
                    res["index"] = index.run(p, ctx, res["paragraphs"], res["documents"], res["audio"]["duration"], res["transcribe"])
                elif step == "analyze":
                    res["analyze"] = analyze.run(p, ctx, res["paragraphs"], res["documents"], res["index"])
                elif step == "fiches":
                    res["fiches"] = fiches.run(p, ctx, res["paragraphs"], res["documents"], res["analyze"])
                p.set_step(step, status="done", progress=1.0, seconds=round(time.time() - t0, 1), key=p.key_of(step))
                free_gpu()
            p.set_step("_job", status="done", finished=time.time())
            self.log(p.id, "Traitement terminé")
        except Cancelled:
            p.set_step(self.current_step or "_job", status="cancelled")
            p.set_step("_job", status="cancelled")
            self.log(p.id, "Traitement annulé (reprise possible)")
        except Exception as e:
            traceback.print_exc()
            p.set_step(self.current_step or "_job", status="error", error=str(e))
            p.set_step("_job", status="error", error=f"{dict(STEPS).get(self.current_step, '')} : {e}")
            self.log(p.id, f"Erreur : {e}")


runner: Runner | None = None


def get_runner() -> Runner:
    global runner
    if runner is None:
        runner = Runner()
    return runner
