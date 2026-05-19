# Oblivious Setup (Electron)

Due applicazioni GUI operator-facing sul **motore esistente** (`config.enc` + `KeyVault.js` + adapter HTTP dell’hub):

| Build | Titolo finestra | Output tipico |
|-------|-----------------|---------------|
| **DEV** | `OBLIVIOUS HUB — Setup DEV` | `dist-dev/win-unpacked/OBLIVIOUS SETUP DEV.exe` |
| **VPS** | `OBLIVIOUS HUB — Setup VPS` | `dist-vps/win-unpacked/OBLIVIOUS SETUP VPS.exe` |

## Sviluppo

```powershell
cd oblivious-setup
npm install
npm run start:dev    # profilo DEV
npm run start:vps    # profilo VPS (richiede layout bundle app/+config/ verso l'alto)
```

## Build

```powershell
npm run build:dev
npm run build:vps
```

`build-vps.ps1` (workspace) esegue entrambe le build e copia:

- VPS → `OBLIVIOUS-VPS/runtime/setup-vps/`
- DEV → `OBLIVIOUS-DEV/build/electron/setup-dev/`

## Sicurezza UI

- `contextIsolation: true`, `nodeIntegration: false`, preload minimale.
- Nessuna chiave API né passphrase nei log main per IPC normale.
- **Test** usa gli stessi endpoint degli adapter in `oblivious-hub/src/services/providers/` (richiesta minima).

## Path vault

- **Setup DEV:** `OBLIVIOUS-DEV/secure-config/dev-local/config.enc` + sezione **Password VPS** su `OBLIVIOUS-VPS/config/config.enc` (solo dal PC operatore).
- **Setup VPS:** risolve la root del bundle (cartella con `app/` e `config/`) e usa `config/config.enc`. Override: `OBLIVIOUS_SETUP_VPS_ROOT`.
