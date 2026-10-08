@echo off
rem Visual Singer - Cours : moteur d'analyse local (http://127.0.0.1:8091/cours.html)
cd /d "%~dp0"
if not exist "cours_engine\.venv\Scripts\python.exe" (
  echo Environnement Python absent : lancez d'abord install-cours.bat
  pause
  exit /b 1
)
rem Demarre Ollama s'il ne tourne pas deja (sans effet sinon)
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" start "" /min "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve
"cours_engine\.venv\Scripts\python.exe" "cours_engine\run.py"
if errorlevel 1 pause
