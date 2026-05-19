# OBLIVIOUS — DEV

## SOURCE OF TRUTH (da ricordare sempre)

- **`OBLIVIOUS-DEV/` non è il posto dove modificare l’hub, il plugin Java o il MQ4 live.**  
  Quei sorgenti stanno nella **root del workspace** (`../oblivious-hub/`, `../bookmap-plugin/`, `../OBLIVIOUS_COMPLETE.mq4`).
- **DEV è supporto ordinato:** tool, artefatti di build archiviati, log, documentazione, legacy congelato, `_review_needed/`.
- **Non creare** una seconda copia editabile degli stessi progetti sotto DEV: produrrebbe drift garantito.

---

Development tooling, **build outputs**, documentation, archived legacy.  
Struttura attesa:

```
OBLIVIOUS-DEV/
├─ project/
│  ├─ README.md               pointers → canonical root paths
│  ├─ bridge/                 placeholder — no live C++ bridge
│  └─ legacy-frozen/          OBSOLETE .NET / named-pipe stack (reference only)
│     ├─ README.md
│     ├─ AiMindBridge/
│     ├─ AiMindBridge.Server/
│     └─ ObliviousBridge.DLL/
├─ tools/
│  ├─ Run-OBLIVIOUS-SETUP-DEV.bat, Launch-Oblivious-Hub-DEV.bat   shortcut ai .exe (non sono CLI alternative)
│  ├─ operator/               motore Node interno (device-id.js, license-check.js, oblivious-config.js, oblivious-setup.js, lib/) — NON è UX utente
│  ├─ config-manager/         config-mgr.js (utility interna; il vecchio Run-Config-Manager.bat è stato archiviato)
│  ├─ _legacy_cli/            launcher .bat archiviati: Run-Oblivious-Setup, Run-Config-Manager (non più UX ufficiale)
│  ├─ scripts/                e.g. Install-Into-MT4.ps1
│  └─ packaging/              build-vps.ps1 (bundle completo), build-setup-guis.ps1 (solo SETUP DEV+VPS .exe)
├─ secure-config/             dev-local/, e2e-roundtrip/, README — vault di laboratorio / DEV separato da VPS
├─ licenses/                  scratch for newly issued public license files
├─ build/
│  ├─ mq4/                    snapshot EX4 + compile log + archivi policy (*.mq4 rimossi dal bundle VPS)
│  ├─ electron/               NSIS installer hub + **`setup-dev/`** (OBLIVIOUS SETUP DEV.exe dopo full build) + log
│  ├─ java/                   shaded Bookmap jar + mvn log
│  └─ logs/                   smoke-test logs (+ optional `_root-stash`)
├─ docs/                      architecture + archived README copies
├─ manifests/                 hashes / inventories
├─ _review_needed/            ambiguous files — annotate in FILE_MANIFEST.md
└─ README_DEV.md              this file
```

### `OBLIVIOUS SETUP DEV.exe` e `OBLIVIOUS SETUP VPS.exe` — UNICA UX ufficiale

I due programmi sono **GUI Electron packaged** (win-unpacked: EXE + DLL Chromium/Electron nella stessa cartella). Sostituiscono completamente:

- `Run-Oblivious-Setup.bat` (wizard CLI) — **archiviato** in `OBLIVIOUS-DEV/tools/_legacy_cli/`
- `Run-Config-Manager.bat` (CLI di config) — **archiviato** in `OBLIVIOUS-DEV/tools/_legacy_cli/`

Il backend Node (`oblivious-setup.js`, `oblivious-config.js`) resta in `OBLIVIOUS-DEV/tools/operator/` come **motore interno** richiamato dalla GUI e dagli smoke; non è UX utente.

**Percorsi finali nel workspace (file reali da distribuire):**

