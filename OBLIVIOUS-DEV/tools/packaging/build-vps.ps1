# OBLIVIOUS - build-vps.ps1
#
# Rebuild the OBLIVIOUS-VPS bundle from the canonical sources at the
# workspace root.  Idempotent: nukes the destination subfolders first,
# then copies the freshly built artifacts.
#
# Run from Windows PowerShell:
#   powershell -ExecutionPolicy Bypass -File OBLIVIOUS-DEV\tools\packaging\build-vps.ps1
#
# Optional: pass explicit workspace root if needed:
#   powershell ... -File ...\build-vps.ps1 -Root "D:\path\to\OBLIVIOUS UNITED"
#
# Pre-requisites already on the box: Node.js, Maven, JDK, MetaEditor.

[CmdletBinding()]
param(
    # Workspace root (folder that contains OBLIVIOUS-DEV, oblivious-hub, OBLIVIOUS-VPS). Leave empty for auto-detect.
    [string]$Root = "",
    # Skip electron-builder when dist\win-unpacked already exists (CI locale / rebuild ripetuti).
    [switch]$SkipElectronRebuild,
    # Skip Maven when shaded jar already exists in target/.
    [switch]$SkipMaven,
    # Operator-tools-only (+ README/.bat); skips regenerating app\ and bridge\.
    [switch]$OperatorToolsOnly,
    # Skip obr_setup Electron builds (DEV+VPS setup GUIs).
    [switch]$SkipSetupRebuild
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Root) {
    $Root = (Get-Item -LiteralPath (Join-Path $scriptDir '..\..\..')).FullName
}
$root = $Root.TrimEnd('\')
$vps  = Join-Path $root 'OBLIVIOUS-VPS'

function Log($msg) { Write-Host "[build-vps] $msg" }

function Sync-OperatorTools() {
    # VPS bundle: GUI (OBLIVIOUS SETUP VPS.exe) is the official UX.
    # Here we ship only the small backend utilities needed for license / device-id
    # operations that the GUI does not cover. NO setup wizard CLI, NO config-manager
    # CLI: those are replaced by OBLIVIOUS SETUP VPS.exe.
    Log "sync runtime\operator-tools (device-id / license-check + vendor/*.js)"
    $opRoot = Join-Path $root 'OBLIVIOUS-DEV\tools\operator'
    $opDst  = Join-Path $vps 'runtime\operator-tools'
    New-Item -ItemType Directory -Force (Join-Path $opDst 'lib') | Out-Null
    New-Item -ItemType Directory -Force (Join-Path $opDst 'vendor') | Out-Null
    foreach ($f in @('device-id.js', 'license-check.js')) {
        Copy-Item (Join-Path $opRoot $f) $opDst -Force
    }
    Copy-Item (Join-Path $opRoot 'lib\resolve-services.js') (Join-Path $opDst 'lib') -Force
    foreach ($svc in @('KeyVault.js', 'DeviceId.js', 'Licensing.js')) {
        Copy-Item "$root\oblivious-hub\src\services\$svc" (Join-Path $opDst 'vendor') -Force
    }
    # Remove any legacy CLI launchers that previous builds created here.
    foreach ($legacy in @('Run-Config-Manager.bat', 'Run-Oblivious-Setup.bat', 'oblivious-config.js', 'oblivious-setup.js')) {
        $p = Join-Path $opDst $legacy
        if (Test-Path $p) { Remove-Item $p -Force -ErrorAction SilentlyContinue }
    }
    $batDir = $opDst
    $devBat = @'
@echo off
cd /d "%~dp0"
where node >nul 2>&1 || (echo Install Node.js LTS & pause & exit /b 1)
node "%~dp0device-id.js" %*
'@
    $licBat = @'
@echo off
cd /d "%~dp0"
where node >nul 2>&1 || (echo Install Node.js LTS & pause & exit /b 1)
node "%~dp0license-check.js" %*
'@
    Set-Content -Encoding ascii (Join-Path $batDir 'Run-Device-ID.bat') $devBat
    Set-Content -Encoding ascii (Join-Path $batDir 'Run-License-Check.bat') $licBat
@"
OBLIVIOUS-VPS/runtime/operator-tools/

UX UFFICIALE per password e API key sul VPS:
  ..\setup-vps\OBLIVIOUS SETUP VPS.exe   (GUI Electron)

Questa cartella contiene SOLO utilita' minori non coperte dalla GUI:

  Run-Device-ID.bat     -> stampa il device_id da inviare al licensing operator
  Run-License-Check.bat -> verifica license.lic + public_key.pem

NON contiene piu':
  Run-Oblivious-Setup.bat  (rimpiazzato da OBLIVIOUS SETUP VPS.exe)
  Run-Config-Manager.bat   (rimpiazzato da OBLIVIOUS SETUP VPS.exe)
  oblivious-setup.js       (wizard CLI archiviato)
  oblivious-config.js      (CLI di config; resta in OBLIVIOUS-DEV/tools/_legacy_cli/)

Requires: Node.js LTS in PATH (per device-id / license-check).

Vendor/*.js sono copie verbatim da oblivious-hub/src/services per installazioni VPS offline.
"@ | Set-Content (Join-Path $opDst 'README.txt')
}

if ($OperatorToolsOnly) {
    Sync-OperatorTools
    Log "OK - operator-tools only at $vps\runtime\operator-tools"
    exit 0
}

# 1. Electron - npm run build (NSIS + win-unpacked)
$distUnpacked = Join-Path $root 'oblivious-hub\dist\win-unpacked'
if (-not $SkipElectronRebuild) {
    Log "rebuilding Electron hub..."
    Push-Location (Join-Path $root 'oblivious-hub')
    try { npx electron-builder --win --x64 | Out-Null } finally { Pop-Location }
} else {
    Log "SkipElectronRebuild - expecting existing dist\win-unpacked"
    if (-not (Test-Path (Join-Path $distUnpacked 'Oblivious Hub.exe'))) {
        throw "Missing Oblivious Hub.exe under oblivious-hub\dist\win-unpacked - run without -SkipElectronRebuild."
    }
}

# 2. Bookmap plugin - mvn package (only if SDK jars are in lib/)
$pomLib = Join-Path $root 'bookmap-plugin\lib\bm-l1api.jar'
if (-not $SkipMaven) {
    if (Test-Path $pomLib) {
        Log "rebuilding Bookmap plugin..."
        Push-Location (Join-Path $root 'bookmap-plugin')
        try { mvn -B package | Out-Null } finally { Pop-Location }
    } else {
        Log "Bookmap SDK absent - skipping mvn (last shaded jar will be reused)"
    }
} else {
    Log "SkipMaven - expecting existing bookmap-plugin\target\oblivious-bookmap-bridge-1.0.0.jar"
    $jarExpect = Join-Path $root 'bookmap-plugin\target\oblivious-bookmap-bridge-1.0.0.jar'
    if (-not (Test-Path $jarExpect)) { throw "Missing shaded jar - run without -SkipMaven or build plugin once." }
}

# 3. Refresh OBLIVIOUS-VPS subfolders.
Log "refreshing OBLIVIOUS-VPS/app  (full Electron unpacked)"
Remove-Item "$vps\app\*" -Recurse -Force -ErrorAction SilentlyContinue
robocopy "$distUnpacked" "$vps\app" /MIR /NFL /NDL /NJS /NJH /NP | Out-Null

Log "refreshing OBLIVIOUS-VPS/bridge"
Copy-Item "$root\OBLIVIOUS_COMPLETE.ex4" "$vps\bridge\OBLIVIOUS_COMPLETE.ex4" -Force
# VPS runtime MT4 side uses `.ex4` only. Do NOT ship `OBLIVIOUS_COMPLETE.mq4`
# on the VPS bundle - canonical MQ4 source is workspace root; archived copies live under `OBLIVIOUS-DEV/build/mq4/`.
$jarSrc = Join-Path $root 'bookmap-plugin\target\oblivious-bookmap-bridge-1.0.0.jar'
if (-not (Test-Path $jarSrc)) {
    throw "Missing shaded Bookmap jar: $jarSrc  (run mvn -B package in bookmap-plugin/, or use -SkipMaven only after jar exists)."
}
Copy-Item $jarSrc "$vps\bridge\oblivious-bookmap-bridge-1.0.0.jar" -Force
foreach ($lib in @("libzmq.dll","libsodium.dll")) {
    Copy-Item "$root\mql-zmq-bundle\Library\$lib" "$vps\bridge\mt4-zmq-libs\Libraries\" -Force
}
Get-ChildItem "$root\mql-zmq-bundle\Include\Zmq" |
    ForEach-Object { Copy-Item $_.FullName "$vps\bridge\mt4-zmq-libs\Include\Zmq\" -Force }

# 3b. Oblivious Setup Electron apps (DEV + VPS profiles) — GUI operator vault tools
if (-not $SkipSetupRebuild) {
    Log "building Oblivious Setup (electron-builder DEV + VPS)..."
    $setupRoot = Join-Path $root 'oblivious-setup'
    Push-Location $setupRoot
    try {
        npm install --no-audit --no-fund 2>$null | Out-Null
        if (-not $?) { npm install | Out-Null }
        npx electron-builder --win --x64 --config electron-builder-vps.json | Out-Null
        npx electron-builder --win --x64 --config electron-builder-dev.json | Out-Null
    }
    finally { Pop-Location }

    $setupVpsSrc = Join-Path $setupRoot 'dist-vps\win-unpacked'
    $setupVpsDst = Join-Path $vps 'runtime\setup-vps'
    if (Test-Path $setupVpsSrc) {
        Log "refreshing OBLIVIOUS-VPS/runtime/setup-vps"
        New-Item -ItemType Directory -Force $setupVpsDst | Out-Null
        Remove-Item "$setupVpsDst\*" -Recurse -Force -ErrorAction SilentlyContinue
        robocopy $setupVpsSrc $setupVpsDst /MIR /NFL /NDL /NJS /NJH /NP | Out-Null
    }
    else {
        Log "WARN: missing VPS setup build output at $setupVpsSrc"
    }

    $setupDevSrc = Join-Path $setupRoot 'dist-dev\win-unpacked'
    $setupDevDst = Join-Path $root 'OBLIVIOUS-DEV\build\electron\setup-dev'
    if (Test-Path $setupDevSrc) {
        Log "refreshing OBLIVIOUS-DEV/build/electron/setup-dev"
        New-Item -ItemType Directory -Force $setupDevDst | Out-Null
        Remove-Item "$setupDevDst\*" -Recurse -Force -ErrorAction SilentlyContinue
        robocopy $setupDevSrc $setupDevDst /MIR /NFL /NDL /NJS /NJH /NP | Out-Null
    }
    else {
        Log "WARN: missing DEV setup build output at $setupDevSrc"
    }
}
else {
    Log "SkipSetupRebuild — leaving existing setup-vps / setup-dev folders untouched"
}

# 4. Operator CLI tools for VPS (Node.js required - NO license-generator, NO private key)
Sync-OperatorTools

Log "OK - VPS rebuilt at $vps"
