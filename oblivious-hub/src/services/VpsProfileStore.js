// OBLIVIOUS HUB — VpsProfileStore.
//
// Encrypted on-disk store for the VPS profile. Same AES-256-GCM /
// scrypt envelope as KeyVault, but separate file → updating an API key
// never touches the SSH connection settings (and vice-versa).
//
// File layout (binary):
//   [magic 4B "OBVP"][salt 16B][iv 12B][tag 16B][ciphertext...]
// Plaintext is JSON: {host, port, user, privateKeyPath, publicKeyPath,
//                     remoteInstallPath, hostFingerprint, lastDeploy,
//                     lastStatus, ...}

const fs       = require("fs");
const path     = require("path");
const crypto   = require("crypto");

const MAGIC    = Buffer.from("OBVP");
const SALT_LEN = 16;
const IV_LEN   = 12;
const TAG_LEN  = 16;
const KEY_LEN  = 32;
const SCRYPT_N = 1 << 15, SCRYPT_R = 8, SCRYPT_P = 1;

class VpsProfileStore {
  constructor({ file, passphrase, telemetry } = {}) {
    this.file       = file;
    this.passphrase = passphrase || "";
    this.telemetry  = telemetry;
    this._profile   = null;
  }

  hasFile() { return !!this.file && fs.existsSync(this.file); }

  async load() {
    if (!this.hasFile() || !this.passphrase) { this._profile = null; return null; }
    try {
      const buf = fs.readFileSync(this.file);
      if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error("bad_magic");
      const salt = buf.subarray(4, 4 + SALT_LEN);
      const iv   = buf.subarray(4 + SALT_LEN, 4 + SALT_LEN + IV_LEN);
      const tag  = buf.subarray(4 + SALT_LEN + IV_LEN, 4 + SALT_LEN + IV_LEN + TAG_LEN);
      const ct   = buf.subarray(4 + SALT_LEN + IV_LEN + TAG_LEN);
      const key  = await this._derive(this.passphrase, salt);
      const dec  = crypto.createDecipheriv("aes-256-gcm", key, iv);
      dec.setAuthTag(tag);
      const pt   = Buffer.concat([dec.update(ct), dec.final()]);
      this._profile = JSON.parse(pt.toString("utf8"));
      this._log("info", "VPS profile decrypted");
      return this._profile;
    } catch (err) {
      this._log("warn", `VPS profile decrypt failed: ${err.message}`);
      this._profile = null;
      return null;
    }
  }

  async save(profile) {
    if (!this.file) throw new Error("profile_file_missing");
    if (!this.passphrase) throw new Error("passphrase_required");
    // Defensive: NEVER persist the bootstrap password.
    const clean = { ...profile };
    delete clean.bootstrapPassword;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const salt = crypto.randomBytes(SALT_LEN);
    const iv   = crypto.randomBytes(IV_LEN);
    const key  = await this._derive(this.passphrase, salt);
    const enc  = crypto.createCipheriv("aes-256-gcm", key, iv);
    const pt   = Buffer.from(JSON.stringify(clean), "utf8");
    const ct   = Buffer.concat([enc.update(pt), enc.final()]);
    const tag  = enc.getAuthTag();
    fs.writeFileSync(this.file, Buffer.concat([MAGIC, salt, iv, tag, ct]));
    this._profile = clean;
    this._log("info", "VPS profile saved (encrypted)");
  }

  current() { return this._profile ? { ...this._profile } : null; }

  /** Convenience — update individual fields without ever requiring the caller
   *  to repeat unchanged ones. */
  async patch(partial) {
    const next = { ...(this._profile || {}), ...partial };
    await this.save(next);
    return this._profile;
  }

  _derive(passphrase, salt) {
    return new Promise((resolve, reject) => {
      crypto.scrypt(passphrase, salt, KEY_LEN,
        { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 },
        (err, key) => (err ? reject(err) : resolve(key)));
    });
  }

  _log(level, msg) {
    if (this.telemetry && typeof this.telemetry.log === "function") {
      this.telemetry.log(level, "VpsProfileStore", msg);
    }
  }
}

module.exports = VpsProfileStore;
