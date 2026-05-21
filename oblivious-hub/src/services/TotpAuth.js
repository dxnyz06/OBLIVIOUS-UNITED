// OBLIVIOUS HUB — TotpAuth.
//
// RFC 6238 Time-based One-Time Password (TOTP) using HMAC-SHA1 and a
// 30-second time step. Used by `MobileGateway` to gate the
// `update_api_key` command behind a fresh 6-digit code typed on the
// admin device's authenticator app (Aegis / Google Authenticator /
// 1Password / Authy …). Pure standard, no dependencies.
//
// Secret format
//   Internally we store the raw 20-byte HMAC key. We expose it to the
//   authenticator app via the canonical base32 (RFC 4648) encoding
//   embedded in an `otpauth://totp/...` URI.
//
// Verification window
//   Default ±1 step (~90 s total) tolerates clock drift between the
//   server and the operator's phone without weakening security
//   measurably (the attacker still has to guess one of 3 codes in
//   ≤90 s and they don't know which one is active).

const crypto = require("crypto");

const TOTP_STEP   = 30;          // seconds
const TOTP_DIGITS = 6;
const B32_ALPH    = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPH[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPH[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s) {
  const norm = String(s || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out = [];
  let bits = 0, value = 0;
  for (const ch of norm) {
    const idx = B32_ALPH.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateSecret(byteLen = 20) {
  const raw = crypto.randomBytes(byteLen);
  return { raw, base32: base32Encode(raw) };
}

function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", secretBuf).update(buf).digest();
  const off  = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[off]     & 0x7f) << 24)
             | ((hmac[off + 1] & 0xff) << 16)
             | ((hmac[off + 2] & 0xff) << 8)
             | ((hmac[off + 3] & 0xff));
  const mod  = 10 ** TOTP_DIGITS;
  return String(code % mod).padStart(TOTP_DIGITS, "0");
}

function totp(secretBuf, t = Date.now()) {
  return hotp(secretBuf, Math.floor(t / 1000 / TOTP_STEP));
}

/** Verify a 6-digit code against a base32 secret, tolerating ±`window`
 *  time steps. Returns true on match, false otherwise. */
function verify(secretBase32, code, { window = 1, t = Date.now() } = {}) {
  if (!secretBase32 || !code) return false;
  const want = String(code).replace(/\s+/g, "");
  if (!/^\d{6}$/.test(want)) return false;
  const buf = base32Decode(secretBase32);
  if (buf.length < 10) return false;
  const counter = Math.floor(t / 1000 / TOTP_STEP);
  for (let i = -window; i <= window; i++) {
    const c = hotp(buf, counter + i);
    // Constant-time comparison — the strings are always 6 chars long.
    if (crypto.timingSafeEqual(Buffer.from(c), Buffer.from(want))) return true;
  }
  return false;
}

/** Build the `otpauth://totp/...` URI consumed by mobile authenticator
 *  apps. The mobile renders this URI as a QR code so the operator just
 *  scans it once during enrollment. */
function provisioningUri({ account, issuer = "Oblivious", secretBase32 }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = { generateSecret, verify, totp, provisioningUri, base32Encode, base32Decode };
