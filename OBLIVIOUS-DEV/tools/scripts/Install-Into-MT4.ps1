<#
.SYNOPSIS
  Installs the OBLIVIOUS ZeroMQ stack into a MetaTrader 4 directory.

.DESCRIPTION
  Copies:
    Library\libzmq.dll        -> <MT4>\MQL4\Libraries\libzmq.dll
    Library\libsodium.dll     -> <MT4>\MQL4\Libraries\libsodium.dll
    Include\Mql\Lang\*.mqh    -> <MT4>\MQL4\Include\Mql\Lang\
    Include\Zmq\*.mqh         -> <MT4>\MQL4\Include\Zmq\

  After running this script, open the EA in MetaEditor and press F7
  to recompile. The `#include <Zmq/Zmq.mqh>` line in
  OBLIVIOUS_COMPLETE.mq4 will resolve and the binary symbols
  (libzmq.dll exports) will load when the EA attaches to a chart.

.PARAMETER MT4Path
  The MetaTrader 4 root folder, e.g. "C:\Program Files (x86)\MetaTrader 4"
  or the data folder shown by "File -> Open Data Folder" inside the
  terminal (typically %APPDATA%\MetaQuotes\Terminal\<HASH>).

.EXAMPLE
  .\Install-Into-MT4.ps1 -MT4Path "C:\Program Files (x86)\MetaTrader 4"
  .\Install-Into-MT4.ps1 -MT4Path "$env:APPDATA\MetaQuotes\Terminal\<HASH>"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$MT4Path
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $MT4Path)) {
    throw "MT4 path not found: $MT4Path"
}

$mql4 = Join-Path $MT4Path 'MQL4'
if (-not (Test-Path $mql4)) {
    throw "Expected MQL4/ subfolder inside $MT4Path. Run 'File -> Open Data Folder' inside the terminal to find the right base."
}

$libDst   = Join-Path $mql4 'Libraries'
$incDst   = Join-Path $mql4 'Include'
$incZmq   = Join-Path $incDst 'Zmq'
$incMqlLang = Join-Path $incDst 'Mql\Lang'

foreach ($p in @($libDst, $incZmq, $incMqlLang)) {
    if (-not (Test-Path $p)) { New-Item -ItemType Directory -Force -Path $p | Out-Null }
}

$bundleRoot = $PSScriptRoot

Write-Host "[OBLIVIOUS] copying libzmq.dll + libsodium.dll -> $libDst"
Copy-Item -Force (Join-Path $bundleRoot 'Library\libzmq.dll')    $libDst
Copy-Item -Force (Join-Path $bundleRoot 'Library\libsodium.dll') $libDst

Write-Host "[OBLIVIOUS] copying Zmq/*.mqh -> $incZmq"
Copy-Item -Force -Recurse (Join-Path $bundleRoot 'Include\Zmq\*') $incZmq

Write-Host "[OBLIVIOUS] copying Mql/Lang/*.mqh -> $incMqlLang"
Copy-Item -Force -Recurse (Join-Path $bundleRoot 'Include\Mql\Lang\*') $incMqlLang

Write-Host ""
Write-Host "[OBLIVIOUS] DONE."
Write-Host "Next steps:"
Write-Host "  1. In MetaTrader 4: Tools -> Options -> Expert Advisors -> 'Allow DLL imports' must be checked."
Write-Host "  2. Open OBLIVIOUS_COMPLETE.mq4 in MetaEditor and press F7."
Write-Host "  3. Attach the compiled EA to a chart."
