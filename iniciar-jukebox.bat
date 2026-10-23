@echo off
chcp 65001 >nul
title Jukebox da Galera - YouTube Music
cd /d "%~dp0"
echo ====================================================
echo   Iniciando Telao / Jukebox da Galera...
echo ====================================================
start "" "http://localhost:3456/tv"
node server.js
pause
