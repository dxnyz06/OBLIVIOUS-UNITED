// OBLIVIOUS HUB — preload.
//
// Exposes a tightly-scoped, read-only window.hub API to the renderer.
// No nodeIntegration; only the explicit channels listed here are
// reachable from the UI thread.

const { contextBridge, ipcRenderer } = require("electron");

const ALLOWED_PUSH_CHANNELS = new Set([
  "hub:bridge",
  "hub:news",
  "hub:providers",
  "hub:bookmap",
  "hub:decision",
  "hub:telemetry",
  "hub:logs",
  "hub:secure",
  "hub:devModeChanged",
]);

contextBridge.exposeInMainWorld("hub", {
  // Bulk snapshot + push subscriptions
  getSnapshot: () => ipcRenderer.invoke("hub:getSnapshot"),
  on: (channel, handler) => {
    if (!ALLOWED_PUSH_CHANNELS.has(channel)) return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // Window controls (custom frame matches PNG mockup)
  win: {
    minimize:     () => ipcRenderer.invoke("win:minimize"),
    maximize:     () => ipcRenderer.invoke("win:maximize"),
    close:        () => ipcRenderer.invoke("win:close"),
    openExternal: (url) => ipcRenderer.invoke("win:openExternal", url),
  },

  // Trading commands (forwarded to EA over ZMQ PUB topic oblivious.command).
  // The hub never owns the trades — the EA's ownership registry is authoritative.
  cmd: {
    closePosition:   (payload) => ipcRenderer.invoke("cmd:closePosition", payload),
    changeSymbol:    (payload) => ipcRenderer.invoke("cmd:changeSymbol", payload),
    changeTimeframe: (payload) => ipcRenderer.invoke("cmd:changeTimeframe", payload),
    setTpslMode:     (payload) => ipcRenderer.invoke("cmd:setTpslMode", payload),
  },

  // Vault / AI provider key management (DEV ONLY UX on VPS via SETUP DEV.exe normally;
  // here we mirror the in-Hub editing surface used by the renderer EDIT API KEY card).
  vault: {
    listProviders: ()        => ipcRenderer.invoke("vault:listProviders"),
    testProvider:  (payload) => ipcRenderer.invoke("vault:testProvider", payload),
    testKey:       (payload) => ipcRenderer.invoke("vault:testKey", payload),
    testAll:       ()        => ipcRenderer.invoke("vault:testAll"),
    reconnectAll:  ()        => ipcRenderer.invoke("vault:reconnectAll"),
    setKey:        (payload) => ipcRenderer.invoke("vault:setKey", payload),
  },
  news: {
    fetchFallback: () => ipcRenderer.invoke("news:fetchFallback"),
  },

  // VPS Control Center (DEV ONLY).
  vps: {
    status:             () => ipcRenderer.invoke("vps:status"),
    generateUnlockKey:  () => ipcRenderer.invoke("vps:generateUnlockKey"),
    rotateUnlockKey:    () => ipcRenderer.invoke("vps:rotateUnlockKey"),
    revokeAccess:       () => ipcRenderer.invoke("vps:revokeAccess"),
    bindFingerprint:    () => ipcRenderer.invoke("vps:bindFingerprint"),
    generateRuntime:    () => ipcRenderer.invoke("vps:generateRuntime"),
  },

  // SSH AUTOMATIC (DEV ONLY) — keypair gen, install on VPS, test, profile
  ssh: {
    status:          ()        => ipcRenderer.invoke("ssh:status"),
    generateKeypair: (payload) => ipcRenderer.invoke("ssh:generateKeypair", payload),
    installKey:      (payload) => ipcRenderer.invoke("ssh:installKey", payload),
    testConnection:  (payload) => ipcRenderer.invoke("ssh:testConnection", payload),
    loadProfile:     ()        => ipcRenderer.invoke("ssh:loadProfile"),
    saveProfile:     (payload) => ipcRenderer.invoke("ssh:saveProfile", payload),
  },

  // Remote deploy / lifecycle (DEV ONLY)
  deploy: {
    bundle:       (payload) => ipcRenderer.invoke("deploy:bundle",       payload),
    pushConfig:   (payload) => ipcRenderer.invoke("deploy:pushConfig",   payload),
    pushLicense:  (payload) => ipcRenderer.invoke("deploy:pushLicense",  payload),
    restartHub:   (payload) => ipcRenderer.invoke("deploy:restartHub",   payload),
    stopHub:      (payload) => ipcRenderer.invoke("deploy:stopHub",      payload),
    healthCheck:  (payload) => ipcRenderer.invoke("deploy:healthCheck",  payload),
    pullLogs:     (payload) => ipcRenderer.invoke("deploy:pullLogs",     payload),
  },

  // Mobile gateway (VPS-side, direct mobile↔VPS encrypted control plane).
  mobile: {
    status:              ()        => ipcRenderer.invoke("mobile:status"),
    start:               (payload) => ipcRenderer.invoke("mobile:start", payload),
    stop:                ()        => ipcRenderer.invoke("mobile:stop"),
    createPairingToken:  (payload) => ipcRenderer.invoke("mobile:createPairingToken", payload),
    listDevices:         ()        => ipcRenderer.invoke("mobile:listDevices"),
    revokeDevice:        (payload) => ipcRenderer.invoke("mobile:revokeDevice", payload),
    setPolicy:           (payload) => ipcRenderer.invoke("mobile:setPolicy", payload),
    lanIps:              ()        => ipcRenderer.invoke("mobile:lanIps"),
  },
});
