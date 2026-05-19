/**
 * Verifica che un vault creato da `oblivious-config.js` sia leggibile da SecureBoot
 * con layout VPS split (config dir / licenses dir). Nessuna GUI Electron.
 *
 * Default paths:
 *   OBLIVIOUS-DEV/secure-config/e2e-roundtrip/config.enc
 *   OBLIVIOUS-VPS/licenses/
 *
 * Env:
 *   KEYVAULT_PASSPHRASE — obbligatoria (stessa usata con oblivious-config)
 */
const fs = require("fs");
const path = require("path");
const SecureBoot = require("./src/services/SecureBoot");

const repoRoot = path.join(__dirname, "..");
const cfgDir = path.join(repoRoot, "OBLIVIOUS-DEV", "secure-config", "e2e-roundtrip");
const licDir = path.join(repoRoot, "OBLIVIOUS-VPS", "licenses");
const configEnc = path.join(cfgDir, "config.enc");

(async () => {
  const pw = (process.env.KEYVAULT_PASSPHRASE || "").trim();
  if (!pw) {
    console.error("[FAIL] imposta KEYVAULT_PASSPHRASE (stessa password del vault)");
    process.exit(2);
  }
  if (!fs.existsSync(configEnc)) {
    console.error("[FAIL] manca", configEnc, "— eseguire prima oblivious-config init/set");
    process.exit(2);
  }

  const sb = new SecureBoot({
    searchDirs: [cfgDir, licDir],
    telemetry: null,
    requireLicense: true,
    askPassword: null,
  });
  const r = await sb.run();
  if (!r.ok) {
    console.error("[FAIL] SecureBoot", r.reason);
    process.exit(1);
  }
  const openai = r.keyVault.get("openai");
  const okKey = openai && openai.includes("e2e-placeholder");
  console.log(okKey ? "[PASS] SecureBoot ha decifrato il vault da oblivious-config" : "[FAIL] chiave openai inattesa");
  if (!okKey) process.exit(1);
  process.exit(0);
})().catch((e) => {
  console.error("[FATAL]", e.message);
  process.exit(2);
});
