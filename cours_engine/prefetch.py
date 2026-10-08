"""Télécharge une fois tous les modèles (ensuite l'application fonctionne hors ligne).

    .venv\\Scripts\\python prefetch.py
"""
import sys

for s in (sys.stdout, sys.stderr):
    try:
        s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from coursia.config import ASR_MODELS, EMBED_MODEL, MODELS_DIR, RERANK_MODEL  # noqa: E402


def step(label, fn):
    print(f"→ {label}…", flush=True)
    fn()
    print(f"  ✓ {label}", flush=True)


def whisper_fr():
    from coursia.steps.transcribe import _model_path
    _model_path(ASR_MODELS["fr"])


def whisper_multi():
    from faster_whisper.utils import download_model
    download_model(ASR_MODELS["multi"], cache_dir=str(MODELS_DIR / "whisper"))


def embed():
    from coursia import retrieval
    retrieval.embedder()
    retrieval.reranker()
    retrieval.release()


def speaker():
    from coursia.steps import diarize
    diarize._encoder()
    diarize.release()


def ocr():
    import easyocr
    easyocr.Reader(["fr", "en"], gpu=False, verbose=False)


if __name__ == "__main__":
    step("Whisper large-v3 français (≈ 3 Go)", whisper_fr)
    if "--multi" in sys.argv:
        step("Whisper large-v3 multilingue (≈ 3 Go)", whisper_multi)
    step("BGE-M3 + BGE-reranker-v2-m3 (≈ 4,5 Go)", embed)
    step("ECAPA (intervenants)", speaker)
    step("EasyOCR français/anglais", ocr)
    print("Tous les modèles sont prêts.")
