"""Chemins, modèles et paramètres par défaut.

Tous les modèles sont téléchargés une seule fois dans cours_engine/models/
(variables HF_HOME / OLLAMA restent locales) ; ensuite tout fonctionne hors ligne.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Certains antivirus (Avast…) définissent SSLKEYLOGFILE vers un tube spécial : OpenSSL
# plante alors dans Python (« no OPENSSL_Applink »). Le moteur n'en a pas besoin.
os.environ.pop("SSLKEYLOGFILE", None)
# Antivirus inspectant HTTPS : utiliser le magasin de certificats de Windows.
try:
    import truststore
    truststore.inject_into_ssl()
except Exception:
    pass

ENGINE_DIR = Path(__file__).resolve().parent.parent          # cours_engine/
APP_ROOT = ENGINE_DIR.parent                                  # dépôt Visual Singer
MODELS_DIR = Path(os.environ.get("COURSIA_MODELS", ENGINE_DIR / "models"))
MODELS_DIR.mkdir(parents=True, exist_ok=True)

# Caches des bibliothèques de modèles : dans le dossier du projet, pas dans le profil.
os.environ.setdefault("HF_HOME", str(MODELS_DIR / "huggingface"))
os.environ.setdefault("TORCH_HOME", str(MODELS_DIR / "torch"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")          # le téléchargeur « xet » plante sous Windows (OpenSSL)
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")


def _desktop_dir() -> Path:
    sys.path.insert(0, str(APP_ROOT))
    try:
        from server import desktop_dir  # même logique que l'appli (Bureau OneDrive)
        return desktop_dir()
    except Exception:
        return Path.home() / "Desktop"
    finally:
        sys.path.pop(0)


DATA_DIR = Path(os.environ.get("COURSIA_DATA") or (_desktop_dir() / "Visual Singer" / "cours"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

HOST = os.environ.get("COURSIA_HOST", "127.0.0.1")
PORT = int(os.environ.get("COURSIA_PORT", "8091"))
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")

# Modèles de reconnaissance vocale (CTranslate2 / faster-whisper).
ASR_MODELS = {
    # Whisper large-v3 affiné sur le français : meilleur taux d'erreur en français.
    "fr": "bofenghuang/whisper-large-v3-french",
    "multi": "large-v3",
}
EMBED_MODEL = "BAAI/bge-m3"
RERANK_MODEL = "BAAI/bge-reranker-v2-m3"
SPEAKER_MODEL = "speechbrain/spkrec-ecapa-voxceleb"

# Paramètres par défaut d'un projet (modifiables dans l'interface).
DEFAULT_SETTINGS = {
    "language": "fr",          # fr | en | auto | …
    "asr_model": "auto",       # auto | identifiant faster-whisper / Hugging Face
    "cleaning": "light",       # off | light | strong
    "speakers": 0,             # 0 = automatique
    "diarization": True,
    "llm_profile": "quality",  # quality | fast
    "qa_count": 20,
    "use_doc_vocabulary": True,  # injecter le vocabulaire du support dans la transcription
}
