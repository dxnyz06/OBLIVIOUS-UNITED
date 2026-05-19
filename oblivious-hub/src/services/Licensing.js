// OBLIVIOUS HUB — Licensing.
//
// Verifies a signed license.lic against a bundled public_key.pem.
//
// File format (deterministic JSON), example:
//
// {
//   "v": 1,
//   "customer":     "ACME Trading LLC",
//   "issued_at":    "2026-05-10T14:00:00Z",
//   "expires_at":   "2027-05-10T14:00:00Z",
//   "device_id":    "<sha256 hex>",
//   "features":     ["predicted","grid","smc","ict"],
//   "signature":    "<base64>"
// }
//
// `signature` covers the canonical JSON of the same object minus the
// "signature" field, RSASSA-PSS over SHA-256.
//
// The runtime verifies, in order:
//   1. file present and JSON-parseable
//   2. signature valid against public_key.pem
//   3. device_id matches the local DeviceId.id
//   4. now() between issued_at and expires_at
//
// All four are hard requirements when LICENSE_REQUIRED=true.  In
// development or if no license file is configured, a soft warning
// is emitted but the boot continues so unsigned developer builds
// stay usable.

const fs     = require("fs");
const crypto = require("crypto");

function canonicalJson(obj) {
  // Stable key ordering — same routine the license generator uses.
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  if (obj && typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
  }
  return JSON.stringify(obj);
}

class Licensing {
  /**
   * @param {object} opts
   * @param {string} opts.licenseFile  path to license.lic (binary or JSON)
   * @param {string} opts.publicKeyFile path to public_key.pem
   * @param {string} opts.deviceId      sha256 hex from DeviceId.deviceIdSync()
   * @param {boolean} opts.required     if true, missing/invalid blocks boot
   * @param {object} opts.telemetry
   */
  constructor({ licenseFile, publicKeyFile, deviceId, required, telemetry }) {
    this.licenseFile   = licenseFile;
    this.publicKeyFile = publicKeyFile;
    this.deviceId      = deviceId;
    this.required      = !!required;
    this.telemetry     = telemetry;
    this._snap = {
      ok: false,
      reason: "uninitialized",
      customer: null,
      issued_at: null,
      expires_at: null,
      features: [],
      device_match: false,
    };
  }

  /**
   * @returns {{ok: boolean, reason: string, license: object|null}}
   */
  verify() {
    if (!this.licenseFile || !fs.existsSync(this.licenseFile)) {
      const reason = "license_missing";
      this._snap.reason = reason;
      this._log("warn", `license.lic not found at ${this.licenseFile}`);
      return { ok: !this.required, reason, license: null };
    }
    if (!this.publicKeyFile || !fs.existsSync(this.publicKeyFile)) {
      const reason = "public_key_missing";
      this._snap.reason = reason;
      this._log("error", `public_key.pem not found at ${this.publicKeyFile}`);
      return { ok: false, reason, license: null };
    }

    let raw, lic, sig;
    try {
      raw = fs.readFileSync(this.licenseFile, "utf8");
      lic = JSON.parse(raw);
      sig = lic.signature;
      if (!sig || typeof sig !== "string") throw new Error("no_signature");
    } catch (err) {
      const reason = "license_parse_failed";
      this._snap.reason = reason;
      this._log("error", `license parse failed: ${err.message}`);
      return { ok: false, reason, license: null };
    }

    const verify = crypto.createVerify("sha256");
    const payload = { ...lic };
    delete payload.signature;
    verify.update(canonicalJson(payload));
    let pubKey;
    try {
      pubKey = fs.readFileSync(this.publicKeyFile);
    } catch (err) {
      const reason = "public_key_read_failed";
      this._snap.reason = reason;
      this._log("error", `public key read failed: ${err.message}`);
      return { ok: false, reason, license: null };
    }

    let sigOk = false;
    try {
      sigOk = verify.verify(
        { key: pubKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
        Buffer.from(sig, "base64")
      );
    } catch (err) {
      this._log("error", `signature verify threw: ${err.message}`);
    }
    if (!sigOk) {
      const reason = "bad_signature";
      this._snap.reason = reason;
      this._log("error", "license signature invalid — refusing to boot");
      return { ok: false, reason, license: null };
    }

    // Time bounds.
    const now = Date.now();
    const issued  = Date.parse(lic.issued_at  || "");
    const expires = Date.parse(lic.expires_at || "");
    if (!isFinite(issued) || !isFinite(expires)) {
      const reason = "license_dates_invalid";
      this._snap.reason = reason;
      return { ok: false, reason, license: lic };
    }
    if (now < issued) {
      const reason = "license_not_yet_valid";
      this._snap.reason = reason;
      return { ok: false, reason, license: lic };
    }
    if (now > expires) {
      const reason = "license_expired";
      this._snap.reason = reason;
      return { ok: false, reason, license: lic };
    }

    // Device binding.
    const devOk = lic.device_id && lic.device_id === this.deviceId;
    if (!devOk) {
      const reason = "device_mismatch";
      this._snap.reason = reason;
      this._snap.device_match = false;
      this._log("error",
        `license bound to device ${String(lic.device_id).slice(0,12)}…, ` +
        `this device is ${String(this.deviceId).slice(0,12)}…`);
      return { ok: false, reason, license: lic };
    }

    this._snap = {
      ok: true,
      reason: "ok",
      customer:    lic.customer    || "(unset)",
      issued_at:   lic.issued_at   || null,
      expires_at:  lic.expires_at  || null,
      features:    Array.isArray(lic.features) ? lic.features : [],
      device_match: true,
    };
    this._log("info", `license OK — customer=${this._snap.customer} ` +
                       `expires=${this._snap.expires_at}`);
    return { ok: true, reason: "ok", license: lic };
  }

  snapshot() { return { ...this._snap }; }

  _log(level, msg) {
    if (this.telemetry) this.telemetry.log(level, "Licensing", msg);
    else console.log(`[Licensing] ${level}: ${msg}`);
  }
}

Licensing.canonicalJson = canonicalJson;
module.exports = Licensing;
