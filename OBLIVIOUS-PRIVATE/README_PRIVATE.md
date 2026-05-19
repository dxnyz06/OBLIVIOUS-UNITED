# OBLIVIOUS — PRIVATE (operator-only)

**This folder must never be copied to the VPS, never pushed to a
git remote, never shared.**  It contains the long-term licensing
material that, if leaked, allows an attacker to mint valid
`license.lic` files for any device.

```
OBLIVIOUS-PRIVATE/
├─ keys/
│  ├─ private_key.pem                  RSA-2048 PKCS#8 PEM (mode 0o600)
│  └─ public_key.pem                   reference copy of the public half
├─ private-tools/
│  ├─ generate-keys.js                 one-shot keypair generator (rotation)
│  ├─ license-gen.js                   RSA-PSS license signer (canonical JSON)
│  └─ Run-License-Generator.bat        wrapper Windows → `node license-gen.js …`
├─ generated-licenses/
│  └─ license_<device_id>.lic          archive of every issued license (audit trail)
├─ secure-seeds/
│  └─ README.txt                       reminder for operator master passphrases / OOB notes
├─ docs/                               private operator runbooks (currently empty)
├─ manifests/                          who got what license when (currently empty)
├─ _review_needed/                     anything ambiguous (currently empty)
└─ README_PRIVATE.md                   this file
```

## What MUST stay here

| File / folder                | Why it's private                                        |
|------------------------------|---------------------------------------------------------|
| `keys/private_key.pem`       | sole authority that mints valid licenses                |
| `private-tools/`             | uses the private key to sign — keep paired with the key |
| `generated-licenses/`        | audit trail of issued licenses                          |
| `secure-seeds/`              | operator's master passphrases (paper / OOB notes)       |

## Vault passphrase (DEV/VPS) vs PRIVATE signing keys

The passphrase typed into the **OBLIVIOUS configuration unlock** dialog decrypts **`config.enc`** (`KeyVault`). It has nothing to do with **`private_key.pem`**, which is used exclusively to **sign** `license.lic`. Never use or distribute private-key-derived secrets as the vault passphrase on the VPS bundle.

Rotating the **VPS vault passphrase** (re-encrypting `OBLIVIOUS-VPS/config/config.enc`) is done from the operator workstation via **`OBLIVIOUS SETUP DEV.exe`** (sezione **Password VPS**) — UX ufficiale unica. Il legacy CLI `oblivious-config.js change-password` è stato spostato in **`OBLIVIOUS-DEV/tools/_legacy_cli/`** e non è più il percorso utente. La rotazione passphrase **non** tocca **`private_key.pem`**.

## Routine: issue a license for a new VPS

1. **Sulla VPS** (bundle dopo `build-vps.ps1`): apri `runtime\operator-tools\`, installa Node.js LTS se manca, poi esegui **`Run-Device-ID.bat json`** (o `show`). Copia il valore **`id`** (64 caratteri esadecimali).

   In alternativa, un primo avvio dell’hub senza licenza valida può loggare il `device_id` in console prima del rifiuto — ma lo strumento dedicato è il metodo operativo previsto.

2. **Sul tuo PC**, dalla cartella `private-tools/`:

   - GUI terminale guidata: **`Run-License-Generator.bat wizard`**
   - oppure CLI:

   ```powershell
   node private-tools/license-gen.js `
        generate `
        --customer "ACME Trading LLC"             `
        --device   eefa976bc67a88f8…64hex         `
        --expires  2027-12-31T23:59:59Z           `
        --features predicted,grid,smc,ict         `
        --priv     ./keys/private_key.pem         `
        --out      ./generated-licenses/license_<deviceid>.lic
   ```

   Verifica locale opzionale:

   ```powershell
   node private-tools/license-gen.js verify --lic ./generated-licenses/license_<deviceid>.lic --pub ../OBLIVIOUS-VPS/licenses/public_key.pem
   ```

   Sul PC di sviluppo puoi anche usare **`OBLIVIOUS-DEV/tools/operator/license-check.js`** con `--license` e `--pub` (stesso motore **`Licensing.js`** dell’hub).

3. Invia **solo** il file `.lic` all’operatore su canale sicuro. Loro lo collocano in **`OBLIVIOUS-VPS/licenses/license.lic`**.

4. **Non** copiare mai sulla VPS: `private_key.pem`, `license-gen.js`, `Run-License-Generator.bat`, né l’intera `OBLIVIOUS-PRIVATE/`.

## Routine: rotate the keypair

1. ```powershell
   node private-tools/generate-keys.js `
        --priv ./keys/private_key.pem `
        --pub  ./keys/public_key.pem  `
        --force
   ```
2. Distribute the new `public_key.pem` to **every** VPS bundle
   (drop into `OBLIVIOUS-VPS/licenses/public_key.pem`).
3. Re-issue every active `license.lic` with the new private key.
4. Securely destroy the old `private_key.pem`.

## Threat model — what we DO and DO NOT defend against

We DEFEND against:

* casual copy of the runtime to a different machine (license is
  bound to `device_id`)
* casual extraction of API keys from the bundle (`.env` does not
  ship; `config.enc` requires the operator's password)
* a renderer-side XSS reading API keys (the Electron renderer is
  contextIsolated, sandboxed, with a whitelisted preload)
* a malformed / expired / forged license (RSA-PSS + dates + device)

We DO NOT claim to defend against:

* a determined attacker with **local administrator + memory dump**
  on the running VPS
* a debugger attached to `Oblivious Hub.exe` while running
* leakage of `private_key.pem` (game over — rotate immediately)
* leakage of an operator's password and `config.enc` together

JS-side obfuscation buys some friction but is **not** a security
boundary.  When the deployment matures, the most sensitive logic
should migrate to a compiled native module loaded by the main
process (out of scope for this iteration).

## What goes ELSEWHERE

| File | Belongs in |
|------|------------|
| `public_key.pem` (deployable half) | `OBLIVIOUS-VPS/licenses/` on each VPS bundle |
| Issued `license.lic` for a VPS | `OBLIVIOUS-VPS/licenses/` for that machine only |
| `config.enc` (encrypted vault) | `OBLIVIOUS-VPS/config/` for that machine only |
| Live hub / plugin / MQ4 sources | **Workspace root** — never duplicated here for “convenience signing” |

**Strumenti di firma (`license-gen.js`, `Run-License-Generator.bat`, `generate-keys.js`) restano solo in `private-tools/`** — non copiarli in DEV o VPS. Sulla VPS, dopo `build-vps.ps1`, in `runtime/operator-tools/` restano **solo** `Run-Device-ID.bat` e `Run-License-Check.bat` (la gestione password / API key è esclusiva di **`OBLIVIOUS SETUP VPS.exe`**).

### Verifica flusso licenza (stesso PC / laboratorio)

Su questa macchina è stato verificato: `device-id` → `license-gen generate` → `license-check verify` → `node _secure_boot_smoke.js` con `license.lic` temporaneamente sostituita e **ripristino** del file bundle al termine. Per una VPS **remota** ripeti gli stessi passi usando il `device_id` letto sul server e distribuendo solo il `.lic`.
