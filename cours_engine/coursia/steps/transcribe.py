"""Transcription haute précision (faster-whisper / CTranslate2).

- Modèle : Whisper large-v3 affiné pour le français (bofenghuang/whisper-large-v3-french)
  quand la langue est le français, sinon Whisper large-v3 multilingue.
- Découpage en tranches d'environ 10 min, coupées dans un silence ; chaque tranche
  terminée est enregistrée immédiatement : un traitement interrompu reprend à la
  tranche suivante.
- Inférence par lots (BatchedInferencePipeline) : les segments de parole détectés par
  le VAD Silero sont transcrits indépendamment et en parallèle sur le GPU. Plus rapide
  (≈ 30× le temps réel sur RTX 5060) et sans les boucles de répétition du mode
  séquentiel. Recherche en faisceau (beam 5), horodatage au mot, filtre anti-répétition.
- Le vocabulaire du support de cours (sigles, termes techniques) est fourni au modèle
  (hotwords) pour mieux orthographier la terminologie.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from ..config import ASR_MODELS, MODELS_DIR
from ..hardware import detect, free_gpu
from ..store import Project, cache_key

VERSION = "asr-v2"
BATCH = 8
CHUNK_S = 600          # durée cible d'une tranche
SEARCH_S = 20          # fenêtre de recherche d'un silence autour de la coupe
SR = 16000

_model = None
_model_id = None


def resolve_model(settings: dict) -> str:
    if settings.get("asr_model") and settings["asr_model"] != "auto":
        return settings["asr_model"]
    return ASR_MODELS["fr"] if settings.get("language") == "fr" else ASR_MODELS["multi"]


def _model_path(model_id: str) -> str:
    """Les dépôts Hugging Face contenant un sous-dossier « ctranslate2 » sont téléchargés puis pointés."""
    if "/" not in model_id:
        return model_id                          # nom court faster-whisper (large-v3…)
    from huggingface_hub import snapshot_download
    try:
        path = snapshot_download(model_id, allow_patterns=["ctranslate2/*"], cache_dir=str(MODELS_DIR / "whisper"))
        if (Path(path) / "ctranslate2" / "model.bin").exists():
            return str(Path(path) / "ctranslate2")
    except Exception:
        pass
    return snapshot_download(model_id, cache_dir=str(MODELS_DIR / "whisper"))


def load(model_id: str, ctx=None):
    global _model, _model_id
    if _model is not None and _model_id == model_id:
        return _model
    unload()
    from faster_whisper import WhisperModel
    hw = detect()
    path = _model_path(model_id)
    if hw.cuda:
        try:
            _model = WhisperModel(path, device="cuda", compute_type="float16", download_root=str(MODELS_DIR / "whisper"))
            _model_id = model_id
            return _model
        except Exception as e:  # GPU non pris en charge par CTranslate2 → CPU
            if ctx:
                ctx.log(f"GPU indisponible pour la transcription ({e}) : bascule sur le processeur (plus lent)")
    _model = WhisperModel(path, device="cpu", compute_type="int8", cpu_threads=max(4, hw.threads - 2),
                          download_root=str(MODELS_DIR / "whisper"))
    _model_id = model_id
    return _model


def unload():
    global _model, _model_id
    _model, _model_id = None, None
    free_gpu()


def read_wav(path: Path) -> tuple[np.memmap, int]:
    import soundfile as sf
    info = sf.info(str(path))
    if info.samplerate != SR or info.channels != 1:
        raise RuntimeError("audio16k.wav inattendu (doit être mono 16 kHz)")
    return info.frames


def chunk_bounds(path: Path, frames: int) -> list[tuple[int, int]]:
    """Tranches d'environ CHUNK_S secondes, coupées au point le plus silencieux."""
    import soundfile as sf
    bounds, start = [], 0
    total = frames / SR
    while start < frames:
        target = start + CHUNK_S * SR
        if target >= frames - 60 * SR:
            bounds.append((start, frames))
            break
        a, b = int(target - SEARCH_S * SR), int(target + SEARCH_S * SR)
        win, _ = sf.read(str(path), start=a, stop=b, dtype="float32")
        hop = SR // 20                                    # énergie par tranche de 50 ms
        e = np.array([np.mean(win[i:i + hop] ** 2) for i in range(0, len(win) - hop, hop)])
        if len(e) > 10:
            k = np.convolve(e, np.ones(6) / 6, mode="same")
            cut = a + int(np.argmin(k)) * hop
        else:
            cut = target
        bounds.append((start, cut))
        start = cut
    return bounds if total > 0 else []


def _norm(t: str) -> str:
    import re
    return re.sub(r"\W+", " ", t.lower()).strip()


