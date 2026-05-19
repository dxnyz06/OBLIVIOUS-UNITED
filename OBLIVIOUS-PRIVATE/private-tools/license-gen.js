#!/usr/bin/env node
// OBLIVIOUS — license generator / verifier (PRIVATE TOOL).
// Uses same canonical JSON + RSA-PSS as runtime Licensing.js.
// Never ship private_key.pem or this folder on the VPS.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");

function fail(msg) {
  console.error("[license-gen] " + msg);
  process.exit(2);
}

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  if (i === -1) return def;
  return process.argv[i + 1];
}

function canonicalJson(obj) {
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  if (obj && typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
  }
  return JSON.stringify(obj);
}

function resolveLicensing() {
  const hubSvc = path.join(__dirname, "..", "..", "oblivious-hub", "src", "services", "Licensing.js");
  if (!fs.existsSync(hubSvc)) fail("cannot find oblivious-hub Licensing.js — run from workspace");
  return require(hubSvc);
}

function resolveDeviceId() {
  const hubSvc = path.join(__dirname, "..", "..", "oblivious-hub", "src", "services", "DeviceId.js");
  if (!fs.existsSync(hubSvc)) fail("cannot find DeviceId.js");
  return require(hubSvc).deviceIdSync;
}

async function cmdVerify() {
  const Licensing = resolveLicensing();
  const licPath = arg("license") || arg("lic");
  const pubPath = arg("pub") || arg("public");
  const deviceArg = arg("device");
  if (!licPath || !pubPath) fail("verify: --license and --pub required");
  const deviceId = (deviceArg || resolveDeviceId()().id).toLowerCase();
  const eng = new Licensing({
    licenseFile: licPath,
    publicKeyFile: pubPath,
    deviceId,
    required: true,
    telemetry: null,
  });
  const r = eng.verify();
  console.log(JSON.stringify({ ok: r.ok, reason: r.reason, snapshot: eng.snapshot() }, null, 2));
  process.exit(r.ok ? 0 : 1);
}

function cmdShow() {
  const licPath = arg("license") || arg("lic");
  if (!licPath || !fs.existsSync(licPath)) fail("show: --license path required");
  let lic;
  try {
    lic = JSON.parse(fs.readFileSync(licPath, "utf8"));
  } catch (e) {
    fail("parse error: " + e.message);
  }
  const { signature, ...rest } = lic;
  console.log(JSON.stringify(rest, null, 2));
  console.log("signature (base64, truncated):", String(signature).slice(0, 24) + "…");
}

async function cmdWizard() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((r) => rl.question(q, r));
  console.log("\n=== OBLIVIOUS License Generator (PRIVATE) ===\n");
  const priv =
    (await ask(`Percorso private_key.pem [${path.join(__dirname, "..", "keys", "private_key.pem")}]: `)).trim() ||
    path.join(__dirname, "..", "keys", "private_key.pem");
  if (!fs.existsSync(priv)) {
    rl.close();
    fail("private key non trovata: " + priv);
  }
  const customer = (await ask("Customer / nome licenza: ")).trim();
  const device = (await ask("device_id (64 hex dalla VPS): ")).trim().toLowerCase();
  const expires = (await ask("Scadenza ISO8601 [2027-12-31T23:59:59Z]: ")).trim() || "2027-12-31T23:59:59Z";
  const features = (
    await ask("Features CSV [predicted,grid,smc,ict]: ")
  ).trim() || "predicted,grid,smc,ict";
  const out =
    (await ask(`Output license.lic [${path.join(__dirname, "..", "generated-licenses", "license_new.lic")}]: `)).trim() ||
    path.join(__dirname, "..", "generated-licenses", "license_new.lic");
  rl.close();

  runGenerate({
    customer,
    device,
    expires,
    features,
    issued: new Date().toISOString(),
    priv,
    out,
    version: 1,
  });
}

function runGenerate(opts) {
  const customer = opts.customer;
  const device = opts.device;
  const expires = opts.expires;
  const features = opts.features;
  const issued = opts.issued;
  const priv = opts.priv;
  const out = opts.out;
  const version = opts.version || 1;

  if (!customer) fail("--customer is required");
  if (!device || !/^[0-9a-f]{64}$/.test(device))
    fail("--device must be 64 hex chars (from device-id tool on target machine)");
  if (!expires) fail("--expires is required (ISO8601)");
  if (!Date.parse(expires)) fail("--expires is not a valid date");
  if (!Date.parse(issued)) fail("--issued is not a valid date");
  if (!priv) fail("--priv (path to private_key.pem) is required");
  if (!fs.existsSync(priv)) fail(`private key not found: ${priv}`);
  if (!out) fail("--out (path to license.lic to write) is required");

  const payload = {
    v: version,
    customer,
    issued_at: new Date(issued).toISOString(),
    expires_at: new Date(expires).toISOString(),
    device_id: device.toLowerCase(),
    features,
  };
  const canon = canonicalJson(payload);
  const signer = crypto.createSign("sha256");
  signer.update(canon);
  let sig;
  try {
    const key = fs.readFileSync(priv);
    sig = signer.sign(
      { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
      "base64"
    );
  } catch (err) {
    fail("signing failed: " + err.message);
  }

  const lic = { ...payload, signature: sig };
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(lic, null, 2));
  console.log(`[license-gen] wrote ${out}`);
  console.log(`[license-gen] customer=${customer} device=${device.slice(0, 12)}… expires=${payload.expires_at}`);
}

function cmdGenerateDefault() {
  const customer = arg("customer");
  const device = arg("device");
  const expires = arg("expires");
  const features = (arg("features", "predicted,grid,smc,ict") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const issued = arg("issued", new Date().toISOString());
  const priv = arg("priv");
  const out = arg("out");
  const version = parseInt(arg("version", "1"), 10) || 1;

  runGenerate({
    customer,
    device,
    expires,
    features,
    issued,
    priv,
    out,
    version,
  });
}

function usage() {
  console.log(`
PRIVATE — license generator / verifier

  generate (default) — same flags as before:
    --customer --device --expires [--features] [--issued] --priv --out [--version]

  verify — usa Licensing.js dell'hub
    --license path --pub path  [--device hex]

  show — stampa JSON licenza senza verificare firma
    --license path

  wizard — prompt interattivi (TTY)

Non logga né stampa la private key.
`);
}

(async () => {
  const sub = process.argv[2];
  if (!sub || sub.startsWith("--")) {
    if (!sub) {
      usage();
      process.exit(0);
    }
    cmdGenerateDefault();
    return;
  }

  switch (sub) {
    case "generate":
      process.argv.splice(2, 1);
      cmdGenerateDefault();
      break;
    case "verify":
      await cmdVerify();
      break;
    case "show":
    case "show-license":
      cmdShow();
      break;
    case "wizard":
      await cmdWizard();
      break;
    case "-h":
    case "--help":
      usage();
      break;
    default:
      if (sub.startsWith("-")) cmdGenerateDefault();
      else {
        usage();
        process.exit(2);
      }
  }
})();
