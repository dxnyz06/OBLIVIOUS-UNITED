# OBLIVIOUS HUB — DEV vs VPS build matrix

The Hub ships as **two distinct installers** that share the exact same
source code; only the runtime environment toggles which UI/IPC handlers
are reachable.

| Build       | Installer                            | UI visible                               | VPS Control Center | SSH Automatic | DEV unlock        |
|-------------|--------------------------------------|------------------------------------------|--------------------|---------------|-------------------|
| **DEV**     | `OBLIVIOUS-HUB-DEV-<v>.exe`          | Everything                               | ✅ enabled         | ✅ enabled    | n/a (always on)   |
| **VPS**     | `OBLIVIOUS-HUB-VPS-<v>.exe`          | API keys + bookmap + decision + EA only  | ❌ hidden          | ❌ hidden     | remote signed only |

## Build commands

```bash
# DEV build — full controls, used on the developer's own PC
yarn install
yarn build:dev          # → dist/dev/OBLIVIOUS-HUB-DEV-<version>.exe

# VPS client build — minimal UI, used on the VPS
yarn build:vps          # → dist/vps/OBLIVIOUS-HUB-VPS-<version>.exe
```

If you don't have `cross-env`, install it once:
```bash
yarn add -D cross-env electron-builder
```

## Runtime behaviour summary

* `OBLIVIOUS_MODE=vps`  → `deploymentMode() === "vps"`
  * `isDevEnvironment()` returns **false** unless the DEV operator pushes
    a signed unlock token via `hub:setDevUnlock` (`SecureBoot.verifyDevUnlockToken`).
  * All `vps:*` IPC handlers return `{ ok: false, reason: "dev_only" }`.
  * The renderer hides:
    * `#panel-vps` (entire VPS Control Center section)
    * any element tagged `data-dev-only`
* `OBLIVIOUS_DEV=1`    → forces DEV mode in a packaged build (used for
  authorised DEV machines that still want a signed installer).
* No env vars + packaged → `deploymentMode() === "client"`, VPS panel
  hidden but everything else visible.

## Remote DEV unlock (DEV → VPS)

1. From the **DEV** instance, generate a signed unlock token (RSA
   detached signature over `{ vpsDeviceId, exp, nonce }`).
2. Push it over the existing ZMQ_REQ channel (`zmq:vpsDevUnlock`).
3. The VPS instance verifies the signature with the operator's
   `public_key.pem` (already shipped for SecureBoot).
4. On success, `_remoteDevUnlocked` flips true and the VPS UI silently
   reveals the VPS panel for the duration of the token's TTL.
5. When the TTL expires the panel disappears again — no restart needed.

This means the operator can temporarily promote a VPS to "dev" without
ever exposing the developer-only controls to a static install on the
machine.
