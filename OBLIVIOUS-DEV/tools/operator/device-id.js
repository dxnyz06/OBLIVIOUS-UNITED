#!/usr/bin/env node
/**
 * OBLIVIOUS — Device ID viewer (stessa logica runtime DeviceId.js).
 *
 * Comandi:
 *   show (default)   Stampa device_id e componenti
 *   json             Output JSON su stdout
 *   save --file X    Salva JSON su file
 *   copy             Windows: copia ID negli appunti (clip)
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { requireService } = require("./lib/resolve-services");

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
  console.error("[device-id] " + msg);
  process.exit(2);
}

(async () => {
  const raw = process.argv.slice(2);
  if (raw.includes("-h") || raw.includes("--help")) {
    console.log(`
OBLIVIOUS Device ID (DeviceId.js dell'hub)

  show       device_id e componenti (default)
  json       JSON su stdout
  save       --file path (salva JSON)
  copy       Windows: clipboard (clip.exe)

-h, --help   questo messaggio
`);
    process.exit(0);
  }

  const a = argv();
  const cmd = (a._[0] || "show").toLowerCase();
  const d = deviceIdSync();

  if (cmd === "json") {
    console.log(JSON.stringify(d, null, 2));
    return;
  }

  if (cmd === "save") {
    const f = a.file || fail("save richiede --file path");
    fs.mkdirSync(path.dirname(path.resolve(f)), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(d, null, 2), "utf8");
    console.log(`[device-id] salvato ${path.resolve(f)}`);
    return;
  }

  if (cmd === "copy") {
    if (process.platform !== "win32") fail("copy supportato solo su Windows (usa clip.exe)");
    try {
      execSync("clip.exe", { input: d.id, stdio: ["pipe", "ignore", "ignore"] });
      console.log("[device-id] copiato negli appunti (64 hex)");
    } catch {
      fail("clip.exe fallito");
    }
    return;
  }

  console.log("device_id (SHA256):\n  " + d.id);
  console.log("\nComponenti:");
  console.log("  bios :", d.parts.bios);
  console.log("  mac  :", d.parts.mac);
  console.log("  guid :", d.parts.guid);
  console.log("  fully_fallback:", d.fullyFallback);
  console.log("\nPer licenza usa l’intera stringa device_id su una riga.");
})();
