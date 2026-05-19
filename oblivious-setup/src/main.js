// OBLIVIOUS SETUP — Electron main (DEV / VPS). Uses hub KeyVault + provider adapters only.
//
// Vault binding (required behaviour):
// - SETUP DEV:  API Keys + Password DEV → devVaultAbs (OBLIVIOUS-DEV/secure-config/dev-local/config.enc)
//               Password VPS only (DEV app) → vpsVaultAbsWorkspace (OBLIVIOUS-VPS/config/config.enc)
// - SETUP VPS:  API Keys only → vpsVaultAbsPrimary (bundle …/config/config.enc); no password UI / IPC effect

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, ipcMain } = require("electron");

const VAULT_MAGIC = Buffer.from("OBLV");

function vaultNeedsFirstRun(absPath) {
  if (!absPath) return true;
  if (!fs.existsSync(absPath)) return true;
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size === 0) return true;
    const buf = fs.readFileSync(absPath);
    if (buf.length < VAULT_MAGIC.length + 16 + 12 + 16 + 2) return true;
    if (!buf.subarray(0, VAULT_MAGIC.length).equals(VAULT_MAGIC)) return true;
  } catch {
    return true;
  }
  return false;
}

const {
  findWorkspaceRootFromExe,
  findWorkspaceRootDevUnpackaged,
  findVpsBundleRootFromExe,
  hubServicesDir,
  devVaultPath,
  vpsVaultPathWorkspace,
  vpsVaultPathBundle,
} = require("./paths");
const { testProviderKey } = require("./provider-test");
const { askPassphrase } = require("./passphrase-modal");

const MODE = global.OBLIVIOUS_SETUP_MODE === "vps" ? "vps" : "dev";

const PROVIDER_META = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
  { id: "google", label: "Google" },
  { id: "xai", label: "xAI" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "qwen", label: "Qwen" },
  { id: "perplexity", label: "Perplexity" },
];

let win = null;
let KeyVault = null;
let hubSvc = null;
let workspaceRoot = null;
let devVaultAbs = null;
let vpsVaultAbsWorkspace = null;
let vpsBundleRoot = null;
let vpsVaultAbsPrimary = null;

/** DEV setup: passphrase after unlocking DEV vault */
let devSessionPass = null;
/** Vault file used for API Keys list/save/test */
let keysVaultFile = null;
/** Passphrase for keysVaultFile */
let keysVaultPass = null;

function windowTitle() {
  return MODE === "vps" ? "OBLIVIOUS HUB — Setup VPS" : "OBLIVIOUS HUB — Setup DEV";
}

function loadKeyVaultCtor() {
  const dir = hubServicesDir();
  return require(path.join(dir, "KeyVault.js"));
}

function dumpKeys(kv) {
  const o = {};
  for (const { id } of PROVIDER_META) if (kv.has(id)) o[id] = kv.get(id);
  return o;
}

async function openVaultKV(file, passphrase) {
  const kv = new KeyVault({
    file,
    passphrase,
    envFallback: {},
    telemetry: null,
    allowEnvFallback: false,
  });
  await kv.load();
  return kv;
}

function ensureKeysVault() {
  if (!keysVaultPass || !keysVaultFile) throw new Error("locked");
}

function ensureDevSession() {
  if (!devSessionPass) throw new Error("locked_dev");
}

