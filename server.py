#!/usr/bin/env python3
"""
Visual Singer - serveur local (bibliothèque standard Python uniquement).

  python server.py            → http://localhost:8080

Sert l'application et enregistre les données sur le Bureau :

  Bureau/Visual Singer/
    config.json                        réglages + thèmes
    detections/AAAA-MM-JJ.csv          journal des sons identifiés (Excel)
    detections/AAAA-MM-JJ.jsonl        même journal, une ligne JSON par détection
    extraits/AAAA-MM-JJ/*.wav          extrait audio de chaque détection
    sommeil/<nuit>/night.json          données complètes d'une nuit (app Sommeil)
    sommeil/<nuit>/extraits/*.wav      extraits des événements nocturnes
    sommeil/historique.csv             une ligne par nuit (Excel)

Options : --port 8080   --data "D:/autre/dossier"
Le serveur n'écoute que sur 127.0.0.1 (inaccessible depuis le réseau).
"""
import argparse
import csv
import io
import json
import os
import re
import subprocess
import sys
import threading
import webbrowser
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

APP_DIR = Path(__file__).resolve().parent
APP_ROOT = APP_DIR
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


def stop_ollama() -> None:
    """Décharge les modèles d'Ollama puis arrête son serveur (libère RAM et VRAM)."""
    import urllib.request
    try:
        with urllib.request.urlopen("http://127.0.0.1:11434/api/ps", timeout=3) as r:
            for m in json.loads(r.read()).get("models", []):
                req = urllib.request.Request("http://127.0.0.1:11434/api/generate", method="POST",
                                             data=json.dumps({"model": m["name"], "keep_alive": 0}).encode(),
                                             headers={"Content-Type": "application/json"})
                urllib.request.urlopen(req, timeout=10).read()
    except Exception:
        pass
    if sys.platform == "win32":
        for exe in ("ollama app.exe", "ollama.exe"):
            subprocess.run(["taskkill", "/IM", exe, "/F"], capture_output=True)
    else:
        subprocess.run(["pkill", "-f", "ollama"], capture_output=True)


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

    def send_error(self, code, message=None, explain=None):
        """Page 404 compréhensible (avec liens vers les applications) au lieu de la page brute."""
        page = APP_ROOT / "404.html"
        if code == 404 and page.exists() and not (self.path or "").startswith("/api/"):
            data = page.read_bytes()
            self.send_response(404)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
            return
        super().send_error(code, message, explain)

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
        if path == "/api/sleep/nights":
            return self._json(self._list_nights())
        if path == "/api/sleep/night":
            night_dir = self._night_dir()
            f = night_dir / "night.json" if night_dir else None
            if not f or not f.exists():
                return self._json({"error": "nuit introuvable"}, 404)
            return self._send_file(f, "application/json; charset=utf-8")
        if path.startswith("/data/"):
            # Fichiers du dossier de sauvegarde (extraits audio des nuits…).
            rel = unquote(path[len("/data/"):])
            target = (self.data_dir / rel).resolve()
            if self.data_dir.resolve() not in target.parents or not target.is_file():
                return self._json({"error": "introuvable"}, 404)
            ctype = "audio/wav" if target.suffix.lower() == ".wav" else "application/octet-stream"
            return self._send_file(target, ctype)
        return super().do_GET()

    def _send_file(self, f: Path, ctype: str):
        data = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ------------------------------------------------------------- sommeil
    def _night_dir(self):
        night_id = parse_qs(urlparse(self.path).query).get("id", [""])[0]
        if not re.fullmatch(r"[0-9A-Za-z_\-]{4,40}", night_id or ""):
            return None
        return self.data_dir / "sommeil" / night_id

    def _list_nights(self):
        root = self.data_dir / "sommeil"
        out = []
        if root.exists():
            for d in sorted(root.iterdir()):
                f = d / "summary.json"
                if d.is_dir() and not d.name.startswith("_") and f.exists():
                    try:
                        out.append(json.loads(f.read_text("utf-8")))
                    except Exception:
                        pass
        return out

    def _write_history_csv(self):
        """Une ligne par nuit, pour Excel : Bureau/Visual Singer/sommeil/historique.csv"""
        nights = self._list_nights()
        cols = ["id", "debut", "fin", "duree_enregistrement_min", "endormissement", "reveil",
                "latence_min", "sommeil_min", "efficacite_pct", "reveils", "eveil_intra_min",
                "ronflement_pct", "ronflements", "pauses_suspectes", "pauses_par_heure", "pause_max_s",
                "toux", "eternuements", "paroles", "vocalisations", "machoire", "mouvements",
                "agitation_par_heure", "bruits_exterieurs", "niveau_median_db", "rythme_resp_moyen"]
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=";")
        w.writerow(cols)
        for n in nights:
            row = n.get("csv") or {}
            w.writerow([row.get(c, "") for c in cols])
        (self.data_dir / "sommeil" / "historique.csv").write_text(buf.getvalue(), encoding="utf-8-sig")

    def do_DELETE(self):
        if not self._same_origin():
            return self._json({"error": "origine refusée"}, 403)
        if urlparse(self.path).path != "/api/sleep/night":
            return self._json({"error": "introuvable"}, 404)
        night_dir = self._night_dir()
        if not night_dir or not night_dir.exists():
            return self._json({"error": "nuit introuvable"}, 404)
        # Pas de suppression définitive : la nuit part dans sommeil/_corbeille.
        trash = self.data_dir / "sommeil" / "_corbeille"
        trash.mkdir(parents=True, exist_ok=True)
        trashed = f"{night_dir.name}__{datetime.now():%H%M%S}"
        os.replace(night_dir, trash / trashed)
        self._write_history_csv()
        return self._json({"ok": True, "trash": trashed})

    def do_PUT(self):
        if not self._same_origin():
            return self._json({"error": "origine refusée"}, 403)
        if urlparse(self.path).path == "/api/sleep/night":
            night_dir = self._night_dir()
            if not night_dir:
                return self._json({"error": "identifiant invalide"}, 400)
            try:
                data = json.loads(self._body() or b"{}")
                night_dir.mkdir(parents=True, exist_ok=True)
                tmp = night_dir / "night.json.tmp"
                tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), "utf-8")
                os.replace(tmp, night_dir / "night.json")
                (night_dir / "summary.json").write_text(json.dumps(data.get("summary") or {"id": night_dir.name}, ensure_ascii=False, indent=1), "utf-8")
                if data.get("end"):
                    self._write_history_csv()
                return self._json({"ok": True})
            except Exception as e:
                return self._json({"error": str(e)}, 400)
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
            if url.path == "/api/shutdown":
                # Bouton « Quitter le logiciel » : réponse immédiate puis arrêt du serveur.
                body = json.loads(self._body() or b"{}")
                if body.get("ollama"):
                    stop_ollama()
                self._json({"ok": True})
                threading.Timer(0.3, lambda: os._exit(0)).start()
                return None
            if url.path == "/api/sleep/restore":
                # Action « Annuler » après une mise à la corbeille.
                name = str(json.loads(self._body() or b"{}").get("trash", ""))
                if not re.fullmatch(r"[\w\-]+__\d{6}", name):
                    return self._json({"error": "nom invalide"}, 400)
                src = self.data_dir / "sommeil" / "_corbeille" / name
                dst = self.data_dir / "sommeil" / name.rsplit("__", 1)[0]
                if not src.exists():
                    return self._json({"error": "introuvable dans la corbeille"}, 404)
                if dst.exists():
                    return self._json({"error": "une nuit porte déjà ce nom"}, 409)
                os.replace(src, dst)
                self._write_history_csv()
                return self._json({"ok": True})
            if url.path == "/api/detection":
                return self._json(self._save_detection(json.loads(self._body())))
            if url.path == "/api/sleep/clip":
                night_dir = self._night_dir()
                if not night_dir:
                    return self._json({"error": "identifiant invalide"}, 400)
                name = safe_name(self.headers.get("X-Clip-Name", "son"), 90)
                folder = night_dir / "extraits"
                folder.mkdir(parents=True, exist_ok=True)
                target = folder / f"{name}.wav"
                target.write_bytes(self._body())
                return self._json({"ok": True, "file": f"sommeil/{night_dir.name}/extraits/{target.name}"})
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
    ap = argparse.ArgumentParser(description="Visual Singer - serveur local")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--data", default=os.environ.get("VS_DATA_DIR"))
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--sommeil", action="store_true", help="ouvrir l'application Sommeil")
    args = ap.parse_args()

    data_dir = Path(args.data) if args.data else desktop_dir() / "Visual Singer"
    for sub in ("", "detections", "extraits", "sommeil"):
        (data_dir / sub).mkdir(parents=True, exist_ok=True)
    Handler.data_dir = data_dir
    Handler.extensions_map.update({".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm"})

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://localhost:{args.port}"
    print(f"Visual Singer  ->  {url}")
    print(f"Sauvegardes    ->  {data_dir}")
    print("Ctrl+C pour arrêter.")
    if not args.no_browser:
        webbrowser.open(url + ("/sommeil.html" if args.sommeil else "/"))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
