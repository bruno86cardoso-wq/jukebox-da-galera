@echo off
chcp 65001 >nul
title To na Fila - YouTube Music
cd /d "%~dp0"
echo ====================================================
echo   Iniciando Telao / To na Fila...
echo ====================================================
start "" "http://localhost:3456/tv"
node server.js
pause
