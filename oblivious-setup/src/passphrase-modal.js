// Small modal window for a single passphrase (current VPS password, etc.). Never logged.

const path = require("path");
const { BrowserWindow, ipcMain } = require("electron");

/**
 * @param {Electron.BrowserWindow|null} parent
 * @param {string} title
 * @param {string} bodyText
 * @returns {Promise<string>} trimmed passphrase or "" if cancelled
 */
function askPassphrase(parent, title, bodyText) {
  const channel = `setup-pwd:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve) => {
    let resolved = false;
    let win = null;

    const finish = (val) => {
      if (resolved) return;
      resolved = true;
      try {
        ipcMain.removeHandler(channel);
      } catch (_) {}
      try {
        if (win && !win.isDestroyed()) win.close();
      } catch (_) {}
      resolve(String(val || "").trim());
    };

    ipcMain.handle(channel, (_evt, pwd) => {
      finish(pwd);
      return true;
    });

    win = new BrowserWindow({
      width: 460,
      height: 260,
      resizable: false,
      minimizable: false,
      maximizable: false,
      parent: parent || undefined,
      modal: !!parent,
      show: false,
      backgroundColor: "#0b0d10",
      title: title.slice(0, 80),
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "passphrase-modal-preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.removeMenu();

    const htmlPath = path.join(__dirname, "renderer", "passphrase-modal.html");
    win.loadFile(htmlPath, {
      query: {
        ch: channel,
        t: title || "",
        b: bodyText || "",
      },
    });

    win.once("ready-to-show", () => win.show());
    win.on("closed", () => finish(""));
  });
}

module.exports = { askPassphrase };
