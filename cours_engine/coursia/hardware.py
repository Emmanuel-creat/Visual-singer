"""Détection du matériel et choix automatique du profil de calcul."""
from __future__ import annotations

import os
import platform
import subprocess
from dataclasses import dataclass, asdict
from functools import lru_cache


@dataclass
class Hardware:
    cpu: str
    cores: int
    threads: int
    ram_gb: float
    gpu: str | None
    vram_gb: float
    cuda: bool
    compute_capability: str | None
    torch_cuda: bool

    def as_dict(self) -> dict:
        return asdict(self)


def _ram_gb() -> float:
    try:
        import psutil  # type: ignore
        return psutil.virtual_memory().total / 1024 ** 3
    except Exception:
        pass
    if platform.system() == "Windows":
        import ctypes

        class MEMSTAT(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("sullAvailExtendedVirtual", ctypes.c_ulonglong)]
        st = MEMSTAT()
        st.dwLength = ctypes.sizeof(MEMSTAT)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st))
        return st.ullTotalPhys / 1024 ** 3
    return 0.0


def _cpu_name() -> str:
    if platform.system() == "Windows":
        try:
            out = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_Processor).Name"],
                                 capture_output=True, text=True, timeout=10)
            if out.stdout.strip():
                return out.stdout.strip()
        except Exception:
            pass
    return platform.processor() or "CPU"


@lru_cache(maxsize=1)
def detect() -> Hardware:
    gpu, vram, cc, torch_cuda = None, 0.0, None, False
    try:
        import torch
        torch_cuda = torch.cuda.is_available()
        if torch_cuda:
            props = torch.cuda.get_device_properties(0)
            gpu = props.name
            vram = props.total_memory / 1024 ** 3
            cc = f"{props.major}.{props.minor}"
    except Exception:
        pass
    if gpu is None:
        try:
            out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total,compute_cap", "--format=csv,noheader,nounits"],
                                 capture_output=True, text=True, timeout=10)
            if out.returncode == 0 and out.stdout.strip():
                name, mem, cap = [x.strip() for x in out.stdout.strip().splitlines()[0].split(",")]
                gpu, vram, cc = name, float(mem) / 1024, cap
        except Exception:
            pass
    return Hardware(
        cpu=_cpu_name(),
        cores=os.cpu_count() // 2 if os.cpu_count() else 1,
        threads=os.cpu_count() or 1,
        ram_gb=round(_ram_gb(), 1),
        gpu=gpu,
        vram_gb=round(vram, 1),
        cuda=gpu is not None,
        compute_capability=cc,
        torch_cuda=torch_cuda,
    )


def device() -> str:
    return "cuda" if detect().torch_cuda else "cpu"


def recommend() -> dict:
    """Profil recommandé selon la VRAM / RAM disponibles (qualité prioritaire)."""
    hw = detect()
    rec = {
        "asr_device": "cuda" if hw.torch_cuda else "cpu",
        "asr_compute_type": "float16" if hw.torch_cuda else "int8",
        "embed_device": "cuda" if hw.torch_cuda else "cpu",
        "llm_quality": "qwen3.5:9b",
        "llm_fast": "qwen3.5:4b",
        "llm_ctx": 16384,
    }
    # Modèle MoE 35B (22 Go en Q4) : VRAM + RAM système suffisantes → qualité maximale.
    if hw.vram_gb + hw.ram_gb >= 34:
        rec["llm_quality"] = "qwen3.5:35b-a3b"
        rec["llm_fast"] = "qwen3.5:9b"
        rec["llm_ctx"] = 32768
    elif hw.vram_gb >= 6:
        rec["llm_quality"] = "qwen3.5:9b"
        rec["llm_fast"] = "qwen3.5:9b"
    return rec


def free_gpu() -> None:
    """Libère la mémoire GPU entre deux étapes lourdes."""
    import gc
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.ipc_collect()
    except Exception:
        pass