def dedupe(segs: list[dict]) -> list[dict]:
    """Supprime les répétitions typiques de Whisper (même phrase répétée en boucle)."""
    import re
    out = []
    for seg in segs:
        # Phrases répétées à l'intérieur d'un segment.
        parts = re.split(r"(?<=[.!?…])\s+", seg["text"])
        kept, seen = [], set()
        for ph in parts:
            n = _norm(ph)
            if n and n in seen and len(n) > 12:
                continue
            seen.add(n)
            kept.append(ph)
        if len(kept) < len(parts):
            seg = {**seg, "text": " ".join(kept)}
        # Segment identique au précédent.
        if out and _norm(seg["text"]) == _norm(out[-1]["text"]) and len(seg["text"]) > 12:
            out[-1]["end"] = seg["end"]
            continue
        out.append(seg)
    return out


def key(project: Project, vocab: list[str]) -> str:
    s = project.settings()
    return cache_key(VERSION, project.key_of("audio"), resolve_model(s), s.get("language"),
                     vocab if s.get("use_doc_vocabulary") else None)


def run(project: Project, ctx, vocab: list[str]) -> dict:
    import soundfile as sf
    s = project.settings()
    k = key(project, vocab)
    cached = project.cached("transcribe", k)
    if cached is not None:
        return cached

    wav = project.work / "audio16k.wav"
    frames = read_wav(wav)
    bounds = chunk_bounds(wav, frames)
    partial = project.cache / "transcribe.partial.jsonl"
    done: dict[int, list] = {}
    if partial.exists():
        for line in partial.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
                if rec.get("key") == k:
                    done[rec["chunk"]] = rec["segments"]
            except Exception:
                pass
        if done:
            ctx.log(f"Reprise : {len(done)}/{len(bounds)} tranches déjà transcrites")
    else:
        partial.write_text("", encoding="utf-8")

    model_id = resolve_model(s)
    language = None if s.get("language") in (None, "", "auto") else s["language"]
    hotwords = ", ".join(vocab[:40]) if (vocab and s.get("use_doc_vocabulary")) else None
    model = None
    prev_tail = ""
    detected = language

    for ci, (a, b) in enumerate(bounds):
        if ci in done:
            if done[ci]:
                prev_tail = " ".join(x["text"] for x in done[ci][-3:])[-220:]
            continue
        if model is None:
            ctx.log(f"Chargement du modèle de transcription {model_id}…")
            model = load(model_id, ctx)
        audio, _ = sf.read(str(wav), start=a, stop=b, dtype="float32")
        offset = a / SR
        from faster_whisper import BatchedInferencePipeline
        pipe = BatchedInferencePipeline(model)
        seg_iter, info = pipe.transcribe(
            audio,
            language=language,
            task="transcribe",
            batch_size=BATCH if detect().cuda else 4,
            beam_size=5,
            temperature=(0.0, 0.2, 0.4, 0.6),
            compression_ratio_threshold=2.4,
            log_prob_threshold=-1.0,
            no_speech_threshold=0.6,
            hotwords=hotwords,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500, "speech_pad_ms": 300},
        )
        detected = detected or info.language
        segs = []
        chunk_len = (b - a) / SR
        for seg in seg_iter:
            text = seg.text.strip()
            if not text:
                continue
            segs.append({
                "start": round(offset + seg.start, 2), "end": round(offset + seg.end, 2), "text": text,
                "words": [{"s": round(offset + w.start, 2), "e": round(offset + w.end, 2), "w": w.word, "p": round(w.probability, 3)}
                          for w in (seg.words or [])],
                "logprob": round(seg.avg_logprob, 3), "nospeech": round(seg.no_speech_prob, 3),
            })
            ctx.progress((ci + min(1.0, seg.end / max(1.0, chunk_len))) / len(bounds))
        segs = dedupe(segs)
        with open(partial, "a", encoding="utf-8") as f:
            f.write(json.dumps({"key": k, "chunk": ci, "segments": segs}, ensure_ascii=False) + "\n")
        done[ci] = segs
        if segs:
            prev_tail = " ".join(x["text"] for x in segs[-3:])[-220:]
        ctx.log(f"Tranche {ci + 1}/{len(bounds)} transcrite ({len(segs)} segments)")
        ctx.check_cancel()

    segments = [x for ci in sorted(done) for x in done[ci]]
    for i, seg in enumerate(segments):
        seg["id"] = i
    data = {"model": model_id, "language": detected or language, "segments": segments, "duration": frames / SR}
    project.put("transcribe", k, data)
    partial.unlink(missing_ok=True)
    return data
