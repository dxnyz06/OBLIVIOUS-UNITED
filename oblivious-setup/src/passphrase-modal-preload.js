const { contextBridge, ipcRenderer } = require("electron");

let channel = "";
try {
  channel = new URL(window.location.href).searchParams.get("ch") || "";
} catch (_) {
  channel = "";
}

contextBridge.exposeInMainWorld("pwdModal", {
  submit: (pwd) => ipcRenderer.invoke(channel, String(pwd ?? "")),
});
