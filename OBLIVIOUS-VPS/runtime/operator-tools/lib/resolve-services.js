/**
 * Risolve la cartella dei servizi hub (KeyVault, DeviceId, Licensing).
 * - In sviluppo: ../../../oblivious-hub/src/services
 * - Sul bundle VPS: cartella vendor/ copiata da build-vps.ps1 (stesso codice sorgente)
 */
const fs = require("fs");
const path = require("path");

function servicesDir() {
  const here = __dirname;
  const vendor = path.join(here, "..", "vendor");
  if (fs.existsSync(path.join(vendor, "KeyVault.js"))) return vendor;

  const hubDev = path.join(here, "..", "..", "..", "..", "oblivious-hub", "src", "services");
  if (fs.existsSync(path.join(hubDev, "KeyVault.js"))) return hubDev;

  throw new Error(
    "Impossibile trovare KeyVault.js: usa vendor/ sul bundle VPS oppure esegui dalla workspace con oblivious-hub."
  );
}

function requireService(name) {
  const dir = servicesDir();
  return require(path.join(dir, name));
}

module.exports = { servicesDir, requireService };