function resolveLayoutOrExit() {
  hubSvc = hubServicesDir();
  KeyVault = loadKeyVaultCtor();

  if (MODE === "dev") {
    workspaceRoot = app.isPackaged
      ? findWorkspaceRootFromExe()
      : findWorkspaceRootDevUnpackaged();
    if (!workspaceRoot) {
      console.error(
        "[setup-dev] Set OBLIVIOUS_WORKSPACE_ROOT or install beside oblivious-hub / OBLIVIOUS-VPS"
      );
      process.exit(1);
    }
    devVaultAbs = devVaultPath(workspaceRoot);
    vpsVaultAbsWorkspace = vpsVaultPathWorkspace(workspaceRoot);
    // API Keys (DEV) always use DEV vault — never the VPS vault
    keysVaultFile = devVaultAbs;
    keysVaultPass = null;
    devSessionPass = null;
  } else {
    vpsBundleRoot = findVpsBundleRootFromExe();
    if (!vpsBundleRoot) {
      console.error(
        "[setup-vps] Cannot find VPS bundle (app/ + config/). Set OBLIVIOUS_SETUP_VPS_ROOT."
      );
      process.exit(1);
    }
    vpsVaultAbsPrimary = vpsVaultPathBundle(vpsBundleRoot);
    // API Keys (VPS) always use bundle VPS vault only
    keysVaultFile = vpsVaultAbsPrimary;
    keysVaultPass = null;
    devSessionPass = null;
    workspaceRoot = null;
    devVaultAbs = null;
    vpsVaultAbsWorkspace = null;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 920,
    height: 820,
    backgroundColor: "#0b0d10",
    title: windowTitle(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

ipcMain.handle("setup:bootstrap", async () => {
  const primaryVault = MODE === "dev" ? devVaultAbs : vpsVaultAbsPrimary;
  return {
    mode: MODE,
    windowTitle: windowTitle(),
    providerMeta: PROVIDER_META,
    initialGate: vaultNeedsFirstRun(primaryVault) ? "first-run" : "unlock",
    features: {
      passwordDevSection: MODE === "dev",
      passwordVpsSection: MODE === "dev",
    },
    paths: {
      unlockVaultHint: MODE === "dev" ? devVaultAbs : vpsVaultAbsPrimary,
      devVault: MODE === "dev" ? devVaultAbs : null,
      vpsVaultWorkspace: MODE === "dev" ? vpsVaultAbsWorkspace : null,
      apiKeysVault: keysVaultFile,
      primaryVault,
    },
  };
});

ipcMain.handle("setup:createVault", async (_e, { passphrase, confirmPass }) => {
  const n = String(passphrase || "").trim();
  const c = String(confirmPass || "").trim();
  if (!n || n !== c) return { ok: false, reason: "password_mismatch" };

  const targetFile = MODE === "dev" ? devVaultAbs : vpsVaultAbsPrimary;
  if (!targetFile) return { ok: false, reason: "no_target" };
  if (!vaultNeedsFirstRun(targetFile)) return { ok: false, reason: "vault_already_exists" };

  try {
    const kv = new KeyVault({
      file: targetFile,
      passphrase: n,
      envFallback: {},
      telemetry: null,
      allowEnvFallback: false,
    });
    await kv.save({});
    if (MODE === "dev") {
      devSessionPass = n;
      keysVaultFile = devVaultAbs;
      keysVaultPass = n;
    } else {
      keysVaultPass = n;
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "save_failed" };
  }
});

ipcMain.handle("setup:unlock", async (_e, { passphrase }) => {
  const pw = String(passphrase || "").trim();
  if (!pw) return { ok: false, reason: "empty_passphrase" };

  if (MODE === "dev") {
    if (!devVaultAbs || vaultNeedsFirstRun(devVaultAbs)) {
      return { ok: false, reason: "vault_needs_create" };
    }
    try {
      const kv = await openVaultKV(devVaultAbs, pw);
      if (kv.source() !== "vault") return { ok: false, reason: "bad_passphrase" };
      devSessionPass = pw;
      keysVaultFile = devVaultAbs;
      keysVaultPass = pw;
      return { ok: true };
    } catch {
      return { ok: false, reason: "bad_passphrase" };
    }
  }

  if (!keysVaultFile || vaultNeedsFirstRun(keysVaultFile)) {
    return { ok: false, reason: "vault_needs_create" };
  }
  try {
    const kv = await openVaultKV(keysVaultFile, pw);
    if (kv.source() !== "vault") return { ok: false, reason: "bad_passphrase" };
    keysVaultPass = pw;
    return { ok: true };
  } catch {
    return { ok: false, reason: "bad_passphrase" };
  }
});

ipcMain.handle("vault:listProviders", async () => {
  ensureKeysVault();
  const kv = await openVaultKV(keysVaultFile, keysVaultPass);
  if (kv.source() !== "vault") throw new Error("vault_unreadable");
  return PROVIDER_META.map(({ id, label }) => ({
    id,
    label,
    saved: kv.has(id),
  }));
});

ipcMain.handle("vault:saveProvider", async (_e, { providerId, apiKey }) => {
  ensureKeysVault();
  const pid = String(providerId || "").trim();
  if (!PROVIDER_META.some((p) => p.id === pid)) throw new Error("bad_provider");
  const kv = await openVaultKV(keysVaultFile, keysVaultPass);
  if (kv.source() !== "vault") throw new Error("vault_unreadable");
  const cur = dumpKeys(kv);
  const v = apiKey === undefined ? "" : String(apiKey);
  if (!v.trim()) delete cur[pid];
  else cur[pid] = v.trim();
  kv.passphrase = keysVaultPass;
  kv.file = keysVaultFile;
  await kv.save(cur);
  return { ok: true };
});

ipcMain.handle("vault:testProvider", async (_e, { providerId, apiKey }) => {
  ensureKeysVault();
  const pid = String(providerId || "").trim();
  if (!PROVIDER_META.some((p) => p.id === pid)) throw new Error("bad_provider");
  let key = String(apiKey || "").trim();
  if (!key) {
    const kv = await openVaultKV(keysVaultFile, keysVaultPass);
    if (kv.source() !== "vault") return { ok: false, reason: "vault_unreadable" };
    key = kv.has(pid) ? kv.get(pid) : "";
  }
  const r = await testProviderKey(hubSvc, pid, key);
  return r;
});

ipcMain.handle("vault:changePasswordDev", async (_e, { newPass, confirmPass }) => {
  if (MODE !== "dev") return { ok: false, reason: "forbidden" };
  ensureDevSession();
  const n = String(newPass || "").trim();
  const c = String(confirmPass || "").trim();
  if (!n || n !== c) return { ok: false, reason: "password_mismatch" };
  const kv = await openVaultKV(devVaultAbs, devSessionPass);
  if (kv.source() !== "vault") return { ok: false, reason: "vault_unreadable" };
  const cur = dumpKeys(kv);
  const kv2 = new KeyVault({
    file: devVaultAbs,
    passphrase: n,
    envFallback: {},
    telemetry: null,
    allowEnvFallback: false,
  });
  await kv2.save(cur);
  devSessionPass = n;
  if (keysVaultFile === devVaultAbs) keysVaultPass = n;
  return { ok: true };
});

ipcMain.handle("vault:changePasswordVps", async (_e, { newPass, confirmPass }) => {
  if (MODE !== "dev") return { ok: false, reason: "forbidden" };
  ensureDevSession();
  const n = String(newPass || "").trim();
  const c = String(confirmPass || "").trim();
  if (!n || n !== c) return { ok: false, reason: "password_mismatch" };
  if (!vpsVaultAbsWorkspace) return { ok: false, reason: "no_target" };

  if (vaultNeedsFirstRun(vpsVaultAbsWorkspace)) {
    try {
      const kv = new KeyVault({
        file: vpsVaultAbsWorkspace,
        passphrase: n,
        envFallback: {},
        telemetry: null,
        allowEnvFallback: false,
      });
      await kv.save({});
      return { ok: true, created: true };
    } catch {
      return { ok: false, reason: "save_failed" };
    }
  }

  const parent = BrowserWindow.getFocusedWindow() || win;
  const oldPw = await askPassphrase(
    parent,
    "OBLIVIOUS — Vault VPS",
    "Passphrase attuale del vault VPS per ricifrare il file workspace OBLIVIOUS-VPS/config/config.enc (stesso path del bundle dopo sync)."
  );
  if (!oldPw) return { ok: false, reason: "cancelled" };

  try {
    const kv = await openVaultKV(vpsVaultAbsWorkspace, oldPw);
    if (kv.source() !== "vault") return { ok: false, reason: "bad_current_password" };
    const cur = dumpKeys(kv);
    const kv2 = new KeyVault({
      file: vpsVaultAbsWorkspace,
      passphrase: n,
      envFallback: {},
      telemetry: null,
      allowEnvFallback: false,
    });
    await kv2.save(cur);
    return { ok: true };
  } catch {
    return { ok: false, reason: "bad_current_password" };
  }
});

ipcMain.handle("setup:exit", async () => {
  app.quit();
  return true;
});

app.whenReady().then(() => {
  try {
    resolveLayoutOrExit();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
  createWindow();
});

app.on("window-all-closed", () => app.quit());
