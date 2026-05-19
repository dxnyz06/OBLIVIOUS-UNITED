@echo off
title OBLIVIOUS SETUP DEV
set "EXE=%~dp0..\build\electron\setup-dev\OBLIVIOUS SETUP DEV.exe"
if exist "%EXE%" (
  start "" "%EXE%"
  exit /b 0
)
echo.
echo  [ERRORE] Non trovo la GUI packaged:
echo    %EXE%
echo.
echo  Genera gli eseguibili con uno di questi metodi:
echo    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0packaging\build-vps.ps1" -SkipElectronRebuild -SkipMaven
echo    oppure da workspace\oblivious-setup : npm install ^&^& npm run build:dev
echo.
pause
exit /b 1
