"""Assemble les icônes Windows (.ico 16 → 256 px) des quatre applications.

Les PNG 256 px sont rendus depuis js/icons.js par Edge headless (voir tools/render-icon.html) :

    python tools/make_icons.py <dossier des PNG>
"""
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "icons"
SIZES = [(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64), (128, 128), (256, 256)]

src = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT
OUT.mkdir(parents=True, exist_ok=True)
for name in ("accueil", "detecteur", "sommeil", "cours"):
    im = Image.open(src / f"{name}.png").convert("RGBA")
    im.save(OUT / f"{name}.png")
    im.save(OUT / f"{name}.ico", sizes=SIZES)
    print(OUT / f"{name}.ico")
