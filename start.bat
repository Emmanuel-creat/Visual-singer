@echo off
cd /d "%~dp0"
echo Visual Singer - les sauvegardes vont dans "Bureau\Visual Singer"
python server.py
if errorlevel 1 pause
