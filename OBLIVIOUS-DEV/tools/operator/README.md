# Operator backend — DEV (motore interno)

Questi file Node sono il **motore backend** richiamato dalla GUI ufficiale (`OBLIVIOUS SETUP DEV.exe`, `OBLIVIOUS SETUP VPS.exe`) e dagli smoke test.

> **NON** sono più la UX operativa principale.
> La UX ufficiale è esclusivamente la GUI (vedi `README_DEV.md`, `README_VPS.md`).
> Per le ragioni di backward-compat / debug, alcuni `.bat` sono stati spostati in `OBLIVIOUS-DEV/tools/_legacy_cli/`.

## Requisiti

- **Node.js LTS** in `PATH` (solo per debug / smoke / automazione headless).
- Stesso backend di `oblivious-hub/src/services` — niente formato parallelo.

## Cosa rimane qui (motore interno)

| File | Ruolo |
|------|-------|
| `oblivious-config.js` | Engine usato dagli smoke / dal `_legacy_cli/Run-Config-Manager.bat` |
| `oblivious-setup.js` | Wizard CLI legacy — richiamato solo da `_legacy_cli/Run-Oblivious-Setup.bat` |
| `device-id.js` | Stampa/copia il `device_id` per richieste di licenza |
| `license-check.js` | Verifica `license.lic` + `public_key.pem` |
| `Run-Device-ID.bat` | Wrapper per `device-id.js` (utility, non rimpiazzabile da GUI) |
| `Run-License-Check.bat` | Wrapper per `license-check.js` (utility, non rimpiazzabile da GUI) |
| `lib/resolve-services.js` | Resolver di `KeyVault.js`, `DeviceId.js`, `Licensing.js` |

`oblivious-setup.js` (CLI wizard) e `Run-Config-Manager.bat` (CLI di config) sono stati **rimossi** come launcher utente: richiamarli ancora è possibile dal cassetto **`OBLIVIOUS-DEV/tools/_legacy_cli/`**.

## Vault DEV / VPS

- Vault DEV: `OBLIVIOUS-DEV/secure-config/dev-local/config.enc`.
- Vault VPS (workspace = bundle): `OBLIVIOUS-VPS/config/config.enc`.
- L’hub usa **sempre** il modal di unlock quando `config.enc` esiste; `KEYVAULT_PASSPHRASE` non bypassa il modal in modalità GUI.

## Smoke (riferimento)

- `oblivious-hub/_secure_boot_smoke.js`
- `oblivious-hub/_operator_cli_roundtrip_smoke.js`

## Dove NON sono questi tool

- **Generatore licenze + `private_key.pem`:** solo `OBLIVIOUS-PRIVATE/private-tools/`.
- **VPS bundle:** dopo `build-vps.ps1`, in `OBLIVIOUS-VPS/runtime/operator-tools/` restano solo `device-id.js` e `license-check.js` (la gestione password / API è esclusivamente in `OBLIVIOUS SETUP VPS.exe`).
