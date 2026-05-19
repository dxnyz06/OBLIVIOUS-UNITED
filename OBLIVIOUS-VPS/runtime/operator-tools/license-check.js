#!/usr/bin/env node
/**
 * OBLIVIOUS — License checker (usa Licensing.js + DeviceId.js dell'hub).
 *
 *   verify [--license path] [--pub path] [--device hex|opzionale]
 *
 * Senza --device: usa il device_id locale e verifica binding come SecureBoot.
 * Con --device: verifica firma + date + confronto con quel device_id (audit).
 */

const fs = require("fs");
const { requireService } = require("./lib/resolve-services");

const Licensing = requireService("Licensing.js");
const { deviceIdSync } = requireService("DeviceId.js");

function argv() {
  const out = { _: [] };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    if (x.startsWith("--")) {
      const k = x.slice(2);
      const v = a[i + 1];
      if (!v || v.startsWith("--")) out[k] = true;
      else {
        out[k] = v;
        i++;
      }
    } else out._.push(x);
  }
  return out;
}

function fail(msg) {
  console.error("[license-check] " + msg);
  process.exit(2);
}

(async () => {
  const raw = process.argv.slice(2);
  if (raw.includes("-h") || raw.includes("--help")) {
    console.log(`
OBLIVIOUS License Checker (Licensing.js + DeviceId.js dell'hub)

  verify [--license path] [--pub path] [--device hex]

Senza --device: usa il device_id locale.

-h, --help   questo messaggio
`);
    process.exit(0);
  }

  const a = argv();
  const cmd = (a._[0] || "verify").toLowerCase();
  const licPath =
    a.license ||
    a.lic ||
    fail("usa --license path\\license.lic");
  const pubPath =
    a.pub ||
    a.public ||
    fail("usa --pub path\\public_key.pem");

  if (!fs.existsSync(licPath)) fail("license non trovata: " + licPath);
  if (!fs.existsSync(pubPath)) fail("public key non trovata: " + pubPath);

  const localDev = deviceIdSync().id;
  const deviceId = (a.device || localDev).toLowerCase().trim();

  if (!/^[0-9a-f]{64}$/.test(deviceId))
    fail("--device deve essere 64 caratteri esadecimali (o omesso per usare questo PC)");

  const licEngine = new Licensing({
    licenseFile: licPath,
    publicKeyFile: pubPath,
    deviceId,
    required: true,
    telemetry: null,
  });

  if (cmd === "verify" || cmd === "check") {
    const r = licEngine.verify();
    const snap = licEngine.snapshot();
    console.log("esito:", r.ok ? "VALIDA" : "NON VALIDA");
    console.log("reason:", r.reason);
    if (r.license) {
      console.log("customer:", r.license.customer);
      console.log("issued_at:", r.license.issued_at);
      console.log("expires_at:", r.license.expires_at);
      console.log("device_id (file):", r.license.device_id);
      console.log("device_id (check):", deviceId);
      console.log("match:", r.license.device_id === deviceId);
      console.log("features:", JSON.stringify(r.license.features || []));
    }
    process.exit(r.ok ? 0 : 1);
  }

  fail("comando sconosciuto (usa: verify)");
})();
