// OBLIVIOUS HUB — MobileGateway.
//
// Always-on HTTPS + WSS server that runs INSIDE the Hub process on the
// VPS.  Mobile devices connect to this gateway over a private network
// (Tailscale / WireGuard / LAN) and never to the developer's PC.
//
// Endpoints
//   GET  /m/                  → mobile PWA (`mobile/index.html`)
//   GET  /m/static/*          → static files from `mobile/`
//   POST /m/pair              → consume a one-shot pairing token and
//                               register the device (returns device_id +
//                               long-lived secret; secret shown ONCE)
//   POST /m/auth              → device_id + secret → short-lived
//                               session token (HMAC) used to upgrade
//                               to WSS
//   WSS  /m/ws                → bi-di JSON stream:
//                                 server  → snapshots (`snapshot`,
//                                            `positions`, `pending`,
//                                            `decision`, `providers`,
//                                            `news`, `bookmap`,
//                                            `devices`)
//                                 client  → commands (`close_position`,
//                                            `cancel_pending`,
//                                            `hold`, `restart_hub`,
//                                            `health_check`,
//                                            `revoke_device`,
//                                            `update_api_key`,
//                                            `set_mobile_enabled`)
//
// Security
//   • TLS via a self-signed cert created on first boot (stored under
//     %LOCALAPPDATA%/Oblivious/mobile/cert.pem|key.pem).
//   • Per-device long-lived secret (`base64url`, 32 bytes) hashed via
//     scrypt; only the hash hits disk.
//   • Pairing tokens are random 16-byte hex, one-shot, TTL 10 min.
//   • Session tokens are HMAC-SHA256 of `device_id|exp|nonce` with the
//     server's per-process secret. TTL 30 min, auto-refreshed on every
//     authenticated message.
//   • Revocation is instant: the WS server drops the socket on the next
//     command if the registry says revoked.
//
// What this module does NOT do (by design)
//   • does NOT talk to MT4 directly — every command is forwarded to the
//     local Hub services (`commandBus`) which then drive ZMQ / MQ4.
//   • does NOT expose the operator vault passphrase — API-key updates
//     go through `commandBus.updateApiKey` which is the same path the
//     SETUP DEV/VPS panels use.
//   • does NOT keep any plaintext API key in memory longer than the
//     request that updates it.

const fs       = require("fs");
const path     = require("path");
const os       = require("os");
const crypto   = require("crypto");
const http     = require("http");
const https    = require("https");
const url      = require("url");
const express  = require("express");
const WebSocketServer = require("ws").Server;
const TotpAuth = require("./TotpAuth");
let _qrcode = null; try { _qrcode = require("qrcode"); } catch (_) {}
let   selfsigned;
try { selfsigned = require("selfsigned"); } catch (_) { selfsigned = null; }

const CERT_DIR = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Oblivious", "mobile")
  : path.join(os.homedir(), ".oblivious", "mobile");

function _ensureCert() {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const certP = path.join(CERT_DIR, "cert.pem");
  const keyP  = path.join(CERT_DIR, "key.pem");
  if (fs.existsSync(certP) && fs.existsSync(keyP)) {
    return Promise.resolve({ cert: fs.readFileSync(certP), key: fs.readFileSync(keyP) });
  }
  if (!selfsigned) return Promise.reject(new Error("selfsigned module missing"));
  const attrs = [{ name: "commonName", value: "oblivious-hub.local" }];
  // selfsigned v5+ is async-only and returns a Promise resolving to
  //   { private, public, cert, fingerprint }
  return Promise.resolve(selfsigned.generate(attrs, {
    days: 3650, keySize: 2048, algorithm: "sha256",
    extensions: [{ name: "subjectAltName",
      altNames: [{ type: 2, value: "localhost" },
                 { type: 2, value: "oblivious-hub.local" },
                 { type: 7, ip: "127.0.0.1" }] }],
  })).then((pems) => {
    fs.writeFileSync(certP, pems.cert);
    fs.writeFileSync(keyP,  pems.private);
    return { cert: pems.cert, key: pems.private };
  });
}

