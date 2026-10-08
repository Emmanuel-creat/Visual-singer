"""Client Ollama (LLM local). Aucune requête ne sort de la machine : 127.0.0.1:11434.

- Sorties structurées : schéma JSON imposé (`format`), avec nouvel essai si le JSON est invalide.
- Mode « réflexion » de Qwen désactivé par défaut (plus rapide, sorties plus stables).
- Profils : « quality » (modèle le plus gros compatible) et « fast ».
"""
from __future__ import annotations

import json
from typing import Iterator

import httpx

from .config import OLLAMA_URL
from .hardware import recommend


class LLMError(RuntimeError):
    pass


def models_available() -> list[str]:
    try:
        r = httpx.get(f"{OLLAMA_URL}/api/tags", timeout=5)
        r.raise_for_status()
        return [m["name"] for m in r.json().get("models", [])]
    except Exception:
        return []


def status() -> dict:
    names = models_available()
    rec = recommend()
    return {"running": bool(names) or _ping(), "models": names, "quality": rec["llm_quality"], "fast": rec["llm_fast"],
            "quality_ready": rec["llm_quality"] in names, "fast_ready": rec["llm_fast"] in names}


def _ping() -> bool:
    try:
        return httpx.get(f"{OLLAMA_URL}/api/version", timeout=3).status_code == 200
    except Exception:
        return False


def pick_model(profile: str = "quality") -> str:
    rec = recommend()
    names = models_available()
    if not names:
        raise LLMError("Ollama ne répond pas : lancez Ollama (ou start-cours.bat) puis réessayez.")
    want = rec["llm_quality"] if profile == "quality" else rec["llm_fast"]
    for cand in (want, rec["llm_quality"], rec["llm_fast"]):
        if cand in names:
            return cand
    # Sinon : le plus gros modèle installé.
    return names[0]


def ctx_size(model: str) -> int:
    return recommend()["llm_ctx"] if "35b" in model or "27b" in model else 16384


def chat(messages: list[dict], model: str, *, schema: dict | None = None, temperature: float = 0.2,
         num_ctx: int | None = None, think: bool = False, timeout: float = 1800) -> str:
    body = {
        "model": model, "messages": messages, "stream": False, "think": think, "keep_alive": "15m",
        "options": {"temperature": temperature, "num_ctx": num_ctx or ctx_size(model), "top_p": 0.9, "repeat_penalty": 1.05},
    }
    if schema:
        body["format"] = schema
    try:
        r = httpx.post(f"{OLLAMA_URL}/api/chat", json=body, timeout=timeout)
    except httpx.HTTPError as e:
        raise LLMError(f"Ollama injoignable : {e}") from e
    if r.status_code != 200:
        raise LLMError(f"Ollama : {r.status_code} {r.text[:300]}")
    return r.json()["message"]["content"]


def chat_json(messages: list[dict], model: str, schema: dict, retries: int = 2, **kw) -> dict:
    last = ""
    for attempt in range(retries + 1):
        out = chat(messages, model, schema=schema, **kw)
        try:
            return json.loads(out)
        except json.JSONDecodeError:
            last = out
            messages = messages + [{"role": "assistant", "content": out},
                                   {"role": "user", "content": "Le JSON précédent est invalide. Renvoie uniquement un JSON valide respectant le schéma."}]
    raise LLMError(f"Réponse JSON invalide du modèle : {last[:200]}")


def stream(messages: list[dict], model: str, *, temperature: float = 0.3, num_ctx: int | None = None, think: bool = False) -> Iterator[str]:
    body = {"model": model, "messages": messages, "stream": True, "think": think, "keep_alive": "15m",
            "options": {"temperature": temperature, "num_ctx": num_ctx or ctx_size(model)}}
    with httpx.stream("POST", f"{OLLAMA_URL}/api/chat", json=body, timeout=None) as r:
        if r.status_code != 200:
            raise LLMError(f"Ollama : {r.status_code}")
        for line in r.iter_lines():
            if not line:
                continue
            msg = json.loads(line)
            piece = msg.get("message", {}).get("content", "")
            if piece:
                yield piece
            if msg.get("done"):
                break


def unload_all() -> None:
    try:
        r = httpx.get(f"{OLLAMA_URL}/api/ps", timeout=5)
        for m in r.json().get("models", []):
            unload(m["name"])
    except Exception:
        pass


def unload(model: str) -> None:
    """Libère la VRAM occupée par le LLM (avant une transcription par exemple)."""
    try:
        httpx.post(f"{OLLAMA_URL}/api/generate", json={"model": model, "keep_alive": 0}, timeout=30)
    except Exception:
        pass
