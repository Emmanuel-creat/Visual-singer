#!/usr/bin/env python3
"""
Visual Singer — serveur local (bibliothèque standard Python uniquement).

  python server.py            → http://localhost:8080

Sert l'application et enregistre les données sur le Bureau :

  Bureau/Visual Singer/
    config.json                        réglages + thèmes
    detections/AAAA-MM-JJ.csv          journal des sons identifiés (Excel)
    detections/AAAA-MM-JJ.jsonl        même journal, une ligne JSON par détection
    extraits/AAAA-MM-JJ/*.wav          extrait audio de chaque détection

Options : --port 8080   --data "D:/autre/dossier"
Le serveur n'écoute que sur 127.0.0.1 (inaccessible depuis le réseau).
"""
import argparse
import csv
import io
import json
import os
import re
import sys
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

APP_DIR = Path(__file__).resolve().parent
MAX_BODY = 25 * 1024 * 1024
CSV_FIELDS = ["date", "heure", "categorie", "nom", "nom_scientifique", "nom_anglais",
              "confiance", "duree_s", "detections", "modele", "extrait", "alternatives"]


def desktop_dir() -> Path:
    """Dossier Bureau réel (gère la redirection OneDrive sous Windows)."""
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            class GUID(ctypes.Structure):
                _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD),
                            ("Data3", wintypes.WORD), ("Data4", ctypes.c_ubyte * 8)]

            # FOLDERID_Desktop {B4BFCC3A-DB2C-424C-B029-7FE99A87C641}
            fid = GUID(0xB4BFCC3A, 0xDB2C, 0x424C, (ctypes.c_ubyte * 8)(0xB0, 0x29, 0x7F, 0xE9, 0x9A, 0x87, 0xC6, 0x41))
            ptr = ctypes.c_wchar_p()
            if ctypes.windll.shell32.SHGetKnownFolderPath(ctypes.byref(fid), 0, None, ctypes.byref(ptr)) == 0:
                path = Path(ptr.value)
                ctypes.windll.ole32.CoTaskMemFree(ptr)
                return path
        except Exception:
            pass
    for name in ("Desktop", "Bureau"):
        p = Path.home() / name
        if p.is_dir():
            return p
    return Path.home()


def safe_name(text: str, limit: int = 60) -> str:
    text = re.sub(r"[^\w\- ]+", "", text, flags=re.UNICODE).strip().replace(" ", "_")
    return text[:limit] or "son"


class Handler(SimpleHTTPRequestHandler):
    data_dir: Path = Path(".")
    # Connexions persistantes : sous Windows, fermer le socket juste après l'envoi
    # tronquait parfois les gros fichiers (poids des modèles) lors de requêtes parallèles.
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(APP_DIR), **kwargs)

    def log_message(self, fmt, *args):  # journal console plus discret
        if "/api/" in (self.path or ""):
            sys.stderr.write("[api] " + (fmt % args) + "\n")

    def log_error(self, fmt, *args):
        sys.stderr.write("[erreur] " + (fmt % args) + "\n")

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    # ------------------------------------------------------------- outils
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise ValueError("corps de requête trop volumineux")
        return self.rfile.read(n)

    def _same_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return True
        host = urlparse(origin).hostname
        return host in ("localhost", "127.0.0.1", "[::1]", "::1")

    # ------------------------------------------------------------- routes
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/info":
            return self._json({"ok": True, "dataDir": str(self.data_dir)})
        if path == "/api/state":
            f = self.data_dir / "config.json"
            try:
                return self._json(json.loads(f.read_text("utf-8")) if f.exists() else {})
            except Exception:
                return self._json({})
        if path == "/api/detections":
            f = self.data_dir / "detections" / f"{datetime.now():%Y-%m-%d}.jsonl"
            items = []
            if f.exists():
                for line in f.read_text("utf-8").splitlines():
                    try:
                        items.append(json.loads(line))
                    except Exception:
                        pass
            return self._json(items[-300:])
        return super().do_GET()

    def do_PUT(self):
        if not self._same_origin():
            return self._json({"error": "origine refusée"}, 403)
        if urlparse(self.path).path != "/api/state":
            return self._json({"error": "introuvable"}, 404)
        try:
            data = json.loads(self._body() or b"{}")
            tmp = self.data_dir / "config.json.tmp"
            tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
            os.replace(tmp, self.data_dir / "config.json")
            return self._json({"ok": True})
        except Exception as e:
            return self._json({"error": str(e)}, 400)

    def do_POST(self):
        if not self._same_origin():
            return self._json({"error": "origine refusée"}, 403)
        url = urlparse(self.path)
        try:
            if url.path == "/api/detection":
                return self._json(self._save_detection(json.loads(self._body())))
            if url.path == "/api/clip":
                name = safe_name(self.headers.get("X-Clip-Name", "son"), 90)
                day = datetime.now().strftime("%Y-%m-%d")
                folder = self.data_dir / "extraits" / day
                folder.mkdir(parents=True, exist_ok=True)
                target = folder / f"{name}.wav"
                target.write_bytes(self._body())
                return self._json({"ok": True, "file": f"extraits/{day}/{target.name}"})
        except Exception as e:
            return self._json({"error": str(e)}, 400)
        return self._json({"error": "introuvable"}, 404)

    def _save_detection(self, d: dict) -> dict:
        now = datetime.now()
        folder = self.data_dir / "detections"
        folder.mkdir(parents=True, exist_ok=True)
        day = f"{now:%Y-%m-%d}"
        with open(folder / f"{day}.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps(d, ensure_ascii=False) + "\n")
        csv_path = folder / f"{day}.csv"
        new = not csv_path.exists()
        alts = " | ".join(f"{a.get('label')} ({round(float(a.get('score', 0)) * 100)}%)" for a in d.get("alternatives", []))
        row = {
            "date": day,
            "heure": d.get("heure") or f"{now:%H:%M:%S}",
            "categorie": d.get("categorie", ""),
            "nom": d.get("label", ""),
            "nom_scientifique": d.get("sci", ""),
            "nom_anglais": d.get("en", ""),
            "confiance": f"{float(d.get('confidence', 0)) * 100:.0f}%",
            "duree_s": f"{float(d.get('duration', 0)):.1f}",
            "detections": d.get("hits", 1),
            "modele": d.get("source", ""),
            "extrait": d.get("clip", ""),
            "alternatives": alts,
        }
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=CSV_FIELDS, delimiter=";")
        if new:
            w.writeheader()
        w.writerow(row)
        # utf-8-sig : accents corrects à l'ouverture dans Excel.
        with open(csv_path, "a", encoding="utf-8-sig" if new else "utf-8", newline="") as f:
            f.write(buf.getvalue())
        return {"ok": True}


def main():
    # Console Windows (cp1252) : évite les plantages sur les accents.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    ap = argparse.ArgumentParser(description="Visual Singer — serveur local")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--data", default=os.environ.get("VS_DATA_DIR"))
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    data_dir = Path(args.data) if args.data else desktop_dir() / "Visual Singer"
    for sub in ("", "detections", "extraits"):
        (data_dir / sub).mkdir(parents=True, exist_ok=True)
    Handler.data_dir = data_dir
    Handler.extensions_map.update({".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm"})

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://localhost:{args.port}"
    print(f"Visual Singer  ->  {url}")
    print(f"Sauvegardes    ->  {data_dir}")
    print("Ctrl+C pour arrêter.")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