class MobileGateway {
  constructor({ port = 8443, registry, commandBus, telemetry, snapshotProvider } = {}) {
    this.port       = +port || 8443;
    this.registry   = registry;
    this.commandBus = commandBus;
    this.telemetry  = telemetry;
    this.snapshotProvider = snapshotProvider; // () => { systemStatus, providers, ... }
    this._pairingTokens = new Map();          // token → {expiresAt, role, name}
    this._sessionSecret = crypto.randomBytes(32);
    this._sockets       = new Set();          // active WS clients (with .deviceId)
    this._server        = null;
    this._wss           = null;
  }

  async start() {
    if (this._server) return { ok: true, port: this.port };
    const app = express();
    app.use(express.json({ limit: "256kb" }));
    app.use("/m/static", express.static(path.join(__dirname, "..", "mobile")));

    app.get("/m/", (_req, res) => {
      res.sendFile(path.join(__dirname, "..", "mobile", "index.html"));
    });

    app.get("/m/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

    // 1) PAIRING — consumes a one-shot token issued via newPairingToken()
    app.post("/m/pair", async (req, res) => {
      const { token, device_name, platform } = req.body || {};
      if (!token) return res.status(400).json({ ok: false, reason: "missing_token" });
      const t = this._pairingTokens.get(token);
      if (!t)                          return res.status(401).json({ ok: false, reason: "invalid_token" });
      if (Date.now() > t.expiresAt)    { this._pairingTokens.delete(token); return res.status(401).json({ ok: false, reason: "token_expired" }); }
      this._pairingTokens.delete(token);
      try {
        const r = await this.registry.register({
          device_name: device_name || "Mobile",
          platform:    platform    || "web",
          role:        t.role || "viewer",
        });
        this._log("info", `Paired device ${r.device_id} (${device_name || "Mobile"})`);
        return res.json({ ok: true, device_id: r.device_id, secret: r.secret });
      } catch (err) {
        return res.status(500).json({ ok: false, reason: err.message });
      }
    });

    // 2) AUTH — exchange (device_id, secret) for a short-lived session token
    app.post("/m/auth", async (req, res) => {
      const { device_id, secret } = req.body || {};
      if (!device_id || !secret) return res.status(400).json({ ok: false, reason: "missing_credentials" });
      const d = await this.registry.authenticate(device_id, secret);
      if (!d) return res.status(401).json({ ok: false, reason: "unauthorized" });
      const exp   = Math.floor(Date.now() / 1000) + 30 * 60;
      const nonce = crypto.randomBytes(8).toString("hex");
      const sig   = crypto.createHmac("sha256", this._sessionSecret)
                          .update(`${device_id}|${exp}|${nonce}`).digest("hex");
      return res.json({ ok: true, session: `${device_id}.${exp}.${nonce}.${sig}`,
                         role: d.role, deviceName: d.device_name });
    });

    const creds = await _ensureCert();
    this._server = https.createServer(creds, app);
    this._wss    = new WebSocketServer({ server: this._server, path: "/m/ws" });
    this._wss.on("connection", (ws, req) => this._onSocket(ws, req));
    await new Promise((resolve, reject) => {
      this._server.once("error", reject);
      this._server.listen(this.port, () => {
        this._log("info", `MobileGateway listening on https://0.0.0.0:${this.port}/m/`);
        resolve();
      });
    });
    // Push snapshots to all sockets every 1s
    this._broadcastTimer = setInterval(() => this._broadcastSnapshot(), 1000);
    return { ok: true, port: this.port };
  }

  stop() {
    clearInterval(this._broadcastTimer);
    for (const ws of this._sockets) { try { ws.close(); } catch (_) {} }
    if (this._wss)    this._wss.close();
    if (this._server) this._server.close();
    this._wss = this._server = null;
  }

  /** Issue a one-shot pairing token (10 minutes TTL). */
  newPairingToken({ role = "viewer", ttlMs = 10 * 60 * 1000, hint = "" } = {}) {
    const token = crypto.randomBytes(12).toString("hex");
    this._pairingTokens.set(token, { expiresAt: Date.now() + ttlMs, role, hint });
    setTimeout(() => this._pairingTokens.delete(token), ttlMs + 1000).unref();
    return { token, expiresAt: new Date(Date.now() + ttlMs).toISOString(), role };
  }

  // ── WS handlers ──────────────────────────────────────────────────
  _verifySession(sessionStr) {
    if (!sessionStr) return null;
    const parts = sessionStr.split(".");
    if (parts.length !== 4) return null;
    const [device_id, exp, nonce, sig] = parts;
    if (Math.floor(Date.now() / 1000) > Number(exp)) return null;
    const want = crypto.createHmac("sha256", this._sessionSecret)
                        .update(`${device_id}|${exp}|${nonce}`).digest("hex");
    try {
      if (!crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
    } catch (_) { return null; }
    const d = (this.registry.list() || []).find((x) => x.device_id === device_id);
    if (!d || d.revoked) return null;
    return d;
  }

  _onSocket(ws, req) {
    const q   = url.parse(req.url, true).query;
    const dev = this._verifySession(q.session);
    if (!dev) { try { ws.close(4401, "unauthorized"); } catch (_) {} return; }
    ws.deviceId   = dev.device_id;
    ws.deviceRole = dev.role || "viewer";
    this._sockets.add(ws);
    this._log("info", `WS open ${dev.device_id} (${dev.device_name})`);
    ws.on("close", () => {
      this._sockets.delete(ws);
      this.registry.markOffline(dev.device_id);
    });
    ws.on("message", async (raw) => {
      let msg; try { msg = JSON.parse(String(raw)); } catch (_) { return; }
      try { await this._handleCommand(ws, msg); }
      catch (err) {
        try { ws.send(JSON.stringify({ type: "error", op: msg && msg.op, reason: err.message })); }
        catch (_) {}
      }
    });
    // Initial snapshot push
    this._sendTo(ws, this._fullSnapshot());
  }

  async _handleCommand(ws, msg) {
    if (!msg || !msg.op) return;
    // Re-check revocation on every command
    const d = (this.registry.list() || []).find((x) => x.device_id === ws.deviceId);
    if (!d || d.revoked) { ws.send(JSON.stringify({ type: "kick", reason: "revoked" })); ws.close(); return; }

    const isAdmin = (ws.deviceRole === "admin");
    const respond = (data) => ws.send(JSON.stringify({ type: "ack", op: msg.op, ...data }));
    switch (msg.op) {
      case "ping":
        return respond({ pong: Date.now() });
      case "snapshot":
        return ws.send(JSON.stringify(this._fullSnapshot()));
      case "close_position":
        return respond(await this.commandBus.closePosition(msg.ticket || msg.id));
      case "cancel_pending":
        return respond(await this.commandBus.cancelPending(msg.ticket || msg.id));
      case "hold":
        return respond(await this.commandBus.hold({ symbol: msg.symbol, enable: !!msg.enable }));
      case "restart_hub":
        if (!isAdmin) return respond({ ok: false, reason: "role_denied" });
        return respond(await this.commandBus.restartHub());
      case "health_check":
        return respond(await this.commandBus.healthCheck());
      case "list_devices":
        if (!isAdmin) return respond({ ok: false, reason: "role_denied" });
        return respond({ devices: this.registry.list() });
      case "revoke_device":
        if (!isAdmin) return respond({ ok: false, reason: "role_denied" });
        return respond({ ok: await this.registry.revoke(msg.device_id) });
      case "set_mobile_enabled":
        if (!isAdmin) return respond({ ok: false, reason: "role_denied" });
        await this.registry.setPolicy({ mobile_enabled: !!msg.enabled });
        return respond({ ok: true, policy: this.registry.policy() });

      // ── TOTP step-up enrollment ─────────────────────────────────
      // 1) admin device asks for a brand-new TOTP secret. The secret is
      //    persisted server-side (marked `totp_active=false`) and the
      //    full provisioning URI + raw base32 secret are returned ONCE
      //    so the device can render its own QR / paste it into the
      //    operator's authenticator app.
      case "totp_enroll": {
        if (!isAdmin) return respond({ ok: false, reason: "role_denied" });
        const sec   = TotpAuth.generateSecret();
        const ok    = await this.registry.setTotpSecret(ws.deviceId, sec.base32);
        if (!ok)    return respond({ ok: false, reason: "device_missing" });
        const list  = this.registry.list() || [];
        const me    = list.find((x) => x.device_id === ws.deviceId);
        const uri   = TotpAuth.provisioningUri({
          account: me?.device_name || ws.deviceId,
          issuer:  "Oblivious AI",
          secretBase32: sec.base32,
        });
        let qrDataUrl = null;
        if (_qrcode) {
          try { qrDataUrl = await _qrcode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 1, scale: 5 }); }
          catch (_) {}
        }
        return respond({ ok: true, secret: sec.base32, otpauth_url: uri, qrDataUrl });
      }
      // 2) admin device confirms by sending a fresh 6-digit code. The
      //    server verifies it against the staged secret and flips
      //    `totp_active=true`. From that moment, every `update_api_key`
      //    call MUST carry a valid `stepUp` code.
      case "totp_confirm": {
        if (!isAdmin) return respond({ ok: false, reason: "role_denied" });
        const sec  = this.registry.getTotpSecret(ws.deviceId);
        if (!sec)  return respond({ ok: false, reason: "no_secret_staged" });
        if (!TotpAuth.verify(sec, msg.code)) return respond({ ok: false, reason: "bad_code" });
        await this.registry.activateTotp(ws.deviceId);
        return respond({ ok: true, totp_active: true });
      }
      case "totp_disable": {
        if (!isAdmin) return respond({ ok: false, reason: "role_denied" });
        if (!msg.code) return respond({ ok: false, reason: "code_required" });
        const sec = this.registry.getTotpSecret(ws.deviceId);
        if (!sec || !TotpAuth.verify(sec, msg.code))
          return respond({ ok: false, reason: "bad_code" });
        await this.registry.clearTotp(ws.deviceId);
        return respond({ ok: true });
      }

      case "update_api_key": {
        if (!isAdmin) return respond({ ok: false, reason: "role_denied" });
        // Step-up: TOTP MUST be enrolled and active for this device, and the
        // current `stepUp` code MUST verify. We do NOT fall back to a
        // "no TOTP yet" branch — refusing without enrollment is the
        // whole point of the gate.
        if (!this.registry.isTotpActive(ws.deviceId)) {
          return respond({ ok: false, reason: "totp_not_enrolled" });
        }
        const sec = this.registry.getTotpSecret(ws.deviceId);
        if (!TotpAuth.verify(sec, msg.stepUp)) {
          return respond({ ok: false, reason: "bad_step_up_code" });
        }
        return respond(await this.commandBus.updateApiKey({
          provider: msg.provider, key: msg.key,
        }));
      }
      default:
        return respond({ ok: false, reason: "unknown_op" });
    }
  }

  // ── Outbound: snapshots ──────────────────────────────────────────
  _fullSnapshot() {
    const snap = (this.snapshotProvider && this.snapshotProvider()) || {};
    return { type: "snapshot", ts: Date.now(), ...snap,
             devices: this.registry.list(),
             policy:  this.registry.policy() };
  }
  _broadcastSnapshot() {
    if (!this._sockets.size) return;
    const payload = JSON.stringify(this._fullSnapshot());
    for (const ws of this._sockets) {
      try { ws.send(payload); } catch (_) {}
    }
  }
  _sendTo(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch (_) {} }

  _log(level, msg) {
    if (this.telemetry && typeof this.telemetry.log === "function") {
      this.telemetry.log(level, "MobileGateway", msg);
    }
  }
}

module.exports = MobileGateway;
