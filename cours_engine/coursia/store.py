"""Stockage des projets : un dossier par cours, écritures atomiques, cache par étape.

Bureau/Visual Singer/cours/<id>/
  project.json          métadonnées, fichiers, paramètres
  state.json            état de chaque étape (statut, clé de cache, progression, erreur)
  originals/            fichiers importés, jamais modifiés
  work/                 audio extrait, version de lecture
  cache/<étape>.json    résultats de chaque étape
  docs/<doc_id>/        pages extraites, miniatures
  index/                index sémantique
  exports/              rapports Markdown / DOCX / PDF
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path
from typing import Any

from .config import DATA_DIR, DEFAULT_SETTINGS

_lock = threading.RLock()


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def file_fingerprint(path: Path) -> str:
    """Empreinte rapide d'un gros fichier : taille + début + milieu + fin."""
    st = path.stat()
    h = hashlib.sha256(f"{st.st_size}".encode())
    with open(path, "rb") as f:
        for pos in (0, max(0, st.st_size // 2 - (1 << 20)), max(0, st.st_size - (1 << 20))):
            f.seek(pos)
            h.update(f.read(1 << 20))
    return h.hexdigest()[:24]


def cache_key(*parts: Any) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()[:24]


def slug(text: str) -> str:
    s = re.sub(r"[^\w\-]+", "-", text.lower(), flags=re.UNICODE).strip("-")
    return s[:40] or "cours"


class Project:
    def __init__(self, pid: str):
        self.id = pid
        self.dir = DATA_DIR / pid
        if not self.dir.exists():
            raise FileNotFoundError(pid)

    # ------------------------------------------------------------ chemins
    @property
    def originals(self) -> Path: return self.dir / "originals"
    @property
    def work(self) -> Path: return self.dir / "work"
    @property
    def cache(self) -> Path: return self.dir / "cache"
    @property
    def docs_dir(self) -> Path: return self.dir / "docs"
    @property
    def index_dir(self) -> Path: return self.dir / "index"
    @property
    def exports(self) -> Path: return self.dir / "exports"

    # ------------------------------------------------------------ méta
    def meta(self) -> dict:
        return read_json(self.dir / "project.json", {})

    def save_meta(self, meta: dict) -> None:
        meta["updated"] = time.time()
        write_json(self.dir / "project.json", meta)

    def settings(self) -> dict:
        return {**DEFAULT_SETTINGS, **(self.meta().get("settings") or {})}

    # ------------------------------------------------------------ état
    def state(self) -> dict:
        return read_json(self.dir / "state.json", {}) or {}

    def set_step(self, step: str, **fields) -> dict:
        with _lock:
            st = self.state()
            cur = st.get(step, {})
            cur.update(fields)
            cur["at"] = time.time()
            st[step] = cur
            write_json(self.dir / "state.json", st)
            return cur

    # ------------------------------------------------------------ cache
    def cached(self, step: str, key: str) -> Any | None:
        """Résultat en cache si la clé correspond (sinon None)."""
        data = read_json(self.cache / f"{step}.json")
        if data and data.get("_key") == key:
            return data.get("data")
        return None

    def put(self, step: str, key: str, data: Any) -> None:
        write_json(self.cache / f"{step}.json", {"_key": key, "_at": time.time(), "data": data})

    def result(self, step: str) -> Any | None:
        data = read_json(self.cache / f"{step}.json")
        return data.get("data") if data else None

    def key_of(self, step: str) -> str | None:
        data = read_json(self.cache / f"{step}.json")
        return data.get("_key") if data else None


def create_project(title: str) -> Project:
    pid = f"{time.strftime('%Y%m%d-%H%M%S')}-{slug(title)}-{uuid.uuid4().hex[:4]}"
    d = DATA_DIR / pid
    for sub in ("originals", "work", "cache", "docs", "index", "exports"):
        (d / sub).mkdir(parents=True, exist_ok=True)
    write_json(d / "project.json", {
        "id": pid, "title": title, "created": time.time(), "updated": time.time(),
        "media": None, "docs": [], "settings": dict(DEFAULT_SETTINGS),
    })
    return Project(pid)


def list_projects() -> list[dict]:
    out = []
    for d in sorted(DATA_DIR.iterdir(), reverse=True) if DATA_DIR.exists() else []:
        if d.is_dir() and not d.name.startswith("_") and (d / "project.json").exists():
            m = read_json(d / "project.json", {})
            m["state"] = read_json(d / "state.json", {})
            out.append(m)
    return out


def delete_project(pid: str) -> str:
    """Pas de suppression définitive : déplacement dans cours/_corbeille. Renvoie le nom dans la corbeille."""
    src = DATA_DIR / pid
    trash = DATA_DIR / "_corbeille"
    trash.mkdir(exist_ok=True)
    name = f"{pid}--{int(time.time())}"
    shutil.move(str(src), str(trash / name))
    return name


def restore_project(name: str) -> str:
    """Ramène un cours de la corbeille (annulation d'une suppression)."""
    if not re.fullmatch(r"[\w\-]+", name):
        raise FileNotFoundError(name)
    src = DATA_DIR / "_corbeille" / name
    if not src.is_dir():
        raise FileNotFoundError(name)
    pid = name.rsplit("--", 1)[0]
    dst = DATA_DIR / pid
    if dst.exists():
        raise FileExistsError(pid)
    shutil.move(str(src), str(dst))
    return pid
