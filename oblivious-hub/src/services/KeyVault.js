// OBLIVIOUS HUB — KeyVault.
//
// Local AES-256-GCM key store, derived from a user passphrase via
// scrypt.  File layout (binary):
//
//   [magic 4B "OBLV"][salt 16B][iv 12B][tag 16B][ciphertext...]
//
// Plaintext is JSON: { "openai": "...", "anthropic": "...", ... }
//
// If no vault exists or the passphrase is empty/wrong, behaviour depends on
// `allowEnvFallback` (hub GUI disables this — see SecureBoot).

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const MAGIC      = Buffer.from("OBLV");
const SALT_LEN   = 16;
const IV_LEN     = 12;
const TAG_LEN    = 16;
const KEY_LEN    = 32;
const SCRYPT_N   = 1 << 15;
const SCRYPT_R   = 8;
const SCRYPT_P   = 1;

const PROVIDERS = ["openai", "anthropic", "google", "xai", "deepseek", "qwen", "perplexity", "bookmap"];
const ENV_MAP   = {
  openai:     "OPENAI_API_KEY",
  anthropic:  "ANTHROPIC_API_KEY",
  google:     "GOOGLE_API_KEY",
  xai:        "XAI_API_KEY",
  deepseek:   "DEEPSEEK_API_KEY",
  qwen:       "QWEN_API_KEY",
  perplexity: "PERPLEXITY_API_KEY",
};

class KeyVault {
  constructor({ file, passphrase, envFallback, telemetry, allowEnvFallback = false, inMemory = false } = {}) {
    this.file        = file;
    this.passphrase  = passphrase || "";
    this.envFallback = envFallback || {};
    this.telemetry   = telemetry;
    /** When false, env keys are never loaded (hub GUI path). Smoke sets true via SecureBoot. */
    this.allowEnvFallback = !!allowEnvFallback;
    /** In-memory mode (DEV only): no file I/O, no encryption, no passphrase needed. */
    this.inMemory    = !!inMemory;
    if (this.inMemory) this.passphrase = "__dev__"; // any non-empty value satisfies legacy guards
    this._keys       = {};
    this._source     = inMemory ? "in_memory_dev" : "uninitialized";
  }

  async unlock(pass) {
    if (this.inMemory) { this._source = "in_memory_dev"; return true; }
    this.passphrase = pass || "";
    await this.load();
    return this._source === "vault";
  }

  async load() {
    if (this.file && fs.existsSync(this.file) && this.passphrase) {
      try {
        const buf = fs.readFileSync(this.file);
        if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error("bad_magic");
        const salt = buf.subarray(4, 4 + SALT_LEN);
        const iv   = buf.subarray(4 + SALT_LEN, 4 + SALT_LEN + IV_LEN);
        const tag  = buf.subarray(4 + SALT_LEN + IV_LEN,
                                  4 + SALT_LEN + IV_LEN + TAG_LEN);
        const ct   = buf.subarray(4 + SALT_LEN + IV_LEN + TAG_LEN);
        const key  = await this._derive(this.passphrase, salt);
        const dec  = crypto.createDecipheriv("aes-256-gcm", key, iv);
        dec.setAuthTag(tag);
        const pt   = Buffer.concat([dec.update(ct), dec.final()]);
        const obj  = JSON.parse(pt.toString("utf8"));
        for (const p of PROVIDERS) {
          if (obj[p]) this._keys[p] = String(obj[p]);
        }
        this._source = "vault";
        if (this.telemetry) {
          this.telemetry.log("info", "KeyVault",
            `decrypted vault — ${Object.keys(this._keys).length} keys`);
        }
        return;
      } catch (err) {
        if (this.telemetry) {
          this.telemetry.log("warn", "KeyVault",
            `vault decrypt failed (${err.message}) — strict mode (no .env fallback)`);
        }
        this._keys = {};
        this._source = "vault_decrypt_failed";
        return;
      }
    }
    if (!this.allowEnvFallback) {
      this._keys = {};
      this._source = this.file && fs.existsSync(this.file) ? "vault_decrypt_failed" : "no_vault";
      if (this.telemetry) {
        this.telemetry.log("info", "KeyVault",
          `env fallback disabled — ${this._source}`);
      }
      return;
    }
    // ENV fallback (smoke / explicit OBLIVIOUS_KEYVAULT_ALLOW_ENV=1 tooling only)
    for (const p of PROVIDERS) {
      const v = (this.envFallback[ENV_MAP[p]] || "").trim();
      if (v) this._keys[p] = v;
    }
    this._source = "env";
    if (this.telemetry) {
      this.telemetry.log("info", "KeyVault",
        `env fallback — ${Object.keys(this._keys).length}/${PROVIDERS.length} keys`);
    }
  }

  async save(plainKeys) {
    if (!this.file)       throw new Error("vault_file_missing");
    if (!this.passphrase) throw new Error("passphrase_required");
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const salt = crypto.randomBytes(SALT_LEN);
    const iv   = crypto.randomBytes(IV_LEN);
    const key  = await this._derive(this.passphrase, salt);
    const enc  = crypto.createCipheriv("aes-256-gcm", key, iv);
    const pt   = Buffer.from(JSON.stringify(plainKeys), "utf8");
    const ct   = Buffer.concat([enc.update(pt), enc.final()]);
    const tag  = enc.getAuthTag();
    fs.writeFileSync(this.file, Buffer.concat([MAGIC, salt, iv, tag, ct]));
    this._keys  = { ...plainKeys };
    this._source = "vault";
  }

  async setProviderKey(provider, value) {
    if (!PROVIDERS.includes(provider)) throw new Error("unknown_provider");
    const next = { ...this._keys };
    if (value) next[provider] = String(value);
    else delete next[provider];
    if (this.inMemory) {
      // DEV path — keep keys volatile in RAM, never touch disk.
      this._keys = next;
      this._source = "in_memory_dev";
      return;
    }
    await this.save(next);
  }

  listProviders() { return PROVIDERS.slice(); }

  _derive(passphrase, salt) {
    return new Promise((resolve, reject) => {
      // maxmem must be >= 128 * N * r * p; default Node.js limit is 32 MB
      // so we lift it to 64 MB to fit N=2^15 r=8 p=1 comfortably.
      crypto.scrypt(
        passphrase,
        salt,
        KEY_LEN,
        { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 },
        (err, key) => (err ? reject(err) : resolve(key))
      );
    });
  }

  get(provider) { return this._keys[provider] || null; }
  has(provider) { return !!this._keys[provider]; }
  source() { return this._source; }
}

module.exports = KeyVault;
