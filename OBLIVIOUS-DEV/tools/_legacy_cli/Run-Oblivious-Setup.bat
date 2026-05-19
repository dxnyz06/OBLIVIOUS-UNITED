@echo off
REM ====================================================================
REM LEGACY CLI - NON e' la UX utente.
REM UX ufficiale: ..\..\build\electron\setup-dev\OBLIVIOUS SETUP DEV.exe
REM Questo wrapper resta solo come fallback tecnico (debug / headless).
REM ====================================================================
title OBLIVIOUS (legacy CLI) Config Wizard
cd /d "%~dp0..\operator"
where node >nul 2>&1 || (
  echo Install Node.js LTS from https://nodejs.org
  pause
  exit /b 1
)
node "%~dp0..\operator\oblivious-setup.js"
if errorlevel 1 pause