| Programma | Percorso |
|-----------|----------|
| **OBLIVIOUS SETUP DEV.exe** | `OBLIVIOUS-DEV/build/electron/setup-dev/OBLIVIOUS SETUP DEV.exe` |
| **OBLIVIOUS SETUP VPS.exe** | `OBLIVIOUS-VPS/runtime/setup-vps/OBLIVIOUS SETUP VPS.exe` |

**Regola di packaging:** quando prepari uno ZIP / artifact per un altro PC, **includi l’intera cartella** `setup-dev/` o `setup-vps/` (non solo l’EXE isolato).

Rigenerazione su macchina di build: `OBLIVIOUS-DEV/tools/packaging/build-setup-guis.ps1` (solo setup) oppure `build-vps.ps1` (hub + bundle + setup).

---

## Ambiente DEV — uso locale completo

**Percorso principale (GUI packaged)** — doppio clic diretto:

| Programma | Percorso |
|-----------|----------|
| **OBLIVIOUS SETUP DEV.exe** | `OBLIVIOUS-DEV\build\electron\setup-dev\OBLIVIOUS SETUP DEV.exe` |

Il contenuto della cartella `setup-dev\` è una copia **win-unpacked** di Electron (DLL incluse): è il programma reale, non uno script.

Sorgenti e ricompilazione: progetto `oblivious-setup\` nella root (`npm run build:dev` / `build-vps.ps1`).

| Altro | Percorso / nota |
|-------|-----------------|
| Scorciatoia `.bat` (optional) | `tools\Run-OBLIVIOUS-SETUP-DEV.bat` → avvia solo se l’EXE sopra esiste |
| **Oblivious Hub** (EXE packaged) | `tools\Launch-Oblivious-Hub-DEV.bat` oppure `oblivious-hub\dist\win-unpacked\Oblivious Hub.exe` |
| Vault **DEV** | `secure-config\dev-local\config.enc` |
| Vault **VPS** nel repo | `..\OBLIVIOUS-VPS\config\config.enc` |

**Password VPS** dal PC operatore: nella GUI SETUP DEV, sezione **Password VPS**, solo nuova/conferma + Save; la passphrase **attuale** è richiesta in una **finestra modale** (non è un campo fisso nella pagina).

---

## Where to find things

| Looking for… | Path |
|--------------|------|
| EA **source** (edit) | `../OBLIVIOUS_COMPLETE.mq4` |
| EA compile script | `../COMPILA.bat` |
| Electron **source** (edit) | `../oblivious-hub/` |
| Bookmap **source** (edit) | `../bookmap-plugin/` |
| MT4 ZMQ bundle | `../mql-zmq-bundle/` |
| Archived .NET bridge | `project/legacy-frozen/` |
| Packaged **SETUP DEV** GUI | **`build/electron/setup-dev/OBLIVIOUS SETUP DEV.exe`** (cartella win-unpacked completa sotto `setup-dev/`, dopo `build-vps.ps1` o `npm run build:dev` in `oblivious-setup/`) |
| VPS rebuild script | `tools/packaging/build-vps.ps1` |
| Vault / API key (UX ufficiale) | **`build/electron/setup-dev/OBLIVIOUS SETUP DEV.exe`** |
| Device ID (utility, stesso algoritmo dell’hub) | `tools/operator/Run-Device-ID.bat` → `device-id.js` |
| Verifica `license.lic` + `public_key.pem` | `tools/operator/Run-License-Check.bat` → `license-check.js` |
| Vecchi launcher CLI archiviati | `tools/_legacy_cli/` (debug/automazione headless) |
| Documentazione backend Node | `tools/operator/README.md` |

## GUI operator — programmi packaged

Applicazioni Electron (**solo KeyVault**, stesso formato `config.enc` dell’hub). Percorsi **canonical per operatore**:

| App | Avvio |
|-----|--------|
| **OBLIVIOUS SETUP DEV.exe** | `OBLIVIOUS-DEV/build/electron/setup-dev/OBLIVIOUS SETUP DEV.exe` |
| **OBLIVIOUS SETUP VPS.exe** (nel bundle di deploy) | `OBLIVIOUS-VPS/runtime/setup-vps/OBLIVIOUS SETUP VPS.exe` |

Titoli finestra: `OBLIVIOUS HUB — Setup DEV` e `OBLIVIOUS HUB — Setup VPS`. Sezione **API Keys** in alto; **Password VPS** solo nel DEV (modalità VPS setup non può ruotare la passphrase vault).

Flusso: Unlock **vault DEV** → API Keys sul file DEV (Test/Save per provider) → Password DEV / Password VPS (file workspace `OBLIVIOUS-VPS/config/config.enc`) → Exit. Le API key sul server si gestiscono con **OBLIVIOUS SETUP VPS.exe**.

La passphrase **`config.enc` VPS** nel workspace si cambia **solo** dal SETUP DEV (sezione Password VPS + modale passphrase corrente). Sul server si usa solo **SETUP VPS** per le chiavi.

| Programma | Cosa aggiorna | File |
|-----------|----------------|------|
| SETUP DEV | API Keys | `OBLIVIOUS-DEV/secure-config/dev-local/config.enc` |
| SETUP DEV | Password DEV | stesso |
| SETUP DEV | Password VPS | `OBLIVIOUS-VPS/config/config.enc` (nel workspace = bundle sul disco; sync/deploy senza copiare manualmente il vault) |
| SETUP VPS | API Keys | `config/config.enc` nella cartella bundle sul VPS |

---

## Backend / utility (NON UX utente)

La UX operativa per password e API key è **esclusivamente** la GUI sopra. Qui restano solo utility che la GUI non copre, più un cassetto legacy.

| Azione | Strumento |
|--------|-----------|
| **Password DEV / VPS / API key 7 provider** | `OBLIVIOUS SETUP DEV.exe` |
| **API key sul VPS** | `OBLIVIOUS SETUP VPS.exe` |
| Device ID per richiesta licenza | `tools/operator/Run-Device-ID.bat` (`json` / `copy`) |
| Verifica licenza locale | `tools/operator/Run-License-Check.bat verify --license ... --pub ...` |
| **Wizard CLI / Config Manager (archiviato)** | `tools/_legacy_cli/Run-Oblivious-Setup.bat`, `tools/_legacy_cli/Run-Config-Manager.bat` — solo fallback per debug/automazione |

**Firma licenze (`license-gen.js`, chiave privata):** solo cartella **`OBLIVIOUS-PRIVATE/private-tools/`** — vedi [`README_PRIVATE.md`](../OBLIVIOUS-PRIVATE/README_PRIVATE.md).

### Password vault vs “segreti operator-only”

| Concetto | Dove vive | Note |
|----------|-----------|------|
| Passphrase che **sblocca `config.enc`** (API key cifrate) | Solo nella testa dell’operatore / gestione password sicura | **Non** è la chiave RSA di firma licenze; **non** va in `OBLIVIOUS-PRIVATE` come sostituto del vault VPS |
| **`private_key.pem`** (firma `license.lic`) | Solo **`OBLIVIOUS-PRIVATE/keys/`** | Mai sulla VPS; mai nel bundle distribuito |

### Hub in DEV — prompt password

Quando esiste un **`config.enc`** risolto dal runtime, **l’hub Electron mostra sempre il modal di unlock** (DEV e VPS). **`KEYVAULT_PASSPHRASE` nel `.env` non aggira più quel dialog** (evita passphrase in chiaro che bypassano la UX). Per script/smoke senza GUI si usa `askPassword=null` / `OBLIVIOUS_HEADLESS=1` e la variabile d’ambiente, come negli smoke test.

### Vault DEV separato dal vault “VPS nel repo”

Per avere **password e `config.enc` di sviluppo distinti** da `OBLIVIOUS-VPS/config/config.enc` nello stesso clone:

1. Crea `OBLIVIOUS-DEV/secure-config/dev-local/config.enc` con Config Manager (`init`, poi `set-provider-key`, ecc.).
2. Avvia l’hub da sorgente (`npm start` / Electron dev): la risoluzione dei path include **`secure-config/dev-local/`** prima di `OBLIVIOUS-VPS/config/` (vedi `oblivious-hub/src/main.js`).
3. Sul **bundle VPS reale** resta solo `config/config.enc` del server — passphrase **indipendente** da quella DEV.

### Scenario operativo DEV (riepilogo)

1. Lancia **`OBLIVIOUS SETUP DEV.exe`** → primo avvio crea vault DEV; sblocchi con la passphrase impostata.
2. Sezione **API Keys**: incolli ogni chiave, `Test` (verifica HTTP) e `Save` (cifra nel `config.enc` DEV) — un provider alla volta. Niente `Save All`, niente `Reload`.
3. Sezione **Password DEV**: nuova/conferma + `Save` → ricifra `secure-config/dev-local/config.enc` con la nuova passphrase.
4. Sezione **Password VPS**: nuova/conferma + `Save`; se il file VPS esiste, viene chiesta la passphrase corrente in modale → ricifra `OBLIVIOUS-VPS/config/config.enc` (stesso file del bundle: nessun copia/sposta manuale).
5. Avvii `oblivious-hub` → **modal password** → decrypt **`KeyVault`** → provider caricati da vault.

## Build pipelines

```powershell
# MQ4 — dalla root workspace
cd ..
.\COMPILA.bat
# Opzionale: copia evidenza in DEV/build/mq4 (ex4 + log) per audit coerente con FILE_MANIFEST

