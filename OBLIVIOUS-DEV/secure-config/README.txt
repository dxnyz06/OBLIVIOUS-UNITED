Scratch directory for experimental KeyVault files.

- `dev-local/` — optional **`config.enc` + passphrase for local dev**, resolved before `OBLIVIOUS-VPS/config/` when running Electron from source (`oblivious-hub/src/main.js`).
- `e2e-roundtrip/` — DEMO vault used by automated smoke tests.

Do not ship these folders to production VPS; deploy operators edit **`config.enc`** only via Config Manager on the target paths documented in `README_VPS.md` / `README_DEV.md`.
