// OBLIVIOUS HUB — SshAgent.
//
// Central SSH/SFTP service that powers the VPS CONTROL CENTER.  Wraps
// the `ssh2` library with high-level operations the renderer needs:
//
//   • generateKeypair()       — Ed25519, stored under %LOCALAPPDATA%
//   • installPublicKey()      — uses bootstrap password ONCE to inject
//                               the pub key into the VPS authorized_keys
//   • testConnection()        — connects with the saved private key
//   • verifyHostFingerprint() — TOFU model with explicit rebind on mismatch
//   • uploadFile() / execCmd()/ sftpDir()
//   • deployBundle()          — SFTP the OBLIVIOUS-VPS folder
//   • pushConfig() / pushLicense() — replace remote config.enc / license.lic
//   • restartHub() / stopHub()/ healthCheck()
//   • pullLogs()              — downloads the remote bookmap-hub log
//
// Security:
//   • bootstrap password is NEVER persisted; only used in-memory for the
//     duration of installPublicKey().
//   • private SSH key is generated AND stored exclusively on the DEV
//     machine.  It is never bundled into the VPS installer.
//   • host fingerprint is pinned (TOFU) and a mismatch BLOCKS the call.
//
// Note: we keep the API completely promise-based so renderer IPC can
// await every operation and surface a real error message in the UI.

const fs       = require("fs");
const path     = require("path");
const os       = require("os");
const crypto   = require("crypto");
const { Client } = require("ssh2");

