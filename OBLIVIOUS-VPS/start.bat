@echo off
REM OBLIVIOUS-VPS — portable launcher.
REM
REM Pins config / licenses to their canonical sub-folders so the
REM packaged hub finds them regardless of where the bundle is copied.

setlocal
set "OBLIVIOUS_CONFIG_DIR=%~dp0config"
set "OBLIVIOUS_LICENSES_DIR=%~dp0licenses"
set "OBLIVIOUS_LICENSE_REQUIRED=true"

REM Optional: enable verbose logs
REM set "ELECTRON_ENABLE_LOGGING=1"

start "" "%~dp0app\Oblivious Hub.exe"
endlocal
