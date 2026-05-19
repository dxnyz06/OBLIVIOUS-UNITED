@echo off
cd /d "%~dp0"
where node >nul 2>&1 || (echo Install Node.js LTS & pause & exit /b 1)
node "%~dp0license-check.js" %*
