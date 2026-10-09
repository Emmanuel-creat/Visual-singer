"""Visual Singer — application de bureau (fenêtres natives, sans navigateur).

    pythonw app.py --app accueil | detecteur | sommeil | cours

Chaque application s'ouvre dans sa propre fenêtre Windows (pywebview, moteur Edge WebView2),
avec son icône dans la barre des tâches. Le lanceur démarre en arrière-plan, sans console :
  - le serveur des pages et des sauvegardes Bureau (server.py, port 8080) ;
  - pour Cours : Ollama (s'il ne tourne pas) et le moteur d'analyse (cours_engine, port 8091).
Fermer la dernière fenêtre arrête ces services ; le bouton « Quitter » ferme tout.
Raccourcis du Bureau : creer-raccourcis.bat.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import logging
import os
import subprocess
import sys
import threading
import time
import urllib.request
from ctypes import wintypes
from pathlib import Path

import webview

ROOT = Path(__file__).resolve().parent
ICONS = ROOT / "assets" / "icons"
PAGES = "http://localhost:8080"
ENGINE = "http://127.0.0.1:8091"
OLLAMA = "http://127.0.0.1:11434"
STATE_DIR = Path(os.environ.get("LOCALAPPDATA", ROOT)) / "Visual Singer"
LOG_DIR = STATE_DIR / "logs"
OLLAMA_FLAG = STATE_DIR / "ollama-demarre-par-visual-singer"
TITLE_PREFIX = "Visual Singer"
log = logging.getLogger("visual-singer")

APPS = {
    #  nom          titre de la fenêtre                 page              taille        taille min
    "accueil":   ("Visual Singer",                    "index.html",     (1280, 860), (900, 600)),
    "detecteur": ("Visual Singer — Détecteur",        "detecteur.html", (1600, 940), (1000, 640)),
    "sommeil":   ("Visual Singer — Sommeil",          "sommeil.html",   (1440, 900), (900, 600)),
    "cours":     ("Visual Singer — Cours",            "cours.html",     (1600, 940), (1000, 640)),
}
PAGE_TO_APP = {page: name for name, (_, page, _, _) in APPS.items()}

CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
user32 = ctypes.windll.user32


# ----------------------------------------------------------------------------- HTTP
def get_json(url: str, timeout: float = 1.0):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return json.loads(r.read() or b"null")
    except Exception:
        return None


def post_json(url: str, body: dict, timeout: float = 2.0) -> bool:
    try:
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        urllib.request.urlopen(req, timeout=timeout).read()
        return True
    except Exception:
        return False


def wait_for(url: str, seconds: float) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        if get_json(url) is not None:
            return True
        time.sleep(0.4)
    return False


# --------------------------------------------------------------------- services
def console_python() -> str:
    """python.exe à côté de pythonw.exe : les services écrivent leur journal dans un fichier."""
    exe = Path(sys.executable)
    alt = exe.with_name("python.exe")
    return str(alt if exe.name.lower() == "pythonw.exe" and alt.exists() else exe)


def spawn(args: list[str], log_name: str) -> None:
    """Processus d'arrière-plan sans fenêtre, indépendant du lanceur."""
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log = open(LOG_DIR / log_name, "a", encoding="utf-8", errors="replace")
    log.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} : {' '.join(args)}\n")
    log.flush()
    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"}
    base = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    for flags in (base | CREATE_BREAKAWAY_FROM_JOB, base):   # sortir du job du lanceur si Windows l'autorise
        try:
            subprocess.Popen(args, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                             creationflags=flags, env=env, close_fds=True)
            return
        except OSError:
            continue


def ensure_pages(status) -> bool:
    if get_json(f"{PAGES}/api/info"):
        return True
    status("Démarrage du serveur local…")
    spawn([console_python(), str(ROOT / "server.py"), "--no-browser"], "pages.log")
    return wait_for(f"{PAGES}/api/info", 15)


def ensure_ollama(status) -> None:
    if get_json(f"{OLLAMA}/api/version"):
        return
    exe = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe"
    if not exe.exists():
        return
    status("Démarrage d'Ollama (modèles de langage locaux)…")
    spawn([str(exe), "serve"], "ollama.log")
    if wait_for(f"{OLLAMA}/api/version", 20):
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        OLLAMA_FLAG.write_text(time.strftime("%Y-%m-%d %H:%M:%S"), "utf-8")


