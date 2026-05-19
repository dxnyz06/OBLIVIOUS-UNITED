// OBLIVIOUS HUB — password-prompt
// ----------------------------------------------------------------
// Synchronous-ish modal prompt for the encrypted vault passphrase.
// Only used in the packaged production build (SecureBoot path).
// In dev mode main.js short-circuits straight to an in-memory vault
// so this module is never hit.
// ----------------------------------------------------------------

const path = require("path");

let BrowserWindow = null;
try { ({ BrowserWindow } = require("electron")); } catch (_) {}

async function ask() {
  if (!BrowserWindow) {
    // Headless / non-Electron context — fall back to the env var.
    return process.env.OBLIVIOUS_VAULT_PASSPHRASE || "";
  }

  return new Promise((resolve) => {
    const w = new BrowserWindow({
      width:  420,
      height: 200,
      resizable: false,
      modal: true,
      frame: false,
      backgroundColor: "#04040a",
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox:        true,
        preload:        path.join(__dirname, "..", "preload.js"),
      },
    });
    const html = `data:text/html;charset=utf-8,${encodeURIComponent(`
      <html><head><style>
        html,body{margin:0;background:#04040a;color:#e6e9f2;font-family:system-ui;height:100%;}
        .wrap{padding:24px;}
        h2{margin:0 0 16px;font-size:14px;letter-spacing:.12em;color:#ff6;}
        input{width:100%;padding:8px;background:#0c0d18;border:1px solid #555;color:#fff;outline:none;}
        button{margin-top:12px;padding:8px 16px;background:transparent;border:1px solid #ff6;color:#ff6;cursor:pointer;}
      </style></head><body><div class="wrap">
        <h2>OBLIVIOUS — UNLOCK VAULT</h2>
        <input id="p" type="password" autofocus placeholder="passphrase" />
        <button onclick="window.location.hash='#'+encodeURIComponent(document.getElementById('p').value)">UNLOCK</button>
      </div></body></html>
    `)}`;
    w.loadURL(html);
    w.once("ready-to-show", () => w.show());
    w.webContents.on("did-navigate-in-page", (_e, url) => {
      const hashIdx = url.indexOf("#");
      const passphrase = hashIdx > -1 ? decodeURIComponent(url.slice(hashIdx + 1)) : "";
      w.close();
      resolve(passphrase);
    });
    w.on("closed", () => resolve(""));
  });
}

module.exports = { ask };
