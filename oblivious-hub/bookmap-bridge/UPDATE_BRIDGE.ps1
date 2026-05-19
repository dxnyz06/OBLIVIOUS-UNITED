# ═══════════════════════════════════════════════════════════════════════
#  OBLIVIOUS BRIDGE — Auto Updater (Windows PowerShell)
#  USO:
#    1. Estrai il tarball oblivious-hub-FINAL.tar.gz (per esempio sul Desktop).
#    2. Apri PowerShell come Amministratore.
#    3. cd nella cartella estratta -> bookmap-bridge
#       (dove si trova questo script + oblivious_bridge.py).
#    4. Esegui:
#         Set-ExecutionPolicy -Scope Process Bypass -Force
#         .\UPDATE_BRIDGE.ps1
#  ═══════════════════════════════════════════════════════════════════════

$ErrorActionPreference = 'Stop'

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  OBLIVIOUS BRIDGE  ::  Auto Updater" -ForegroundColor Cyan
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""

# ── STEP 1 : individua il file .py nuovo ─────────────────────────────────
$here   = Split-Path -Parent $MyInvocation.MyCommand.Definition
$newPy  = Join-Path $here "oblivious_bridge.py"

if (-not (Test-Path $newPy)) {
    Write-Host "[ERRORE] Non trovo $newPy" -ForegroundColor Red
    Write-Host "         Lancia lo script dalla cartella bookmap-bridge del tarball." -ForegroundColor Red
    exit 1
}

# Verifica che il .py contenga effettivamente la versione V3
$content = Get-Content $newPy -Raw
if ($content -notmatch "OBLIVIOUS BRIDGE  V3") {
    Write-Host "[ERRORE] Il file oblivious_bridge.py NON contiene il banner V3." -ForegroundColor Red
    Write-Host "         Hai estratto il tarball giusto? Atteso il file aggiornato." -ForegroundColor Red
    exit 1
}
Write-Host "[ OK ] Sorgente nuovo individuato: $newPy" -ForegroundColor Green

# ── STEP 2 : termina Bookmap se in esecuzione ───────────────────────────
$bookmapProc = Get-Process -Name "Bookmap" -ErrorAction SilentlyContinue
if ($bookmapProc) {
    Write-Host "[ .. ] Bookmap è in esecuzione. Lo chiudo per aggiornare il jar." -ForegroundColor Yellow
    $bookmapProc | Stop-Process -Force
    Start-Sleep -Seconds 2
    Write-Host "[ OK ] Bookmap chiuso." -ForegroundColor Green
} else {
    Write-Host "[ OK ] Bookmap non è in esecuzione." -ForegroundColor Green
}

# ── STEP 3 : cerca TUTTI i oblivious_bridge.jar sul disco ───────────────
Write-Host ""
Write-Host "[ .. ] Cerco oblivious_bridge.jar (può richiedere 10-30 secondi)..." -ForegroundColor Yellow
$searchRoots = @(
    "C:\Bookmap",
    "$env:USERPROFILE\.bookmap",
    "$env:APPDATA\Bookmap",
    "$env:LOCALAPPDATA\Bookmap"
)
$jars = @()
foreach ($root in $searchRoots) {
    if (Test-Path $root) {
        $jars += Get-ChildItem -Path $root -Recurse -Filter "oblivious_bridge.jar" -ErrorAction SilentlyContinue
    }
}
$jars = $jars | Select-Object -Unique FullName

if ($jars.Count -eq 0) {
    Write-Host "[ERRORE] Nessun oblivious_bridge.jar trovato sul disco." -ForegroundColor Red
    Write-Host "         Verifica di averlo già installato in Bookmap almeno una volta." -ForegroundColor Red
    exit 1
}

Write-Host "[ OK ] Trovati $($jars.Count) jar:" -ForegroundColor Green
$jars | ForEach-Object { Write-Host "       - $($_.FullName)" }
Write-Host ""