def ensure_engine(status) -> bool:
    if get_json(f"{ENGINE}/api/system", 3):
        return True
    py = ROOT / "cours_engine" / ".venv" / "Scripts" / "python.exe"
    if not py.exists():
        status("Moteur d'analyse non installé : lancez install-cours.bat.")
        time.sleep(2.5)
        return False
    status("Démarrage du moteur d'analyse (GPU)…")
    spawn([str(py), str(ROOT / "cours_engine" / "run.py"), "--no-browser"], "cours.log")
    return wait_for(f"{ENGINE}/api/system", 120)


def stop_services(stop_ollama: bool | None = None) -> None:
    """Dernière fenêtre fermée : arrêt du moteur Cours puis du serveur des pages."""
    log.info("arrêt des services (ollama=%s)", stop_ollama)
    if stop_ollama is None:
        stop_ollama = OLLAMA_FLAG.exists()
    engine_up = get_json(f"{ENGINE}/api/system")
    if engine_up:
        post_json(f"{ENGINE}/api/shutdown", {"ollama": stop_ollama})
    post_json(f"{PAGES}/api/shutdown", {"ollama": bool(stop_ollama and not engine_up)})
    if stop_ollama:
        OLLAMA_FLAG.unlink(missing_ok=True)


# ---------------------------------------------------------------- fenêtres Windows
def app_windows(exclude_pid: int | None = None) -> list[int]:
    """Fenêtres Visual Singer ouvertes (pywebview = classe WindowsForms ; ignore l'Explorateur)."""
    found: list[int] = []
    pid = wintypes.DWORD()
    buf = ctypes.create_unicode_buffer(256)
    cls = ctypes.create_unicode_buffer(256)

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            user32.GetWindowTextW(hwnd, buf, 256)
            user32.GetClassNameW(hwnd, cls, 256)
            if buf.value.startswith(TITLE_PREFIX) and cls.value.startswith("WindowsForms10"):
                user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
                if pid.value != exclude_pid:
                    found.append(hwnd)
        return True

    user32.EnumWindows(cb, 0)
    return found


def find_window(title: str) -> int | None:
    for hwnd in app_windows():
        buf = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, buf, 256)
        if buf.value == title:
            return hwnd
    return None


def focus(hwnd: int) -> None:
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)   # SW_RESTORE
    user32.SetForegroundWindow(hwnd)


class _GUID(ctypes.Structure):
    _fields_ = [("d1", wintypes.DWORD), ("d2", wintypes.WORD), ("d3", wintypes.WORD), ("d4", ctypes.c_ubyte * 8)]

    def __init__(self, text: str):
        import uuid
        u = uuid.UUID(text)
        super().__init__(u.time_low, u.time_mid, u.time_hi_version, (ctypes.c_ubyte * 8)(*u.bytes[8:]))


class _PROPERTYKEY(ctypes.Structure):
    _fields_ = [("fmtid", _GUID), ("pid", wintypes.DWORD)]


class _PROPVARIANT(ctypes.Structure):   # VT_LPWSTR uniquement (24 octets en x64)
    _fields_ = [("vt", ctypes.c_ushort), ("r1", ctypes.c_ushort), ("r2", ctypes.c_ushort), ("r3", ctypes.c_ushort),
                ("pwsz", ctypes.c_wchar_p), ("pad", ctypes.c_void_p)]


