"""Lance le moteur d'analyse de cours : http://127.0.0.1:8091/cours.html

    .venv\\Scripts\\python run.py            (ou start-cours.bat à la racine)
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
    print(f"Visual Singer — Cours  ->  {url}")
    print(f"Données               ->  {DATA_DIR}")
    if "--no-browser" not in sys.argv:
        webbrowser.open(url)
    uvicorn.run("coursia.api:app", host=HOST, port=PORT, log_level="warning", workers=1)
