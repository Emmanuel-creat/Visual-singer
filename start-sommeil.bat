@echo off
cd /d "%~dp0"
echo Visual Singer - Sommeil : les nuits sont enregistrees dans "Bureau\Visual Singer\sommeil"
python server.py --sommeil
if errorlevel 1 pause