def set_window_identity(hwnd: int, app: str, title: str, ico: Path) -> None:
    """Identité de la fenêtre dans la barre des tâches : bouton distinct par application,
    icône et commande de relance propres (épinglage). Python du Store ignore l'identifiant
    défini pour le processus, d'où ces propriétés posées directement sur la fenêtre."""
    try:
        ctypes.windll.ole32.CoInitialize(None)
        store = ctypes.c_void_p()
        iid = _GUID("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")   # IID_IPropertyStore
        if ctypes.windll.shell32.SHGetPropertyStoreForWindow(wintypes.HWND(hwnd), ctypes.byref(iid), ctypes.byref(store)):
            return
        vtbl = ctypes.cast(ctypes.cast(store, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
        set_value = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p, ctypes.POINTER(_PROPERTYKEY), ctypes.POINTER(_PROPVARIANT))(vtbl[6])
        commit = ctypes.WINFUNCTYPE(ctypes.HRESULT, ctypes.c_void_p)(vtbl[7])
        release = ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(vtbl[2])
        fmtid = _GUID("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3")   # PKEY_AppUserModel_*
        pyw = Path(sys.executable).with_name("pythonw.exe")
        values = (
            (2, f'"{pyw if pyw.exists() else sys.executable}" "{ROOT / "app.py"}" --app {app}'),   # RelaunchCommand
            (3, f"{ico},0"),                                                                     # RelaunchIconResource
            (4, title),                                                                          # RelaunchDisplayNameResource
            (5, f"VisualSinger.{app}"),                                                          # ID (en dernier)
        )
        for pid, text in values:
            key = _PROPERTYKEY(fmtid, pid)
            var = _PROPVARIANT(31, 0, 0, 0, text, None)   # VT_LPWSTR
            set_value(store, ctypes.byref(key), ctypes.byref(var))
        commit(store)
        release(store)
    except Exception:
        log.exception("identité de fenêtre non appliquée")


def set_window_icon(hwnd: int, ico: Path) -> None:
    """Icône de la fenêtre et de la barre des tâches (sinon celle de Python)."""
    for size, which in ((256, 1), (32, 0)):   # ICON_BIG, ICON_SMALL
        h = user32.LoadImageW(None, str(ico), 1, size, size, 0x10)
        if h:
            user32.SendMessageW(hwnd, 0x80, which, h)


def wait_hwnd(title: str, seconds: float = 10) -> int | None:
    end = time.time() + seconds
    while time.time() < end:
        hwnd = user32.FindWindowW(None, title)
        if hwnd:
            return hwnd
        time.sleep(0.05)
    return None


def allow_local_media() -> None:
    """Micro / caméra autorisés d'office pour les pages locales (sinon WebView2 demande à chaque fois)."""
    try:
        from webview.platforms import edgechromium
        from Microsoft.Web.WebView2.Core import CoreWebView2PermissionState  # type: ignore
    except Exception:
        return
    original = edgechromium.EdgeChrome.on_webview_ready

    def on_permission(sender, args):
        uri = str(args.Uri)
        if uri.startswith(("http://localhost:", "http://127.0.0.1:")):
            args.State = CoreWebView2PermissionState.Allow

    def on_ready(self, sender, args):
        original(self, sender, args)
        if args.IsSuccess:
            sender.CoreWebView2.PermissionRequested += on_permission

    edgechromium.EdgeChrome.on_webview_ready = on_ready


# --------------------------------------------------------------------- API JS
class Api:
    """Exposée aux pages : window.pywebview.api.*"""

    def __init__(self, app: str):
        self._app = app
        self._window = None
        self._busy = None          # message si la page a une activité à protéger (enregistrement de nuit…)
        self._force = False

    def is_desktop(self):
        return True

    def open_app(self, name: str):
        """Ouvre (ou met au premier plan) la fenêtre d'une autre application."""
        log.info("open_app(%s)", name)
        name = PAGE_TO_APP.get(name, name)
        if name not in APPS:
            return False
        if name == self._app:
            return True
        hwnd = find_window(APPS[name][0])
        if hwnd:
            focus(hwnd)
        else:
            try:
                subprocess.Popen([sys.executable, str(ROOT / "app.py"), "--app", name], cwd=ROOT)
            except OSError:
                log.exception("ouverture de %s impossible", name)
                return False
        return True

    def set_busy(self, message=None):
        self._busy = message or None
        return True

    def close_window(self):
        """Fermeture confirmée par la page (après sauvegarde)."""
        self._force = True
        if not app_windows(exclude_pid=os.getpid()):
            stop_services()
        self._window.destroy()
        return True

    def close_all(self):
        """Après « Quitter le logiciel » (services déjà arrêtés par la page) : ferme toutes les fenêtres."""
        for hwnd in app_windows(exclude_pid=os.getpid()):
            user32.PostMessageW(hwnd, 0x0010, 0, 0)   # WM_CLOSE
        self._force = True
        threading.Timer(0.2, self._window.destroy).start()
        return True


# ---------------------------------------------------------------------- pages
LOADING = """<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>
html,body{{margin:0;height:100%;background:#2a2b2f;color:#e4e4e7;font:16px/1.6 "Segoe UI",system-ui,sans-serif}}
body{{display:grid;place-items:center}} main{{text-align:center}} h1{{font-size:1.3rem;font-weight:600;margin:16px 0 4px}}
p{{color:#c1c1c5;margin:0}} .s{{width:36px;height:36px;margin:auto;border-radius:50%;border:3px solid #44454b;border-top-color:{color};animation:r 1s linear infinite}}
@keyframes r{{to{{transform:rotate(360deg)}}}} @media (prefers-reduced-motion:reduce){{.s{{animation:none}}}}
</style></head><body><main><div class="s" aria-hidden="true"></div><h1>{title}</h1><p id="st" role="status">Démarrage…</p></main></body></html>"""
COLORS = {"accueil": "#9085e9", "detecteur": "#ff4d3d", "sommeil": "#3987e5", "cours": "#c4851a"}


def main() -> None:
    ap = argparse.ArgumentParser(description="Visual Singer — application de bureau")
    ap.add_argument("--app", choices=list(APPS), default="accueil")
    ap.add_argument("--debug", action="store_true")
    args = ap.parse_args()
    app = args.app
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=LOG_DIR / "app.log", level=logging.INFO, encoding="utf-8",
                        format=f"%(asctime)s [{app}] %(levelname)s %(name)s: %(message)s")
    log.info("lancement (%s)", sys.executable)
    title, page, size, min_size = APPS[app]

    # Une seule fenêtre par application : un second lancement la remet au premier plan.
    existing = find_window(title)
    if existing:
        focus(existing)
        return

    try:   # regroupement et icône propres dans la barre des tâches
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(f"VisualSinger.{app}")
    except (AttributeError, OSError):
        pass

    webview.settings["ALLOW_DOWNLOADS"] = True            # exports Word / PDF / CSV : boîte « Enregistrer sous »
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    allow_local_media()

    api = Api(app)
    window = webview.create_window(
        title, html=LOADING.format(title=title, color=COLORS[app]), js_api=api,
        width=size[0], height=size[1], min_size=min_size, background_color="#2a2b2f", text_select=True,
        hidden=True)   # affichée après avoir reçu son identité (icône, bouton de barre des tâches)
    api._window = window

    def status(text: str) -> None:
        log.info("statut : %s", text)
        try:
            window.evaluate_js(f"document.getElementById('st') && (document.getElementById('st').textContent = {json.dumps(text)})")
        except Exception:
            pass

    def boot():
        ico = ICONS / f"{app}.ico"
        hwnd = wait_hwnd(title)
        if hwnd:
            set_window_identity(hwnd, app, title, ico)
            set_window_icon(hwnd, ico)
        window.show()
        if not ensure_pages(status):
            status(f"Le serveur local ne démarre pas. Journal : {LOG_DIR / 'pages.log'}")
            return
        if app == "cours":
            ensure_ollama(status)
            if not ensure_engine(status):
                status("Le moteur d'analyse ne répond pas ; la page s'ouvre quand même.")
                time.sleep(1.5)
        log.info("chargement de %s", page)
        window.load_url(f"{PAGES}/{page}")

    def on_closing():
        log.info("fermeture demandée (force=%s, occupé=%s)", api._force, api._busy)
        if api._force:
            return True
        if api._busy:
            # evaluate_js attend le thread graphique : ne pas l'appeler depuis ce gestionnaire.
            threading.Thread(target=window.evaluate_js, args=("window.vsRequestClose && window.vsRequestClose(false)",),
                             daemon=True).start()
            return False
        if not app_windows(exclude_pid=os.getpid()):
            sys_info = get_json(f"{ENGINE}/api/system", 0.8)
            if sys_info and (sys_info.get("runner") or {}).get("current"):
                threading.Thread(target=window.evaluate_js, args=("window.vsRequestClose && window.vsRequestClose(true)",),
                                 daemon=True).start()
                return False
            stop_services()
        return True

    window.events.closing += on_closing
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    webview.start(boot, gui="edgechromium", private_mode=False, debug=args.debug,
                  storage_path=str(STATE_DIR / "webview"))


if __name__ == "__main__":
    main()
