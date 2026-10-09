@echo off
rem Visual Singer - accueil (fenetre native ; les services locaux demarrent tout seuls)
cd /d "%~dp0"
start "" pythonw app.py --app accueil
