// OBLIVIOUS HUB — secure boot smoke test (no Electron, no UI).
//
// Asserts that:
//   1. DeviceId.deviceIdSync() returns a valid sha256-hex
//   2. license.lic verifies against public_key.pem (signature + device + dates)
//   3. SecureBoot.run() resolves config.enc correctly through KeyVault
//   4. Wrong password → boot refused with reason "config_decrypt_failed"
//   5. Wrong device → boot refused with reason "device_mismatch"

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const Licensing = require("./src/services/Licensing");
const SecureBoot = require("./src/services/SecureBoot");
const KeyVault   = require("./src/services/KeyVault");
const { deviceIdSync } = require("./src/services/DeviceId");

let pass = 0, fail = 0;
function check(name, ok, extra = "") {
  if (ok) { pass++; console.log(`[PASS] ${name}${extra ? "  " + extra : ""}`); }
  else    { fail++; console.log(`[FAIL] ${name}  ${extra}`); }
}

(async () => {
  // 1. device id
  const dev = deviceIdSync();
  check("DeviceId is sha256 hex", /^[0-9a-f]{64}$/.test(dev.id), `id=${dev.id.slice(0,16)}…`);

  // Use a sandboxed app dir under TMP so we don't depend on the real one.
  const sandbox = path.join(os.tmpdir(), `oblv-secboot-smoke-${process.pid}`);
  fs.mkdirSync(sandbox, { recursive: true });

  // Use the real public_key.pem / license.lic from the new VPS layout.
  // Fall back to the legacy single-folder layout in case anyone runs this
  // smoke test against a pre-restructure tree.
  const candidates = [
    [path.join(__dirname, "..", "OBLIVIOUS-VPS", "licenses"),
     path.join(__dirname, "..", "OBLIVIOUS-VPS", "licenses")],
    [path.join(__dirname, "..", "OBLIVIOUS-VPS", "app"),
     path.join(__dirname, "..", "OBLIVIOUS-VPS", "app")],
  ];
  let realPub = null, realLic = null;
  for (const [pubDir, licDir] of candidates) {
    const p = path.join(pubDir, "public_key.pem");
    const l = path.join(licDir, "license.lic");
    if (fs.existsSync(p) && fs.existsSync(l)) { realPub = p; realLic = l; break; }
  }
  if (!realPub || !realLic) {
    console.error("[skip] public_key.pem / license.lic not found in OBLIVIOUS-VPS/{licenses,app}");
    process.exit(2);
  }
  fs.copyFileSync(realPub, path.join(sandbox, "public_key.pem"));
  fs.copyFileSync(realLic, path.join(sandbox, "license.lic"));

  // 2. license verifies against the bundled public key for this device
  const lic = new Licensing({
    licenseFile:   path.join(sandbox, "license.lic"),
    publicKeyFile: path.join(sandbox, "public_key.pem"),
    deviceId:      dev.id,
    required:      true,
    telemetry:     null,
  });
  const r = lic.verify();
  check("license signature + device match", r.ok, `reason=${r.reason}`);

  // 3. forge a config.enc with a known passphrase
  const PW = "test-pw-" + Date.now();
  const configEnc = path.join(sandbox, "config.enc");
  const seed = new KeyVault({ file: configEnc, passphrase: PW, envFallback: {}, telemetry: null });
  await seed.save({ openai: "sk-FAKE-12345", anthropic: "ak-FAKE-67890" });

  // 4. SecureBoot.run() with correct password — single-dir layout
  process.env.KEYVAULT_PASSPHRASE = PW;
  const sb = new SecureBoot({ searchDirs: [sandbox], telemetry: null, requireLicense: true, askPassword: null });
  const ok = await sb.run();
  check("SecureBoot OK with correct password", ok.ok, `reason=${ok.reason}`);
  check("SecureBoot loaded config.enc", ok.keyVault && ok.keyVault.source() === "vault");
  check("SecureBoot decrypted openai key", ok.keyVault && ok.keyVault.get("openai") === "sk-FAKE-12345");

  // 4b. Split layout: config.enc in configDir/, license.lic + public_key.pem in licensesDir/
  const splitConfigDir = path.join(os.tmpdir(), `oblv-secboot-cfg-${process.pid}`);
  const splitLicDir    = path.join(os.tmpdir(), `oblv-secboot-lic-${process.pid}`);
  fs.mkdirSync(splitConfigDir, { recursive: true });
  fs.mkdirSync(splitLicDir,    { recursive: true });
  fs.copyFileSync(configEnc, path.join(splitConfigDir, "config.enc"));
  fs.copyFileSync(realLic,   path.join(splitLicDir,    "license.lic"));
  fs.copyFileSync(realPub,   path.join(splitLicDir,    "public_key.pem"));
  const sbSplit = new SecureBoot({
    searchDirs: [splitConfigDir, splitLicDir],
    telemetry: null, requireLicense: true, askPassword: null,
  });
  const okSplit = await sbSplit.run();
  check("SecureBoot OK with SPLIT config/licenses dirs", okSplit.ok, `reason=${okSplit.reason}`);

  // 5. Wrong password → refused
  process.env.KEYVAULT_PASSPHRASE = "wrong-password";
  const sbBad = new SecureBoot({ searchDirs: [sandbox], telemetry: null, requireLicense: true, askPassword: null });
  const bad = await sbBad.run();
  check("SecureBoot REJECTS wrong password", !bad.ok, `reason=${bad.reason}`);
  check("Reason is config_decrypt_failed",   bad.reason === "config_decrypt_failed");

  // 6. Wrong device → license fails
  process.env.KEYVAULT_PASSPHRASE = PW;
  const wrongDevSandbox = path.join(os.tmpdir(), `oblv-secboot-smoke-wd-${process.pid}`);
  fs.mkdirSync(wrongDevSandbox, { recursive: true });
  fs.copyFileSync(realPub, path.join(wrongDevSandbox, "public_key.pem"));
  // hand-craft a license bound to a fake device by re-signing
  // Actually easier: test Licensing directly with a fake device id.
  const lic2 = new Licensing({
    licenseFile:   path.join(sandbox, "license.lic"),
    publicKeyFile: path.join(sandbox, "public_key.pem"),
    deviceId:      "deadbeef".repeat(8),
    required:      true,
    telemetry:     null,
  });
  const r2 = lic2.verify();
  check("Licensing REJECTS wrong device_id", !r2.ok && r2.reason === "device_mismatch");

  // cleanup
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(wrongDevSandbox, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(splitConfigDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(splitLicDir,    { recursive: true, force: true }); } catch {}

  console.log(`\n=== TOTAL: ${pass} pass, ${fail} fail ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("[FATAL]", e.message);
  console.error(e.stack);
  process.exit(2);
});
