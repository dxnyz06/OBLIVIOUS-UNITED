# Build only OBLIVIOUS SETUP DEV.exe + OBLIVIOUS SETUP VPS.exe and copy to canonical folders.
# Does not rebuild Oblivious Hub, Bookmap, or EA. Use after clone when dist-* are gitignored.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File OBLIVIOUS-DEV\tools\packaging\build-setup-guis.ps1
#
[CmdletBinding()]
param([string]$Root = "")

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Root) {
  $Root = (Get-Item -LiteralPath (Join-Path $scriptDir '..\..\..')).FullName
}
$root = $Root.TrimEnd('\')
$setupRoot = Join-Path $root 'oblivious-setup'
$vps = Join-Path $root 'OBLIVIOUS-VPS'

if (-not (Test-Path (Join-Path $setupRoot 'package.json'))) {
  throw "oblivious-setup not found under $root"
}

Write-Host "[build-setup-guis] npm install + electron-builder (DEV + VPS)..."
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
$setupDevSrc = Join-Path $setupRoot 'dist-dev\win-unpacked'
$setupDevDst = Join-Path $root 'OBLIVIOUS-DEV\build\electron\setup-dev'

foreach ($pair in @(
  @{ Src = $setupVpsSrc; Dst = $setupVpsDst; Name = 'VPS' },
  @{ Src = $setupDevSrc; Dst = $setupDevDst; Name = 'DEV' }
)) {
  if (-not (Test-Path $pair.Src)) {
    throw "Missing build output: $($pair.Src)"
  }
  Write-Host "[build-setup-guis] robocopy $($pair.Name) -> $($pair.Dst)"
  New-Item -ItemType Directory -Force $pair.Dst | Out-Null
  Remove-Item (Join-Path $pair.Dst '*') -Recurse -Force -ErrorAction SilentlyContinue
  robocopy $pair.Src $pair.Dst /MIR /NFL /NDL /NJS /NJH /NP | Out-Null
}

$devExe = Join-Path $setupDevDst 'OBLIVIOUS SETUP DEV.exe'
$vpsExe = Join-Path $setupVpsDst 'OBLIVIOUS SETUP VPS.exe'
if (-not (Test-Path -LiteralPath $devExe)) { throw "Missing: $devExe" }
if (-not (Test-Path -LiteralPath $vpsExe)) { throw "Missing: $vpsExe" }

Write-Host "[build-setup-guis] OK"
Write-Host "  DEV: $devExe"
Write-Host "  VPS: $vpsExe"
