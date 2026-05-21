# OBLIVIOUS HUB — DEV / VPS / SSH / DEPLOY  ·  Operator Manual

## 1. Build matrix — what you ship to which machine

| Target machine          | Installer                     | Has VPS Control Center | Has SSH Automatic | Has Mobile tab |
|-------------------------|-------------------------------|------------------------|-------------------|----------------|
| **Your own PC** (DEV)   | `OBLIVIOUS-HUB-DEV-<v>.exe`   | ✅                     | ✅                | n/a (removed)  |
| **Remote VPS** (client) | `OBLIVIOUS-HUB-VPS-<v>.exe`   | ❌ hidden              | ❌ hidden         | ❌             |

* Build commands (run on your DEV PC):
  ```bash
  yarn install
  yarn add -D cross-env electron-builder   # only once
  yarn build:dev   # → dist/dev/OBLIVIOUS-HUB-DEV-<v>.exe
  yarn build:vps   # → dist/vps/OBLIVIOUS-HUB-VPS-<v>.exe
  ```
* The VPS installer is what you upload + run on the VPS Windows host.
  Once installed it just sits there with `Oblivious Hub.exe`; the DEV
  side drives everything via SSH.

There are no `.bat` launchers in the main user flow. All operations
happen inside the GUI.

## 2. Where keys, profiles and configs live

| Artifact                         | Location                                        | Encrypted? | Who has it      |
|----------------------------------|-------------------------------------------------|------------|-----------------|
| SSH private key                  | `%LOCALAPPDATA%\Oblivious\ssh\vps_ed25519`      | NO         | DEV only        |
| SSH public key                   | `%LOCALAPPDATA%\Oblivious\ssh\vps_ed25519.pub`  | NO         | DEV + VPS       |
| Pinned host fingerprints (TOFU)  | `%LOCALAPPDATA%\Oblivious\ssh\known_hosts.json` | NO         | DEV only        |
| VPS profile (host/user/paths/fp) | `<configDir>/vps.profile.enc`                   | YES (AES-256-GCM) | DEV only |
| Vault config (API keys, passwords) | `<configDir>/config.enc`                      | YES (AES-256-GCM) | DEV + VPS |
| License + signing pubkey         | `<configDir>/license.lic`, `public_key.pem`     | NO (signed) | DEV + VPS      |

**Important**: no SSH private key ever ends up inside the VPS installer
(`extraResources` for VPS build does not include `~/.oblivious/ssh`).

## 3. The VPS CONTROL CENTER — what each tab and button does

The panel has 3 tabs. (The old "Mobile Devices" tab was removed because
it shipped half-finished and was not in the trading flow.)

### TAB 1 — CONNECTION · SSH

| Field                  | Meaning                                                                    |
|------------------------|----------------------------------------------------------------------------|
| SSH Host               | Public IP or DNS of your VPS                                               |
| SSH Port               | Usually 22                                                                 |
| SSH User               | Windows user account on the VPS that owns the Hub installation             |
| Bootstrap Password     | Used **only once** on first install, never persisted, never sent to disk   |
| Private Key Path       | Auto-filled with `%LOCALAPPDATA%\Oblivious\ssh\vps_ed25519`                |
| Public Key Path        | Auto-filled with the matching `.pub`                                       |
| Remote Install Path    | Folder on the VPS where the Hub installer placed `Oblivious Hub.exe`       |

Buttons:
* **GENERATE SSH KEYPAIR**  → creates an Ed25519 keypair in the SSH dir
  above. If a keypair already exists the UI asks for confirmation before
  overwriting (a fresh key would kill all existing access).
* **INSTALL KEY ON VPS**    → connects with the bootstrap password, runs
  `mkdir -p ~/.ssh && grep -qxF '<pub>' || echo '<pub>' >> ~/.ssh/authorized_keys`,
  pins the host SHA-256 fingerprint and **clears the bootstrap password
  from the UI immediately afterwards**.
* **TEST CONNECTION**       → tries `uname -a && uptime` over the new
  key-based session. Fingerprint mismatch = refusal.
* **SAVE VPS PROFILE**      → writes the profile (host/port/user/paths
  /fingerprint/last-status) to `vps.profile.enc` using your vault
  passphrase. The bootstrap password is stripped before saving.

A live `vps-log` console below the buttons prints every outcome.

### TAB 2 — ACCESS SECURITY

Application-level unlock key (separate from SSH):

