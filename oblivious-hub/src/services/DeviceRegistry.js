// OBLIVIOUS HUB — DeviceRegistry.
// Encrypted persistent store of paired mobile devices.  File layout
// identical to VpsProfileStore: [OBDR 4B][salt 16][iv 12][tag 16][ct...]
// Plaintext JSON: { devices: [...], policy: {...}, updatedAt }
//
// Each device entry:
//   { device_id, device_name, platform, paired_at, last_seen, status,
//     role, revoked, session_state, secret_hash }
// `secret_hash` is the scrypt of the long-lived per-device credential —
// the raw secret is sent ONCE at pairing and NEVER persisted server-side.

const fs       = require("fs");
const path     = require("path");
const crypto   = require("crypto");

const MAGIC    = Buffer.from("OBDR");
const SALT_LEN = 16;
const IV_LEN   = 12;
const TAG_LEN  = 16;
const KEY_LEN  = 32;
const N_ = 1 << 15, R_ = 8, P_ = 1;

class DeviceRegistry {
  constructor({ file, passphrase, telemetry } = {}) {
    this.file       = file;
    this.passphrase = passphrase || "__dev_bypass__";
    this.telemetry  = telemetry;
    this._state     = { devices: [], policy: { mobile_enabled: true } };
  }

  hasFile() { return !!this.file && fs.existsSync(this.file); }

  async load() {
    if (!this.hasFile()) { return this._state; }
    try {
      const buf  = fs.readFileSync(this.file);
      if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error("bad_magic");
      const salt = buf.subarray(4, 4 + SALT_LEN);
      const iv   = buf.subarray(4 + SALT_LEN, 4 + SALT_LEN + IV_LEN);
      const tag  = buf.subarray(4 + SALT_LEN + IV_LEN, 4 + SALT_LEN + IV_LEN + TAG_LEN);
      const ct   = buf.subarray(4 + SALT_LEN + IV_LEN + TAG_LEN);
      const key  = await this._derive(this.passphrase, salt);
      const dec  = crypto.createDecipheriv("aes-256-gcm", key, iv);
      dec.setAuthTag(tag);
      const pt   = Buffer.concat([dec.update(ct), dec.final()]);
      this._state = JSON.parse(pt.toString("utf8"));
      this._state.devices = this._state.devices || [];
      this._state.policy  = this._state.policy  || { mobile_enabled: true };
      this._log("info", `DeviceRegistry loaded (${this._state.devices.length} devices)`);
      return this._state;
    } catch (err) {
      this._log("warn", `DeviceRegistry decrypt failed: ${err.message} — starting empty`);
      this._state = { devices: [], policy: { mobile_enabled: true } };
      return this._state;
    }
  }

  async save() {
    if (!this.file) throw new Error("registry_file_missing");
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const salt = crypto.randomBytes(SALT_LEN);
    const iv   = crypto.randomBytes(IV_LEN);
    const key  = await this._derive(this.passphrase, salt);
    const enc  = crypto.createCipheriv("aes-256-gcm", key, iv);
    this._state.updatedAt = new Date().toISOString();
    const pt   = Buffer.from(JSON.stringify(this._state), "utf8");
    const ct   = Buffer.concat([enc.update(pt), enc.final()]);
    const tag  = enc.getAuthTag();
    fs.writeFileSync(this.file, Buffer.concat([MAGIC, salt, iv, tag, ct]));
  }

  policy()           { return { ...this._state.policy }; }
  setPolicy(patch)   { this._state.policy = { ...this._state.policy, ...patch }; return this.save(); }
  list()             { return this._state.devices.map((d) => ({
    ...d, secret_hash: undefined, totp_secret: undefined,
    totp_active: !!d.totp_active,
  })); }

  /** Register a brand-new device. The raw `secret` is returned ONCE so the
   *  mobile can persist it locally; the server only keeps its scrypt hash. */
  async register({ device_name, platform, role = "viewer" }) {
    const device_id = crypto.randomBytes(8).toString("hex");
    const secret    = crypto.randomBytes(32).toString("base64url");
    const salt      = crypto.randomBytes(16);
    const hash      = await this._derive(secret, salt);
    const now       = new Date().toISOString();
    const entry = {
      device_id, device_name, platform, role,
      paired_at: now, last_seen: now,
      status: "authorized", revoked: false,
      secret_hash: Buffer.concat([salt, hash]).toString("base64"),
    };
    this._state.devices.push(entry);
    await this.save();
    return { device_id, secret, entry: { ...entry, secret_hash: undefined } };
  }

  /** Verify (device_id, secret) → returns the device or null on mismatch. */
  async authenticate(device_id, secret) {
    const d = this._state.devices.find((x) => x.device_id === device_id);
    if (!d || d.revoked) return null;
    const blob = Buffer.from(d.secret_hash || "", "base64");
    if (blob.length < 16) return null;
    const salt = blob.subarray(0, 16);
    const want = blob.subarray(16);
    const got  = await this._derive(secret, salt);
    if (!crypto.timingSafeEqual(want, got)) return null;
    d.last_seen = new Date().toISOString();
    d.status    = "connected";
    await this.save();
    return d;
  }

  async revoke(device_id) {
    const d = this._state.devices.find((x) => x.device_id === device_id);
    if (!d) return false;
    d.revoked = true;
    d.status  = "revoked";
    await this.save();
    return true;
  }

  /** Stage a TOTP secret for a device (admin enrollment). The secret is
   *  marked `totp_active=false` until the device confirms with a fresh
   *  code via `activateTotp()` — until then `verifyTotp()` returns false. */
  async setTotpSecret(device_id, secretBase32) {
    const d = this._state.devices.find((x) => x.device_id === device_id);
    if (!d) return false;
    d.totp_secret = secretBase32;
    d.totp_active = false;
    await this.save();
    return true;
  }

  async activateTotp(device_id) {
    const d = this._state.devices.find((x) => x.device_id === device_id);
    if (!d || !d.totp_secret) return false;
    d.totp_active = true;
    d.totp_enrolled_at = new Date().toISOString();
    await this.save();
    return true;
  }

  async clearTotp(device_id) {
    const d = this._state.devices.find((x) => x.device_id === device_id);
    if (!d) return false;
    delete d.totp_secret;
    delete d.totp_active;
    delete d.totp_enrolled_at;
    await this.save();
    return true;
  }

  /** Return the raw base32 secret for the device — caller is responsible
   *  for never sending it back to the wire after enrollment confirmation. */
  getTotpSecret(device_id) {
    const d = this._state.devices.find((x) => x.device_id === device_id);
    return (d && d.totp_secret) ? d.totp_secret : null;
  }

  isTotpActive(device_id) {
    const d = this._state.devices.find((x) => x.device_id === device_id);
    return !!(d && d.totp_active && d.totp_secret);
  }

  async markOffline(device_id) {
    const d = this._state.devices.find((x) => x.device_id === device_id);
    if (!d) return;
    d.status = "offline";
    await this.save();
  }

  _derive(passphrase, salt) {
    return new Promise((resolve, reject) => {
      crypto.scrypt(passphrase, salt, KEY_LEN,
        { N: N_, r: R_, p: P_, maxmem: 64 * 1024 * 1024 },
        (err, k) => (err ? reject(err) : resolve(k)));
    });
  }

  _log(level, msg) {
    if (this.telemetry && typeof this.telemetry.log === "function") {
      this.telemetry.log(level, "DeviceRegistry", msg);
    }
  }
}

module.exports = DeviceRegistry;
