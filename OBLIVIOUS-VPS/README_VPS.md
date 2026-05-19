# OBLIVIOUS — VPS

Minimal runtime layout for a Windows VPS deployment.  
**Applicazione principale per gestire le API key sul server:** `runtime\setup-vps\OBLIVIOUS SETUP VPS.exe` (GUI Electron packaged — stesso KeyVault di `config.enc`; **nessun** cambio passphrase da questa app).

**Standard policy:** sul bundle si distribuisce **`OBLIVIOUS_COMPLETE.ex4`** per MetaTrader — **non** il sorgente **`OBLIVIOUS_COMPLETE.mq4`** (che resta nella root del workspace di sviluppo).

**Build / aggiornamento setup GUI:** `build-vps.ps1` oppure `OBLIVIOUS-DEV/tools/packaging/build-setup-guis.ps1`. Il trasferimento sulla VPS deve copiare **`runtime/setup-vps/`** per intero.

```
OBLIVIOUS-VPS/
├─ app/                                packaged Electron application (≈ 289 MB)
│  ├─ Oblivious Hub.exe                main process entry point
│  ├─ resources/app.asar               bundled JS sources (incl. SecureBoot)
│  ├─ resources/app.asar.unpacked/…    native zeromq bindings (must stay external)
│  ├─ chrome*.dll, ffmpeg.dll, …       Chromium / Electron native runtime
│  └─ locales/                         language packs
├─ runtime/
│  ├─ README.txt                       moduli nativi futuri / note
│  ├─ setup-vps/                       (dopo `build-vps.ps1`) GUI **OBLIVIOUS SETUP VPS.exe** — solo KeyVault API keys (no cambio passphrase)
│  └─ operator-tools/                  utility minori (NON UX di setup): device-id, license-check
│     ├─ Run-Device-ID.bat
│     ├─ Run-License-Check.bat
│     ├─ lib/resolve-services.js
│     └─ vendor/{KeyVault,DeviceId,Licensing}.js   copia da oblivious-hub — solo per queste utility
├─ bridge/                             MT4 + Bookmap runtime artefacts
│  ├─ OBLIVIOUS_COMPLETE.ex4           compiled EA — copy to MT4 Experts/
│  ├─ oblivious-bookmap-bridge-1.0.0.jar  Bookmap add-on (project jar only)
│  └─ mt4-zmq-libs/                    drop into MT4\MQL4 subtrees
│     ├─ Libraries/libzmq.dll
│     ├─ Libraries/libsodium.dll
│     └─ Include/Zmq/*.mqh
├─ config/
│  └─ config.enc                       AES-256-GCM encrypted API keys (KeyVault)
├─ licenses/
│  ├─ license.lic                      RSA-PSS signed license, bound to device_id
│  └─ public_key.pem                   SPKI/PEM, used by the hub at boot
├─ logs/                               populated at runtime by the hub
├─ docs/                               operational notes / runbooks
├─ manifests/                          file inventories with hashes
├─ _review_needed/                     ambiguous files — do NOT deploy until classified
├─ start.bat                           portable launcher (sets the env vars)
└─ README_VPS.md                       this file
```

## Packaging VPS (`build-vps.ps1`)