* **GENERATE NEW KEY**   → fresh VPS unlock key for the runtime
* **ROTATE KEY**         → roll the unlock key, mark old one invalid
* **REVOKE ACCESS**      → drop the device binding
* **BIND FINGERPRINT**   → pair the VPS hardware id to the runtime
* **GENERATE RUNTIME**   → produce `config.enc` + `license.lic` +
                           `public_key.pem` + runtime bundle for shipping

These do **not** touch SSH and **do not** install anything on the VPS by
themselves. After a `GENERATE RUNTIME` use Tab 3 to deploy.

### TAB 3 — DEPLOY · REMOTE

Daily flow, all over key-based SSH:

* **DEPLOY RUNTIME**  → SFTP the local `OBLIVIOUS-VPS/` bundle to the
                        VPS install path. Source-clean, only what the
                        Hub needs at runtime.
* **PUSH CONFIG**     → uploads the freshly-encrypted `config.enc`
                        (after you change a password or an API key
                        from `SETUP DEV` → no file copying).
* **PUSH LICENSE**    → uploads `license.lic` + `public_key.pem`.
* **RESTART HUB**     → `taskkill /F /IM "Oblivious Hub.exe"` then
                        relaunches it as a detached process.
* **STOP HUB**        → kill only.
* **PULL LOGS**       → SFTP `logs\*` to `~/OBLIVIOUS-VPS-LOGS/`.
* **HEALTH CHECK**    → PowerShell one-liner returns hub PID, mem MB,
                        and existence of config / license / public_key.
                        Result drives the on-screen hub pill (LIVE /
                        DOWN / UNKNOWN) and updates `lastStatus` in the
                        encrypted profile.

## 4. Daily flow — bootstrap once, then it's all buttons

**First-time bootstrap (5 minutes)**:
1. Open Oblivious Hub (DEV)
2. VPS CONTROL CENTER → Tab 1
3. Fill Host / Port / User / Bootstrap Password
4. Click `GENERATE SSH KEYPAIR`
5. Click `INSTALL KEY ON VPS`  → fingerprint pinned, bootstrap pwd
   wiped from UI
6. Click `TEST CONNECTION` → SSH pill turns CONNECTED
7. Click `SAVE VPS PROFILE`
8. Switch to Tab 2, run `GENERATE RUNTIME`
9. Switch to Tab 3, `DEPLOY RUNTIME`, then `RESTART HUB`, then
   `HEALTH CHECK`

**Daily operations**:
* Change a password / API key in `SETUP DEV` → click `PUSH CONFIG` →
  `RESTART HUB`. Done, no file copying.
* Need new logs?  `PULL LOGS`.
* Want a quick status?  `HEALTH CHECK`.

## 5. Security guarantees (and limits)

What the system **does**:
* Pinned host fingerprint (TOFU) — refuses connection on mismatch.
* No bootstrap password is ever written to disk.
* The encrypted VPS profile uses AES-256-GCM with scrypt-derived key
  (`N=2^15, r=8, p=1`) from the operator's vault passphrase.
* SSH private key is mode-0600 and never copied off DEV.
* `installKey` is idempotent (`grep -qxF || echo`) — never duplicates.
* Public key install only happens during the explicit Tab 1 flow, never
  silently by Tab 3 actions.

What the system **does NOT** do (by design):
* Does **not** automatically log SSH config to your home `~/.ssh/`.
  Everything lives under `%LOCALAPPDATA%\Oblivious\ssh` to keep your
  personal/system SSH untouched.
* Does **not** auto-rotate the SSH key. Rotation is a deliberate
  `GENERATE SSH KEYPAIR` (with confirmation) + new `INSTALL KEY ON VPS`.
* Does **not** send any tick / trade payload over SSH.  Trading
  EX4 ↔ Electron remains on ZeroMQ as before.
* Does **not** ship the SSH private key into the VPS installer.

## 6. Troubleshooting

* `Host denied (verification failed)` → host fingerprint changed (the
  VPS was reimaged or the SSH daemon regenerated its key). Solution:
  delete the line for `<host>:<port>` from
  `%LOCALAPPDATA%\Oblivious\ssh\known_hosts.json` and re-run
  `INSTALL KEY ON VPS` (the only operation that pins a NEW host).
* `keypair_exists` on generate → confirm in the dialog to overwrite.
  Old key is no longer usable as soon as you do.
* `no_keypair` on test → run `GENERATE SSH KEYPAIR` first.
* `passphrase_required` on save profile → the vault passphrase is not
  set (you started DEV with a bypass). Run a full SETUP DEV first.