# Electron — regenera oblivious-hub\dist\
cd oblivious-hub
npm install   # first time only
npx electron-builder --win --x64

# Java plugin
cd ..\bookmap-plugin
mvn -B package

# Rigenera cartella OBLIVIOUS-VPS da artefatti root (NO .mq4 in bridge/)
cd ..\OBLIVIOUS-DEV
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\packaging\build-vps.ps1
# Opzioni utili:
#   -SkipElectronRebuild   se esiste già oblivious-hub\dist\win-unpacked
#   -SkipMaven              se esiste già bookmap-plugin\target\oblivious-bookmap-bridge-1.0.0.jar
#   -OperatorToolsOnly      solo runtime\operator-tools (nessun refresh di app\ / bridge\)
```

## Smoke tests

Esegui dalla **root** `oblivious-hub/`:

```powershell
cd ..\oblivious-hub
node _boot_smoke.js
node _e2e_smoke.js
node _bm_ws_smoke.js
node _secure_boot_smoke.js
node _operator_cli_roundtrip_smoke.js
```

### Verifica end-to-end (password / `config.enc` / boot hub)

| Obiettivo | Come |
|-----------|------|
| Licenza + vault sintetico + split dirs | `node _secure_boot_smoke.js` |
| Vault creato con **oblivious-config**, letto da **SecureBoot** | `KEYVAULT_PASSPHRASE` + vault in `OBLIVIOUS-DEV/secure-config/e2e-roundtrip/config.enc`, poi `node _operator_cli_roundtrip_smoke.js` |
| **Exe packaggiato** | Serve passphrase corretta per quel `config.enc` + licenza valida; per test automatizzati usare solo copie temporanee del vault di laboratorio e ripristinare il `config.enc` del bundle subito dopo |

Senza chiavi API reali non si fa qui una validazione delle chiamate AI; si verifica invece decrypt, parsing vault e ordine SecureBoot (come nel `main.js`).

## Rules

1. Edit sorgenti live solo nella **workspace root**.
2. Tratta `build/` come artefatti riproducibili — non come fonte di verità del codice.
3. Mai copiare `private_key.pem` qui — solo `OBLIVIOUS-PRIVATE/`.
4. **Blacklist VPS** e flusso artefatti: [`FILE_MANIFEST.md`](../FILE_MANIFEST.md), [`WORKSPACE_GUIDE.md`](../WORKSPACE_GUIDE.md).
