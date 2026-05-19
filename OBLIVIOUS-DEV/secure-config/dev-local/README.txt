Place `config.enc` here for **local development** when you want a vault + passphrase separate from `OBLIVIOUS-VPS/config/config.enc` in the same repo.

Resolution order (dev Electron unpackaged): `oblivious-hub/app/` → **this folder** → `OBLIVIOUS-VPS/config/` … first existing `config.enc` wins.

Preferred operator UX — double-click or run:

  `OBLIVIOUS-DEV/tools/operator/Run-Oblivious-Setup.bat`

Choose **[T]** → **DEV**, then **[I]** init (if empty), **[K]** to add keys, **[P]** to rotate password.

CLI equivalent:

```
cd OBLIVIOUS-DEV\tools\operator
node oblivious-config.js init --file ..\..\secure-config\dev-local\config.enc
node oblivious-config.js set --provider openai --key "sk-..." --file ..\..\secure-config\dev-local\config.enc
```

`config.enc` is listed in `.gitignore` here — do not commit real secrets.
