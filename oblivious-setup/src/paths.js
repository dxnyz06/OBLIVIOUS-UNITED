// Resolve workspace / bundle roots for vault paths (no trading logic).

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

function walkParents(startDir, maxHops, visit) {
  let d = path.resolve(startDir);
  for (let i = 0; i < maxHops; i++) {
    const stop = visit(d);
    if (stop === true) return d;
    const nd = path.dirname(d);
    if (nd === d) break;
    d = nd;
  }
  return null;
}

function findWorkspaceRootFromExe() {
  const start = path.dirname(app.getPath("exe"));
  const hit = walkParents(start, 16, (d) => {
    const hub = path.join(d, "oblivious-hub", "package.json");
    const vpsCfg = path.join(d, "OBLIVIOUS-VPS", "config");
    return fs.existsSync(hub) && fs.existsSync(vpsCfg);
  });
  if (hit) return hit;
  const env = (process.env.OBLIVIOUS_WORKSPACE_ROOT || "").trim();
  if (env && fs.existsSync(path.join(env, "oblivious-hub"))) return path.resolve(env);
  return null;
}

function findWorkspaceRootDevUnpackaged() {
  let d = __dirname;
  for (let i = 0; i < 14; i++) {
    const hub = path.join(d, "oblivious-hub", "package.json");
    const vpsCfg = path.join(d, "OBLIVIOUS-VPS", "config");
    if (fs.existsSync(hub) && fs.existsSync(vpsCfg)) return d;
    const nd = path.dirname(d);
    if (nd === d) break;
    d = nd;
  }
  throw new Error(
    "Workspace root not found (need oblivious-hub + OBLIVIOUS-VPS as siblings)"
  );
}

/** VPS bundle root: folder containing app/ and config/ */
function findVpsBundleRootFromExe() {
  const start = path.dirname(app.getPath("exe"));
  const hit = walkParents(start, 12, (d) =>
    fs.existsSync(path.join(d, "app")) &&
    fs.existsSync(path.join(d, "config"))
  );
  if (hit) return hit;
  const env = (process.env.OBLIVIOUS_SETUP_VPS_ROOT || "").trim();
  if (env && fs.existsSync(path.join(env, "config"))) return path.resolve(env);
  return null;
}

function hubServicesDir() {
  if (app.isPackaged) {
    const r = path.join(process.resourcesPath, "hub-services");
    if (fs.existsSync(path.join(r, "KeyVault.js"))) return r;
  }
  const root = app.isPackaged
    ? findWorkspaceRootFromExe()
    : findWorkspaceRootDevUnpackaged();
  if (!root) {
    throw new Error(
      "Cannot locate hub-services — set OBLIVIOUS_WORKSPACE_ROOT or run inside workspace"
    );
  }
  return path.join(root, "oblivious-hub", "src", "services");
}

function devVaultPath(workspaceRoot) {
  return path.join(
    workspaceRoot,
    "OBLIVIOUS-DEV",
    "secure-config",
    "dev-local",
    "config.enc"
  );
}

function vpsVaultPathWorkspace(workspaceRoot) {
  return path.join(workspaceRoot, "OBLIVIOUS-VPS", "config", "config.enc");
}

function vpsVaultPathBundle(bundleRoot) {
  return path.join(bundleRoot, "config", "config.enc");
}

module.exports = {
  findWorkspaceRootFromExe,
  findWorkspaceRootDevUnpackaged,
  findVpsBundleRootFromExe,
  hubServicesDir,
  devVaultPath,
  vpsVaultPathWorkspace,
  vpsVaultPathBundle,
};