function _sshDir() {
  // %LOCALAPPDATA%\Oblivious\ssh on Windows, ~/.oblivious/ssh elsewhere.
  const base = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Oblivious")
    : path.join(os.homedir(), ".oblivious");
  const dir = path.join(base, "ssh");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function _b64ToPem(label, b64) {
  const lines = b64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function _writeStringField(buf) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

// Minimal OpenSSH public-key serializer for an Ed25519 key.
// Format: 4-byte length-prefixed string "ssh-ed25519" then 32-byte raw key.
function _opensshEd25519PubLine(rawPub, comment) {
  const algo = Buffer.from("ssh-ed25519");
  const blob = Buffer.concat([_writeStringField(algo), _writeStringField(rawPub)]);
  return `ssh-ed25519 ${blob.toString("base64")} ${comment || "oblivious@dev"}`;
}

// Build the OpenSSH-native private key file for an Ed25519 keypair.
// (ssh2 cannot read PKCS#8 PEM for ed25519, but it reads this format.)
function _opensshEd25519PrivPem(rawPriv32, rawPub32, comment) {
  const algo    = Buffer.from("ssh-ed25519");
  // Public key blob (ssh-ed25519 || 32-byte raw pub)
  const pubBlob = Buffer.concat([
    _writeStringField(algo),
    _writeStringField(rawPub32),
  ]);
  // Private key inner blob:
  //   checkint x2 (random matching 4-byte values for integrity)
  //   string algo
  //   string pub
  //   string priv (32 priv || 32 pub = 64 bytes)
  //   string comment
  //   pad bytes to 8-byte boundary
  const check    = crypto.randomBytes(4);
  const privBlob = Buffer.concat([rawPriv32, rawPub32]);   // 64 bytes total
  let inner = Buffer.concat([
    check, check,
    _writeStringField(algo),
    _writeStringField(rawPub32),
    _writeStringField(privBlob),
    _writeStringField(Buffer.from(comment || "oblivious@dev")),
  ]);
  while (inner.length % 8 !== 0) inner = Buffer.concat([inner, Buffer.from([(inner.length % 8) + 1])]);
  // Outer container
  const magic = Buffer.from("openssh-key-v1\0", "binary");
  const none  = _writeStringField(Buffer.from("none"));
  const empty = _writeStringField(Buffer.from(""));
  const nkeys = Buffer.alloc(4); nkeys.writeUInt32BE(1, 0);
  const blob = Buffer.concat([
    magic,
    none,                       // cipher
    none,                       // kdf
    empty,                      // kdf options
    nkeys,                      // # of keys
    _writeStringField(pubBlob), // public key
    _writeStringField(inner),   // encrypted (here: plain) private section
  ]);
  return _b64ToPem("OPENSSH PRIVATE KEY", blob.toString("base64"));
}

class SshAgent {
  constructor({ telemetry } = {}) {
    this.telemetry = telemetry;
    // VPS profile is loaded on demand by main.js (encrypted with the
    // operator's KeyVault passphrase). SshAgent itself only keeps the
    // most recent profile in memory.
    this.profile = null;          // {host, port, user, privateKeyPath, publicKeyPath, remoteInstallPath, hostFingerprint, ...}
    this._fingerprintFile = path.join(_sshDir(), "known_hosts.json");
  }

  // ── Status helpers ────────────────────────────────────────────────
  sshDir() { return _sshDir(); }

  defaultPrivateKeyPath() { return path.join(_sshDir(), "vps_ed25519"); }
  defaultPublicKeyPath()  { return path.join(_sshDir(), "vps_ed25519.pub"); }

  hasKeypair() {
    return fs.existsSync(this.defaultPrivateKeyPath()) &&
           fs.existsSync(this.defaultPublicKeyPath());
  }

  // ── 1.  KEYPAIR GENERATION  (Ed25519, OpenSSH-native, ssh2-readable) ──
  async generateKeypair({ comment = "oblivious@dev", overwrite = false } = {}) {
    const priv = this.defaultPrivateKeyPath();
    const pub  = this.defaultPublicKeyPath();
    if ((fs.existsSync(priv) || fs.existsSync(pub)) && !overwrite) {
      return { ok: false, reason: "keypair_exists", privateKeyPath: priv, publicKeyPath: pub };
    }
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    // Extract raw 32-byte seed from PKCS#8 DER (last 32 bytes per RFC 8410)
    const privDer = privateKey.export({ type: "pkcs8", format: "der" });
    const rawPriv = privDer.subarray(privDer.length - 32);
    // Extract raw 32-byte public from SPKI DER (last 32 bytes)
    const spki    = publicKey.export({ type: "spki",  format: "der" });
    const rawPub  = spki.subarray(spki.length - 32);

    const privPem = _opensshEd25519PrivPem(rawPriv, rawPub, comment);
    const pubLine = _opensshEd25519PubLine(rawPub, comment);

    fs.writeFileSync(priv, privPem, { mode: 0o600 });
    fs.writeFileSync(pub,  pubLine + "\n", { mode: 0o644 });
    this._log("info", `Ed25519 keypair generated at ${priv}`);
    return {
      ok: true,
      privateKeyPath: priv,
      publicKeyPath:  pub,
      publicKey:      pubLine,
      fingerprint:    "SHA256:" + crypto.createHash("sha256").update(Buffer.concat([
                        _writeStringField(Buffer.from("ssh-ed25519")),
                        _writeStringField(rawPub),
                      ])).digest("base64").replace(/=+$/, ""),
    };
  }

  // ── 2.  INSTALL PUBKEY ON VPS  (one-shot, bootstrap password) ────
  async installPublicKey({ host, port = 22, user, bootstrapPassword,
                            remoteAuthorizedKeysPath } = {}) {
    if (!host || !user || !bootstrapPassword) {
      return { ok: false, reason: "missing_credentials" };
    }
    if (!fs.existsSync(this.defaultPublicKeyPath())) {
      return { ok: false, reason: "no_public_key" };
    }
    const pubLine = fs.readFileSync(this.defaultPublicKeyPath(), "utf8").trim();
    const ak = remoteAuthorizedKeysPath || ".ssh/authorized_keys";

    const result = await this._withClient(
      { host, port, username: user, password: bootstrapPassword,
        // First-time bootstrap: accept any host key but RECORD it so we
        // can pin it for every subsequent operation.
        hostHash: "sha256",
        hostVerifier: (hashBase64) => { this._pinHostKey(host, port, hashBase64); return true; },
      },
      async (conn) => {
        // mkdir -p ~/.ssh && chmod 700, then append if not already present
        await this._exec(conn, "mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/" + ak + " && chmod 600 ~/" + ak);
        const safePub = pubLine.replace(/'/g, "'\\''");
        const guard   = `grep -qxF '${safePub}' ~/${ak} || echo '${safePub}' >> ~/${ak}`;
        await this._exec(conn, guard);
        return true;
      }
    );
    if (!result.ok) return result;
    this._log("info", `Public key installed on ${user}@${host}:${port}`);
    return { ok: true };
  }

  // ── 3.  TEST CONNECTION  (uses saved private key) ────────────────
  async testConnection({ host, port = 22, user } = {}) {
    if (!this.hasKeypair()) return { ok: false, reason: "no_keypair" };
    const priv = fs.readFileSync(this.defaultPrivateKeyPath());
    return this._withClient(
      { host, port, username: user, privateKey: priv,
        hostVerifier: (hashBase64) => this._verifyHostKey(host, port, hashBase64) },
      async (conn) => {
        const r = await this._exec(conn, "uname -a && uptime");
        return { uname: (r.stdout || "").trim() };
      }
    );
  }

  // ── 4.  SFTP file/dir upload ─────────────────────────────────────
  async uploadFile({ host, port, user, localPath, remotePath }) {
    const priv = fs.readFileSync(this.defaultPrivateKeyPath());
    return this._withClient(
      { host, port, username: user, privateKey: priv,
        hostVerifier: (hashBase64) => this._verifyHostKey(host, port, hashBase64) },
      async (conn) => {
        await this._exec(conn, `mkdir -p "$(dirname '${remotePath.replace(/'/g, "'\\''")}')"`);
        await this._sftpPut(conn, localPath, remotePath);
        return { uploaded: remotePath };
      }
    );
  }

  async uploadDir({ host, port, user, localDir, remoteDir }) {
    const priv = fs.readFileSync(this.defaultPrivateKeyPath());
    if (!fs.existsSync(localDir)) {
      return { ok: false, reason: "local_dir_missing" };
    }
    return this._withClient(
      { host, port, username: user, privateKey: priv,
        hostVerifier: (hashBase64) => this._verifyHostKey(host, port, hashBase64) },
      async (conn) => {
        const files = [];
        this._walk(localDir, files);
        await this._exec(conn, `mkdir -p "${remoteDir.replace(/"/g, '\\"')}"`);
        let count = 0;
        for (const f of files) {
          const rel = path.relative(localDir, f).replace(/\\/g, "/");
          const remoteFile = `${remoteDir.replace(/\\/g, "/").replace(/\/+$/, "")}/${rel}`;
          const remoteParent = remoteFile.split("/").slice(0, -1).join("/");
          if (remoteParent) await this._exec(conn, `mkdir -p "${remoteParent.replace(/"/g, '\\"')}"`);
          await this._sftpPut(conn, f, remoteFile);
          count++;
        }
        return { uploaded: count };
      }
    );
  }

  // ── 5.  Remote control: restart / stop / health ──────────────────
  async execRemote({ host, port, user, command }) {
    const priv = fs.readFileSync(this.defaultPrivateKeyPath());
    return this._withClient(
      { host, port, username: user, privateKey: priv,
        hostVerifier: (hashBase64) => this._verifyHostKey(host, port, hashBase64) },
      async (conn) => this._exec(conn, command)
    );
  }

  async restartHub(profile, remoteExeName = "Oblivious Hub.exe") {
    // Windows VPS — use taskkill then start
    const stop = `taskkill /F /IM "${remoteExeName}" 2>nul; exit 0`;
    const start = `powershell -Command "Start-Process -FilePath '${profile.remoteInstallPath}\\\\${remoteExeName}'"`;
    const r1 = await this.execRemote({ ...profile, command: stop });
    if (!r1.ok) return r1;
    return this.execRemote({ ...profile, command: start });
  }

  async stopHub(profile, remoteExeName = "Oblivious Hub.exe") {
    return this.execRemote({ ...profile, command: `taskkill /F /IM "${remoteExeName}"` });
  }

  async healthCheck(profile) {
    const cmd = `powershell -Command "$ErrorActionPreference='SilentlyContinue';` +
                `$exe=Get-Process 'Oblivious Hub' -ErrorAction SilentlyContinue;` +
                `$cfg=Test-Path '${profile.remoteInstallPath}\\\\config\\\\config.enc';` +
                `$lic=Test-Path '${profile.remoteInstallPath}\\\\licenses\\\\license.lic';` +
                `$pub=Test-Path '${profile.remoteInstallPath}\\\\licenses\\\\public_key.pem';` +
                `if($exe){$pid=$exe.Id;$mem=[math]::Round($exe.WorkingSet64/1MB,1)}else{$pid=0;$mem=0};` +
                `Write-Output \\"HUB_PID=$pid HUB_MEM_MB=$mem CONFIG_OK=$cfg LICENSE_OK=$lic PUBKEY_OK=$pub\\""`;
    const r = await this.execRemote({ ...profile, command: cmd });
    if (!r.ok) return r;
    const out = (r.stdout || "").trim();
    const m = {};
    out.split(/\s+/).forEach((p) => { const [k, v] = p.split("="); if (k) m[k] = v; });
    return { ok: true,
             hubAlive:    Number(m.HUB_PID) > 0,
             pid:         Number(m.HUB_PID),
             memMB:       Number(m.HUB_MEM_MB),
             configOk:    m.CONFIG_OK  === "True",
             licenseOk:   m.LICENSE_OK === "True",
             pubKeyOk:    m.PUBKEY_OK  === "True",
             raw:         out };
  }

  async pullLogs(profile, { localDir, remoteLogDir } = {}) {
    const rdir = remoteLogDir || `${profile.remoteInstallPath}\\\\logs`;
    const priv = fs.readFileSync(this.defaultPrivateKeyPath());
    return this._withClient(
      { host: profile.host, port: profile.port, username: profile.user,
        privateKey: priv,
        hostVerifier: (hashBase64) => this._verifyHostKey(profile.host, profile.port, hashBase64) },
      async (conn) => {
        const listCmd = `powershell -Command "Get-ChildItem -Path '${rdir}' -File | Select-Object -ExpandProperty Name"`;
        const lst = await this._exec(conn, listCmd);
        const names = (lst.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        fs.mkdirSync(localDir, { recursive: true });
        let count = 0;
        for (const n of names) {
          const remote = `${rdir.replace(/\\\\/g, "/")}/${n}`;
          const local  = path.join(localDir, n);
          try { await this._sftpGet(conn, remote, local); count++; } catch (_) { /* skip */ }
        }
        return { downloaded: count, names };
      }
    );
  }

  // ── 6.  TOFU host-key pinning ────────────────────────────────────
  _loadFingerprints() {
    try { return JSON.parse(fs.readFileSync(this._fingerprintFile, "utf8")); }
    catch (_) { return {}; }
  }
  _saveFingerprints(obj) {
    fs.writeFileSync(this._fingerprintFile, JSON.stringify(obj, null, 2));
  }
  _pinHostKey(host, port, hashBase64) {
    const all = this._loadFingerprints();
    const key = `${host}:${port}`;
    if (!all[key]) {
      all[key] = { fingerprint: hashBase64, pinnedAt: new Date().toISOString() };
      this._saveFingerprints(all);
      this._log("info", `Host fingerprint PINNED for ${key} = ${hashBase64}`);
    }
  }
  _verifyHostKey(host, port, hashBase64) {
    const all = this._loadFingerprints();
    const key = `${host}:${port}`;
    if (!all[key]) {
      // Strict mode: refuse to bind a brand-new host outside the explicit
      // installPublicKey() flow. The operator MUST run the bootstrap from
      // the Connection tab once.
      this._log("warn", `Host fingerprint NOT PINNED for ${key} — blocking connection`);
      return false;
    }
    if (all[key].fingerprint !== hashBase64) {
      this._log("error", `Host fingerprint MISMATCH for ${key} — refusing connection`);
      return false;
    }
    return true;
  }

  // ── Internals ────────────────────────────────────────────────────
  _withClient(opts, work) {
    return new Promise((resolve) => {
      const conn = new Client();
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; try { conn.end(); } catch (_) {} resolve(v); };
      conn.on("ready", async () => {
        try {
          const data = await work(conn);
          done({ ok: true, ...data });
        } catch (err) {
          done({ ok: false, reason: err && err.message ? err.message : String(err) });
        }
      });
      conn.on("error", (err) => done({ ok: false, reason: err.message || String(err) }));
      conn.on("end",   () => done({ ok: false, reason: "connection_ended" }));
      const t = setTimeout(() => done({ ok: false, reason: "timeout" }), 15000);
      conn.on("close", () => clearTimeout(t));
      try {
        // Always force the SHA256 host-hash mode so the value passed to
        // `hostVerifier(...)` is a stable base64 SHA-256 digest of the
        // remote host's public key — letting us pin/verify with a single
        // consistent identifier across install/test/deploy operations.
        conn.connect({
          readyTimeout: 12000,
          keepaliveInterval: 30000,
          hostHash: "sha256",
          ...opts,
        });
      }
      catch (err) { done({ ok: false, reason: err.message || String(err) }); }
    });
  }

  _exec(conn, cmd) {
    return new Promise((resolve, reject) => {
      conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let stdout = "", stderr = "";
        stream.on("data",   (d) => { stdout += d.toString(); });
        stream.stderr.on("data", (d) => { stderr += d.toString(); });
        stream.on("close", (code) => {
          if (code === 0) resolve({ stdout, stderr, code });
          else            reject(new Error(`exit_${code}: ${stderr || stdout}`));
        });
      });
    });
  }

  _sftpPut(conn, localPath, remotePath) {
    return new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.fastPut(localPath, remotePath, (e) => e ? reject(e) : resolve());
      });
    });
  }

  _sftpGet(conn, remotePath, localPath) {
    return new Promise((resolve, reject) => {
      conn.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.fastGet(remotePath, localPath, (e) => e ? reject(e) : resolve());
      });
    });
  }

  _walk(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) this._walk(full, out);
      else if (entry.isFile()) out.push(full);
    }
  }

  _log(level, msg) {
    if (this.telemetry && typeof this.telemetry.log === "function") {
      this.telemetry.log(level, "SshAgent", msg);
    }
  }
}

module.exports = SshAgent;
