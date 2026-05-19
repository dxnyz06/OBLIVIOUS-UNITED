const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("obliviousSetup", {
  bootstrap: () => ipcRenderer.invoke("setup:bootstrap"),
  createVault: (payload) => ipcRenderer.invoke("setup:createVault", payload),
  unlock: (passphrase) => ipcRenderer.invoke("setup:unlock", { passphrase }),
  listProviders: () => ipcRenderer.invoke("vault:listProviders"),
  saveProvider: (payload) => ipcRenderer.invoke("vault:saveProvider", payload),
  testProvider: (payload) => ipcRenderer.invoke("vault:testProvider", payload),
  changePasswordDev: (payload) =>
    ipcRenderer.invoke("vault:changePasswordDev", payload),
  changePasswordVps: (payload) =>
    ipcRenderer.invoke("vault:changePasswordVps", payload),
  exitApp: () => ipcRenderer.invoke("setup:exit"),
});
