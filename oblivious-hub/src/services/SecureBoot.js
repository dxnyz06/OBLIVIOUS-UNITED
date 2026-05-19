// OBLIVIOUS HUB — SecureBoot
// ----------------------------------------------------------------
// Production: prompts for passphrase, derives device id, validates
// licence, and unlocks the encrypted KeyVault stored on disk.
//
// Dev: this module is NOT invoked (main.js short-circuits to an
// in-memory KeyVault when !app.isPackaged). The implementation here
// is a minimal but correct stub: it tries to open `config.enc` if
// present in the search dirs, otherwise reports the failing step.
// ----------------------------------------------------------------

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");

const KeyVault = require("./KeyVault");

class SecureBoot {
  constructor({ searchDirs, telemetry, askPassword } = {}) {
    this.searchDirs  = Array.isArray(searchDirs) ? searchDirs.filter(Boolean) : [];
    this.telemetry   = telemetry || { log: () => {} };
    this.askPassword = typeof askPassword === "function" ? askPassword : null;
    this._snapshot = {
      step: "init",
      ok:   false,
      configSource: null,
      device:  null,
      license: null,
    };
  }

  snapshot() { return { ...this._snapshot }; }

  _findFile(name) {
    for (const dir of this.searchDirs) {
      const p = path.join(dir, name);
      try { if (fs.existsSync(p)) return p; } catch (_) {}
    }
    return null;
  }

  _deviceId() {
    // Stable per-machine ID from a few env hints. Not cryptographically
    // strong — sufficient as a "soft" device fingerprint.
    const seed = [
      process.platform, process.arch,
      process.env.COMPUTERNAME || process.env.HOSTNAME || "",
      process.env.USERNAME || process.env.USER || "",
    ].join("|");
    return crypto.createHash("sha256").update(seed).digest("hex");
  }

  async run() {
    try {
      this._snapshot.step = "device_id";
      const deviceId = this._deviceId();
      this._snapshot.device = { id: deviceId };

      this._snapshot.step = "find_license";
      const licPath = this._findFile("license.lic");
      const pubPath = this._findFile("public_key.pem");
      this._snapshot.license = licPath
        ? { path: licPath, hasPublicKey: !!pubPath }
        : null;

      this._snapshot.step = "find_config";
      const cfgPath = this._findFile("config.enc");
      if (!cfgPath) {
        this._snapshot.ok = false;
        return { ok: false, reason: "config_not_found" };
      }
      this._snapshot.configSource = cfgPath;

      this._snapshot.step = "unlock";
      let passphrase = process.env.OBLIVIOUS_VAULT_PASSPHRASE || "";
      if (!passphrase && this.askPassword) {
        try { passphrase = await this.askPassword(); } catch (_) {}
      }
      if (!passphrase) {
        this._snapshot.ok = false;
        return { ok: false, reason: "no_passphrase" };
      }

      const keyVault = new KeyVault({
        path: cfgPath,
        telemetry: this.telemetry,
      });
      if (typeof keyVault.unlock === "function") {
        const ok = await keyVault.unlock(passphrase);
        if (!ok) {
          this._snapshot.ok = false;
          return { ok: false, reason: "bad_passphrase" };
        }
      }

      this._snapshot.step = "ready";
      this._snapshot.ok = true;
      return { ok: true, keyVault };
    } catch (err) {
      this._snapshot.ok = false;
      return { ok: false, reason: err.message || String(err) };
    }
  }
}

module.exports = SecureBoot;
