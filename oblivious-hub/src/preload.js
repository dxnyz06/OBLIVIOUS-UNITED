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
});
