@echo off
rem Visual Singer : cree les raccourcis du Bureau et du menu Demarrer (une fenetre par application)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "tools\creer-raccourcis.ps1"
pause
