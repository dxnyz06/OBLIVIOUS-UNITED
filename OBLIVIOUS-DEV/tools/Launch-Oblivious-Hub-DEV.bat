@echo off
title OBLIVIOUS HUB (DEV build)
set "ROOT=%~dp0..\..\"
set "HUB=%ROOT%oblivious-hub\dist\win-unpacked\Oblivious Hub.exe"
if exist "%HUB%" (
  start "" "%HUB%"
  exit /b 0
)
echo Packaged hub not found at:
echo   %HUB%
echo Starting from source (npm run start). Install deps in oblivious-hub first.
cd /d "%ROOT%oblivious-hub"
call npm run start
if errorlevel 1 pause