# ── STEP 4 : aggiorna ciascun jar ───────────────────────────────────────
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

foreach ($jar in $jars) {
    $jarPath = $jar.FullName
    Write-Host "[ .. ] Aggiornamento di $jarPath" -ForegroundColor Yellow

    # Backup
    $backup = "$jarPath.bak_$(Get-Date -Format 'yyyyMMddHHmmss')"
    Copy-Item $jarPath $backup
    Write-Host "       backup -> $backup" -ForegroundColor DarkGray

    try {
        $zip = [System.IO.Compression.ZipFile]::Open($jarPath, 'Update')

        # Elenca tutti i path .py dentro il jar e sostituisci ognuno con il nuovo file.
        $pyEntries = @($zip.Entries | Where-Object { $_.FullName -like "*oblivious_bridge.py" })

        if ($pyEntries.Count -eq 0) {
            Write-Host "       [ATTENZIONE] Nessun oblivious_bridge.py trovato dentro questo jar." -ForegroundColor Yellow
            Write-Host "       Aggiungo il file alla root del jar." -ForegroundColor Yellow
            $entry = $zip.CreateEntry("oblivious_bridge.py")
            $writer = New-Object System.IO.StreamWriter($entry.Open())
            $writer.Write([System.IO.File]::ReadAllText($newPy))
            $writer.Close()
        } else {
            foreach ($e in $pyEntries) {
                $entryName = $e.FullName
                $e.Delete()
                $newEntry = $zip.CreateEntry($entryName)
                $writer = New-Object System.IO.StreamWriter($newEntry.Open())
                $writer.Write([System.IO.File]::ReadAllText($newPy))
                $writer.Close()
                Write-Host "       sostituito $entryName" -ForegroundColor DarkGreen
            }
        }

        $zip.Dispose()
        Write-Host "[ OK ] $jarPath aggiornato." -ForegroundColor Green
    } catch {
        Write-Host "[ERRORE] Aggiornamento di $jarPath fallito: $_" -ForegroundColor Red
        if ($zip) { $zip.Dispose() }
        Copy-Item $backup $jarPath -Force
        Write-Host "         Ripristinato backup." -ForegroundColor Yellow
    }
    Write-Host ""
}

# ── STEP 5 : Aggiorna anche le copie scompresse del .py, se esistono ────
$externalPy = @()
foreach ($root in $searchRoots) {
    if (Test-Path $root) {
        $externalPy += Get-ChildItem -Path $root -Recurse -Filter "oblivious_bridge.py" -ErrorAction SilentlyContinue
    }
}
$externalPy = $externalPy | Where-Object { $_.FullName -ne $newPy } | Select-Object -Unique FullName

if ($externalPy.Count -gt 0) {
    Write-Host "[ .. ] Sostituisco anche le copie .py sciolte:" -ForegroundColor Yellow
    foreach ($p in $externalPy) {
        try {
            Copy-Item $newPy $p.FullName -Force
            Write-Host "       sovrascritto $($p.FullName)" -ForegroundColor DarkGreen
        } catch {
            Write-Host "       [warn] non posso scrivere $($p.FullName): $_" -ForegroundColor DarkYellow
        }
    }
}

Write-Host ""
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  AGGIORNAMENTO COMPLETATO" -ForegroundColor Green
Write-Host "================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Apri Bookmap e cerca nel log le righe con il banner V3:" -ForegroundColor White
Write-Host '  [oblivious-bridge]   OBLIVIOUS BRIDGE  V3  ::  INSPECT-SIG' -ForegroundColor Cyan
Write-Host '  [oblivious-bridge] READY V3 ...' -ForegroundColor Cyan
Write-Host ""
Write-Host "Se le VEDI -> il nuovo codice è attivo." -ForegroundColor Green
Write-Host "Se NON le vedi -> il jar caricato da Bookmap è in un altro path." -ForegroundColor Yellow
Write-Host ""