Esegui dalla root workspace **Windows PowerShell** (su alcuni sistemi `pwsh` non è installato):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File OBLIVIOUS-DEV\tools\packaging\build-vps.ps1
```

Lo script rileva automaticamente la root workspace dalla cartella dello script (`MyInvocation`). Opzioni:

| Switch | Effetto |
|--------|---------|
| *(default)* | `electron-builder` → aggiorna `OBLIVIOUS-VPS/app`, sincronizza `bridge`, poi `runtime/operator-tools` |
| `-SkipElectronRebuild` | Riusa `oblivious-hub\dist\win-unpacked` (deve esistere `Oblivious Hub.exe`) |
| `-SkipMaven` | Non esegue `mvn`; richiede il jar shaded già in `bookmap-plugin\target\` |
| `-SkipSetupRebuild` | Non rigenera le GUI `oblivious-setup` (SETUP DEV/VPS); riusa cartelle già buildate |
| `-OperatorToolsOnly` | Aggiorna **solo** `runtime\operator-tools` (Node.js richiesto sulla VPS per questi script) |

Dopo il packaging `runtime\operator-tools` contiene **solo**: `Run-Device-ID.bat`, `Run-License-Check.bat`, `device-id.js`, `license-check.js`, `lib\resolve-services.js`, `vendor\{KeyVault,DeviceId,Licensing}.js`. **Non** deve contenere `Run-Oblivious-Setup.bat`, `Run-Config-Manager.bat`, `oblivious-setup.js`, `oblivious-config.js`, `private_key.pem`, `license-gen.js`, `.env`.

## Cosa copiare sulla VPS

L’intera cartella `OBLIVIOUS-VPS/` **come bundle runtime**, escludendo esplicitamente qualsiasi voce della blacklist sotto (non devono esistere nel pacchetto che consegni).

## Blacklist — cosa NON deve stare nel bundle VPS

Lista rigida e motivazioni in [`FILE_MANIFEST.md`](../FILE_MANIFEST.md) → **`EXCLUDED_FROM_VPS`**.  
In sintesi **non** distribuire sul VPS di produzione:

| Categoria | Esempi |
|-----------|--------|
| Segreti in chiaro | `.env` con API key |
| Sorgente EA | **`OBLIVIOUS_COMPLETE.mq4`** (eccetto eccezione documentata dal responsabile) |
| Sorgenti hub/plugin sciolti | `oblivious-hub/src/**`, `*_smoke.js`, `bookmap-plugin/src/**`, `pom.xml` |
| Toolchain dev | `node_modules/` dev tree, `.git/`, intero `OBLIVIOUS-DEV/` |
| Privato | `OBLIVIOUS-PRIVATE/**`, `private_key.pem`, `license-gen.js`, intero generatore licenze |
| SDK proprietari Bookmap | `bm-l1api.jar`, `bm-simplified-api-wrapper.jar` (non nel bundle standard) |
| Debug / rumore | `.pdb`, `.map`, backup `.bak`, vecchi log di sviluppo, report interni |
| Legacy | `legacy-frozen/` (.NET / pipe) |

**Eccezione:** se un operatore colloca temporaneamente un file dubbio durante il deploy, usare **`_review_needed/`** e annotare nel manifest — non lasciare nella root del bundle senza classificazione.

## Password VPS, API key e cambio passphrase

- **Un solo formato vault:** `config.enc` (**KeyVault**). Nessun secondo sistema.
- **Passphrase del vault** è **indipendente** da **`private_key.pem`** (firma licenze in `OBLIVIOUS-PRIVATE`).
- **UX ufficiale sulla VPS:** **`runtime\setup-vps\OBLIVIOUS SETUP VPS.exe`** — una riga per provider: **Test** (connessione), **Save** (cifrato in `config\config.enc`). Niente `Save All`, niente `Reload`. La passphrase **non** si cambia da questa app.
- **Cambiare la passphrase del vault VPS** (file `config\config.enc`): **solo dal PC operatore**, con **`OBLIVIOUS SETUP DEV`** → sezione **Password VPS** (aggiorna il `config.enc` nel bundle workspace — poi redeploy/sync sulla VPS).
- **Niente CLI di setup sulla VPS:** `Run-Oblivious-Setup.bat` e `Run-Config-Manager.bat` sono stati **rimossi** dal bundle (rimpiazzati dalla GUI). I corrispondenti `.bat` legacy restano archiviati nel solo workspace DEV in `OBLIVIOUS-DEV/tools/_legacy_cli/` per debug.
- Dopo un cambio passphrase, al **prossimo** avvio dell’hub usa **solo** la nuova passphrase nel modal.
- **`KEYVAULT_PASSPHRASE`** nell’ambiente **non** sostituisce il modal nell’hub **interattivo**; resta per smoke/headless documentati.

## Scenario operativo VPS (riepilogo)

1. Leggi **`device_id`** con `Run-Device-ID.bat`.
2. Sul PC **PRIVATE**, genera **`license.lic`** per quel device; copia **solo** `.lic` in `licenses\`.
3. **`runtime\setup-vps\OBLIVIOUS SETUP VPS.exe`** → Unlock passphrase vault VPS → imposta API key (Save/Test per provider).
4. **`start.bat`** → **`Oblivious Hub.exe`** → modal passphrase → verifica licenza → decrypt vault → servizi.

## Boot order (hard sequence)

1. **launch** — `start.bat` runs `app\Oblivious Hub.exe`.
2. **device_id** — `sha256(BIOS UUID | primary MAC | MachineGuid)`.
3. **password** — finestra modale per la passphrase del vault (**sempre**, quando esiste `config.enc`; non si aggira con `KEYVAULT_PASSPHRASE` nel `.env` nell’hub grafico). Per automazione senza GUI: `OBLIVIOUS_HEADLESS=1` e passphrase solo in ambiente controllato / CI.
4. **license** — `licenses\license.lic` is verified against
   `licenses\public_key.pem` (RSA-PSS over canonical JSON, dates,
   device_id binding).  Boot is refused on any failure.
5. **config** — `config\config.enc` is decrypted with the password
   (AES-256-GCM, scrypt N=2^15, r=8, p=1).
6. **providers** — AI keys load from the decrypted vault; `.env`
   is **never** consulted on the VPS.
7. **transport** — ZeroMQ binds `127.0.0.1:5555/5556/5557`;
   Bookmap WS connects to `ws://127.0.0.1:8081`.
8. **EA** — MetaTrader 4 loads **`OBLIVIOUS_COMPLETE.ex4`** from your MT4 `Experts/` installation (copy from `bridge/`).

## Search-dir resolution (how the hub finds its files)

The packaged hub looks for each file independently across an
ordered list of candidate directories:

```
$OBLIVIOUS_CONFIG_DIR     (override)
$OBLIVIOUS_LICENSES_DIR   (override)
$OBLIVIOUS_APP_DIR        (override)
<exe>/../config           (this layout)
<exe>/../licenses         (this layout)
<exe>/app                 (NSIS install layout)
<exe>                     (single-folder fallback)
```

`start.bat` sets the first two so the layout above just works
without touching system env vars.

## Where do `app/` vs `runtime/` differ?

* `app/` — the **Electron-packaged** application: `Oblivious Hub.exe`
  plus every DLL Electron / Chromium needs at its side.
* `runtime/` — moduli nativi futuri; **`runtime/operator-tools/`** (se presente) contiene solo script operator **senza** chiave privata né generatore licenze.

## Operator tools sulla VPS (`runtime/operator-tools/`)

Richiedono **Node.js LTS** nel `PATH`. Sono copiati da `build-vps.ps1` insieme al resto del bundle.

| Obiettivo | Azione |
|-----------|--------|
| Leggere **`device_id`** (64 hex, come SecureBoot) | `Run-Device-ID.bat show` oppure `Run-Device-ID.bat json` |
| Copiare negli appunti (Windows) | `Run-Device-ID.bat copy` |
| Creare / aggiornare **`config.enc`** sul server | **Unica UX:** `runtime\setup-vps\OBLIVIOUS SETUP VPS.exe` (GUI; Save/Test per provider). Nessun launcher CLI sul VPS. |
| Verificare **`license.lic`** prima di aprire l’hub | `Run-License-Check.bat verify --license licenses\license.lic --pub licenses\public_key.pem` |

**Non** devono comparire sulla VPS: `private_key.pem`, `license-gen.js`, cartella `OBLIVIOUS-PRIVATE/`.

## Updating API keys / licenses on a live VPS

1. **device_id**: dalla VPS, `runtime\operator-tools\Run-Device-ID.bat json` (o `show`).
2. **Licenza**: sul PC operatore, solo in **`OBLIVIOUS-PRIVATE/private-tools/`** (`Run-License-Generator.bat` / `license-gen.js`) — generi `license.lic` per quel `device_id`; copi **solo** il file `.lic` in `licenses/license.lic`.
3. **API keys**: sulla VPS (o da PC con path di rete al vault VPS), **`runtime\setup-vps\OBLIVIOUS SETUP VPS.exe`** → Unlock → **Save** / **Test** per provider su `config/config.enc`. Nessuna CLI alternativa sul bundle.
4. Riavvia `start.bat` / hub.

The hub re-reads both files on next launch.
