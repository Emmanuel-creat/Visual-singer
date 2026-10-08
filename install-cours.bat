@echo off
rem Installation du moteur d'analyse de cours (une seule fois : ~11 Go + modeles LLM ~29 Go)
cd /d "%~dp0cours_engine"
where uv >nul 2>nul || (
  echo Installation de uv...
  powershell -ExecutionPolicy Bypass -c "irm https://astral.sh/uv/install.ps1 | iex"
  set "PATH=%USERPROFILE%\.local\bin;%PATH%"
)
uv venv --native-tls --python 3.12 .venv || goto :err
uv pip install --native-tls -p .venv torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128 || goto :err
uv pip install --native-tls -p .venv -r requirements.txt -c constraints.txt --extra-index-url https://download.pytorch.org/whl/cu128 --index-strategy unsafe-best-match || goto :err
".venv\Scripts\python.exe" prefetch.py || goto :err
where ollama >nul 2>nul || winget install --id Ollama.Ollama -e --source winget --accept-source-agreements --accept-package-agreements
set "OLLAMA=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
start "" /min "%OLLAMA%" serve
timeout /t 5 >nul
"%OLLAMA%" pull qwen3.5:9b
"%OLLAMA%" pull qwen3.5:35b-a3b
echo.
echo Installation terminee. Lancez start-cours.bat
pause
exit /b 0
:err
echo Echec de l'installation.
pause
exit /b 1
