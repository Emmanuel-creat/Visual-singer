"""Lance le moteur d'analyse de cours : http://127.0.0.1:8091/cours.html

    .venv\\Scripts\\python run.py            (normalement lancé par app.py --app cours)
"""
import sys
import webbrowser

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

from coursia.config import DATA_DIR, HOST, PORT  # noqa: E402  (fixe aussi les dossiers de modèles)

if __name__ == "__main__":
    import uvicorn
    url = f"http://{HOST}:{PORT}/cours.html"
    print(f"Visual Singer - Cours  ->  {url}")
    print(f"Données               ->  {DATA_DIR}")
    if "--no-browser" not in sys.argv:
        # app.py lance aussi le serveur des pages (port 8080, sauvegardes Bureau) :
        # on ouvre la page servie par lui s'il répond, sinon celle du moteur.
        import threading
        import urllib.request

        def _open():
            target = url
            try:
                urllib.request.urlopen("http://127.0.0.1:8080/api/info", timeout=2)
                target = "http://localhost:8080/cours.html"
            except Exception:
                pass
            webbrowser.open(target)
        threading.Timer(1.5, _open).start()
    uvicorn.run("coursia.api:app", host=HOST, port=PORT, log_level="warning", workers=1)
