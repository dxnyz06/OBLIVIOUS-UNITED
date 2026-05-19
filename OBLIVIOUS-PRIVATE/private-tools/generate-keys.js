#!/usr/bin/env node
// OBLIVIOUS — RSA keypair generator (one-shot, run ONCE per operator).
//
// Produces:
//   --priv  : private_key.pem  (PUT IN OBLIVIOUS-PRIVATE ONLY)
//   --pub   : public_key.pem   (DISTRIBUTE WITH THE VPS BUNDLE)
//
// Usage:
//   node generate-keys.js \
//       --priv ../../OBLIVIOUS-PRIVATE/private_key.pem \
//       --pub  ../../OBLIVIOUS-VPS/app/public_key.pem
//
// Skips silently if both target files already exist (idempotent).

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  if (i === -1) return def;
  return process.argv[i + 1];
}

const priv = arg("priv");
const pub  = arg("pub");
const force= process.argv.includes("--force");

if (!priv || !pub) {
  console.error("usage: generate-keys.js --priv <path> --pub <path> [--force]");
  process.exit(2);
}

if (!force && fs.existsSync(priv) && fs.existsSync(pub)) {
  console.log("[gen-keys] both keys already exist — skipping (use --force to overwrite)");
  process.exit(0);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding:  { type: "spki",  format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

fs.mkdirSync(path.dirname(path.resolve(priv)), { recursive: true });
fs.mkdirSync(path.dirname(path.resolve(pub)),  { recursive: true });
fs.writeFileSync(priv, privateKey, { mode: 0o600 });
fs.writeFileSync(pub,  publicKey);

console.log(`[gen-keys] private_key.pem  -> ${priv}`);
console.log(`[gen-keys] public_key.pem   -> ${pub}`);
console.log(`[gen-keys] WARNING: keep private_key.pem out of any VPS or repo.`);
