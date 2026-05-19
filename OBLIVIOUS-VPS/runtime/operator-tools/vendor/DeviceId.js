// OBLIVIOUS HUB — DeviceId.
//
// Returns a stable per-machine fingerprint used by the licensing
// subsystem to bind a license.lic to a specific VPS / PC.
//
// We blend three independent signals so a single one being unstable
// (e.g. a NIC swap, a Windows reinstall keeping the same hardware)
// does not silently invalidate the license.  Each signal is hashed
// individually and the final id is the SHA-256 of the sorted,
// concatenated triplet.
//
//   1. ComputerSystemProduct.UUID  (from WMI / wmic)
//   2. primary physical NIC MAC    (sorted, ignoring loopback / virtual)
//   3. Windows MachineGuid         (HKLM\SOFTWARE\Microsoft\Cryptography)
//
// All three are read with a hard timeout and fall back to a stable
// constant on error so the function never throws.  The presence
// of "fallback" tokens is included verbatim in the digest input,
// so a fully-fallback fingerprint is still deterministic but
// trivially distinguishable in a license audit.

const crypto      = require("crypto");
const os          = require("os");
const { execSync }= require("child_process");

const TIMEOUT_MS = 1500;
const FB_PREFIX  = "fb:";

function safeExec(cmd) {
  try {
    return execSync(cmd, { timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim();
  } catch {
    return "";
  }
}

function readBiosUuid() {
  // PowerShell first (more reliable on modern Windows than wmic).
  const ps = safeExec(
    'powershell -NoProfile -Command "(Get-CimInstance Win32_ComputerSystemProduct).UUID"'
  );
  const m = ps.match(/[0-9a-fA-F-]{32,36}/);
  if (m) return m[0].toLowerCase();
  // wmic fallback (Windows 10/11 still has it as deprecated).
  const wm = safeExec("wmic csproduct get UUID");
  const m2 = wm.match(/[0-9a-fA-F-]{32,36}/);
  if (m2) return m2[0].toLowerCase();
  return FB_PREFIX + "no-bios";
}

function readPrimaryMac() {
  const ifs = os.networkInterfaces();
  const macs = [];
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name]) {
      if (i.internal) continue;
      if (!i.mac || i.mac === "00:00:00:00:00:00") continue;
      // skip clearly-virtual NICs
      if (/vmware|virtual|loopback|hyper-v|vbox|tap|tun/i.test(name)) continue;
      macs.push(i.mac.toLowerCase());
    }
  }
  if (macs.length === 0) return FB_PREFIX + "no-mac";
  macs.sort();
  return macs[0];
}

function readMachineGuid() {
  const out = safeExec(
    'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid'
  );
  const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
  if (m) return m[1].toLowerCase();
  return FB_PREFIX + "no-guid";
}

function deviceIdSync() {
  const parts = [
    "bios=" + readBiosUuid(),
    "mac="  + readPrimaryMac(),
    "guid=" + readMachineGuid(),
  ].sort();
  const h = crypto.createHash("sha256").update(parts.join("|")).digest("hex");
  return {
    id: h,
    parts: {
      bios: parts.find(p => p.startsWith("bios=")).slice(5),
      mac:  parts.find(p => p.startsWith("mac=")).slice(4),
      guid: parts.find(p => p.startsWith("guid=")).slice(5),
    },
    fullyFallback: parts.every(p => p.includes(FB_PREFIX)),
  };
}

module.exports = { deviceIdSync };
