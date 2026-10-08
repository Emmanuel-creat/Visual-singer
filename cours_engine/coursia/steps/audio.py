"""Extraction et préparation de l'audio (FFmpeg embarqué via imageio-ffmpeg).

- audio16k.wav : mono 16 kHz pour la transcription (nettoyage léger ou fort)
- playback.m4a : version compacte pour le lecteur si le média n'est pas lisible par le navigateur

Le nettoyage reste prudent : un débruitage agressif peut dégrader la reconnaissance
vocale. « light » = coupe des très basses fréquences + normalisation du volume ;
« strong » ajoute un débruitage spectral (afftdn) pour les enregistrements très bruités.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

from ..store import Project, cache_key, file_fingerprint

BROWSER_PLAYABLE = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".opus", ".webm", ".mp4", ".m4v", ".flac"}
VIDEO_EXT = {".mp4", ".m4v", ".mkv", ".mov", ".avi", ".webm", ".wmv", ".flv", ".mpg", ".mpeg", ".ts"}

FILTERS = {
    "off": [],
    "light": ["highpass=f=70", "loudnorm=I=-20:TP=-2:LRA=11"],
    "strong": ["highpass=f=80", "lowpass=f=8000", "afftdn=nr=12:nf=-30:tn=1", "loudnorm=I=-20:TP=-2:LRA=11"],
}


def ffmpeg_exe() -> str:
    import imageio_ffmpeg
    return imageio_ffmpeg.get_ffmpeg_exe()


def probe_duration(path: Path) -> float:
    out = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", str(path)], capture_output=True, text=True, errors="replace")
    m = re.search(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)", out.stderr)
    if not m:
        raise RuntimeError(f"Impossible de lire la durée de {path.name} (format non reconnu ?)")
    h, mi, s = m.groups()
    return int(h) * 3600 + int(mi) * 60 + float(s)


def has_video(path: Path) -> bool:
    out = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", str(path)], capture_output=True, text=True, errors="replace")
    return bool(re.search(r"Stream #\S+.*Video:", out.stderr)) and "attached pic" not in out.stderr


def _run(cmd: list[str], duration: float, progress) -> None:
    """Lance FFmpeg en suivant sa progression (time=…)."""
    proc = subprocess.Popen(cmd, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True, errors="replace")
    for line in proc.stderr:
        m = re.search(r"time=(\d+):(\d+):(\d+(?:\.\d+)?)", line)
        if m and duration > 0:
            h, mi, s = m.groups()
            progress(min(0.99, (int(h) * 3600 + int(mi) * 60 + float(s)) / duration))
    if proc.wait() != 0:
        raise RuntimeError("FFmpeg a échoué pendant l'extraction audio")


def key(project: Project) -> str:
    media = project.meta().get("media")
    return cache_key("audio-v1", media and media.get("fingerprint"), project.settings()["cleaning"])


def run(project: Project, ctx) -> dict:
    media = project.meta().get("media")
    if not media:
        raise RuntimeError("Aucun fichier audio/vidéo dans ce cours")
    src = project.originals / media["file"]
    k = key(project)
    cached = project.cached("audio", k)
    if cached and (project.work / "audio16k.wav").exists():
        return cached

    duration = probe_duration(src)
    filters = FILTERS.get(project.settings()["cleaning"], FILTERS["light"])
    out = project.work / "audio16k.wav"
    tmp = out.with_suffix(".tmp.wav")
    cmd = [ffmpeg_exe(), "-hide_banner", "-y", "-i", str(src), "-vn", "-ac", "1", "-ar", "16000"]
    if filters:
        cmd += ["-af", ",".join(filters)]
    cmd += ["-c:a", "pcm_s16le", str(tmp)]
    ctx.log(f"Extraction audio ({duration / 60:.0f} min, nettoyage « {project.settings()['cleaning']} »)")
    _run(cmd, duration, lambda p: ctx.progress(p * 0.8))
    tmp.replace(out)

    # Version de lecture si le format d'origine n'est pas lu par le navigateur.
    ext = src.suffix.lower()
    video = has_video(src)
    playback = media["file"]
    playback_kind = "video" if video else "audio"
    if ext not in BROWSER_PLAYABLE or (video and ext not in {".mp4", ".m4v", ".webm"}):
        pb = project.work / "playback.m4a"
        ctx.log("Création d'une version audio lisible par le navigateur")
        _run([ffmpeg_exe(), "-hide_banner", "-y", "-i", str(src), "-vn", "-ac", "2", "-c:a", "aac", "-b:a", "128k", str(pb)],
             duration, lambda p: ctx.progress(0.8 + p * 0.2))
        playback, playback_kind = "work/playback.m4a", "audio"
    else:
        playback = f"originals/{media['file']}"

    data = {"duration": duration, "video": video, "playback": playback, "playback_kind": playback_kind}
    project.put("audio", k, data)
    return data
