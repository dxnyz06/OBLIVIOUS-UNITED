// Smoke test for MobileGateway + DeviceRegistry — no Electron required.
// Spins the gateway up on a random port, runs the full pairing → auth → WSS
// roundtrip, exercises commands (ping / close_position / cancel_pending /
// hold / list_devices / revoke_device), and asserts the commandBus was called.
// Run with:  node _smoke_test_mobile.js

const fs    = require("fs");
const os    = require("os");
const path  = require("path");
const https = require("https");
const WebSocket = require("ws");

const DeviceRegistry = require("./src/services/DeviceRegistry");
const MobileGateway  = require("./src/services/MobileGateway");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ob-mob-"));
const PORT = 18443 + Math.floor(Math.random() * 100);
const log  = (...a) => console.log("[smoke]", ...a);

// Track every commandBus invocation so we can assert mobile actions
// actually reach the Hub.
const calls = [];
const commandBus = {
  closePosition:  async (id) => { calls.push(["closePosition", id]); return { ok: true, id }; },
  cancelPending:  async (id) => { calls.push(["cancelPending", id]); return { ok: true, id }; },
  hold:           async (a)  => { calls.push(["hold", a]); return { ok: true }; },
  healthCheck:    async ()   => { calls.push(["healthCheck"]); return { ok: true, ts: Date.now() }; },
  restartHub:     async ()   => { calls.push(["restartHub"]); return { ok: true, restarting: true }; },
  updateApiKey:   async (a)  => { calls.push(["updateApiKey", a.provider]); return { ok: true }; },
};
const telemetry = { log: (lvl, src, msg) => log(`${lvl}/${src}: ${msg}`) };
const snapshotProvider = () => ({
  bridge:    { connected: true },
  positions: [{ ticket: 100, sym: "XAUUSD", side: "BUY", lots: 0.1, profit: 12.34 }],
  pending:   [{ ticket: 200, sym: "EURUSD", lots: 0.05, price: 1.0850, type_name: "BUYLIMIT" }],
  account:   { balance: 10_000, equity: 10_012.34, symbol: "XAUUSD", spread: 12 },
  news:      { upcoming: [{ time: Date.now() + 5*60_000, country: "USD", title: "CPI", impact: "HIGH" }] },
});

function _fetch(p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req  = https.request({
      host: "127.0.0.1", port: PORT, path: p,
      method: body ? "POST" : "GET",
      headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {},
      rejectUnauthorized: false,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (_) { resolve({ raw: Buffer.concat(chunks).toString("utf8") }); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  let registry, gateway, ws;
  let pass = 0, fail = 0;
  const ok = (cond, label) => { if (cond) { log("✓", label); pass++; } else { log("✗", label); fail++; } };

  try {
    registry = new DeviceRegistry({
      file: path.join(ROOT, "devices.enc"),
      passphrase: "smoketest",
      telemetry,
    });
    await registry.load();
    gateway = new MobileGateway({ port: PORT, registry, commandBus, telemetry, snapshotProvider });
    await gateway.start();
    await new Promise((r) => setTimeout(r, 300));

    // /m/health
    const health = await _fetch("/m/health");
    ok(health && health.ok, "GET /m/health");

    // Issue a pairing token
    const tok = gateway.newPairingToken({ role: "admin", ttlMs: 60_000 });
    ok(tok.token && tok.role === "admin", "newPairingToken (admin)");

    // /m/pair without token → 400
    const bad = await _fetch("/m/pair", {});
    ok(bad.ok === false && bad.reason === "missing_token", "/m/pair missing token rejected");

    // /m/pair with invalid token → 401
    const badT = await _fetch("/m/pair", { token: "ffeeddcc" });
    ok(badT.ok === false && badT.reason === "invalid_token", "/m/pair bad token rejected");

    // /m/pair OK
    const pair = await _fetch("/m/pair", { token: tok.token, device_name: "iPhone 15", platform: "ios" });
    ok(pair.ok && pair.device_id && pair.secret, "/m/pair OK (device_id+secret returned)");

    // Re-using same token must fail (one-shot)
    const reuse = await _fetch("/m/pair", { token: tok.token, device_name: "Replay" });
    ok(reuse.ok === false, "/m/pair one-shot replay denied");

    // /m/auth
    const auth = await _fetch("/m/auth", { device_id: pair.device_id, secret: pair.secret });
    ok(auth.ok && auth.session && auth.role === "admin", "/m/auth OK with admin role");

    // /m/auth bad secret
    const baddSec = await _fetch("/m/auth", { device_id: pair.device_id, secret: "wrong" });
    ok(baddSec.ok === false, "/m/auth bad secret rejected");

    // WSS connect
    ws = new WebSocket(`wss://127.0.0.1:${PORT}/m/ws?session=${encodeURIComponent(auth.session)}`,
      { rejectUnauthorized: false });
    const inbox = [];
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("ws open timeout")), 4000);
      ws.on("open", () => { clearTimeout(to); resolve(); });
      ws.on("error", (e) => { clearTimeout(to); reject(e); });
    });
    ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
    ok(true, "WSS open");

    // Wait for first snapshot (initial push)
    await new Promise((r) => setTimeout(r, 300));
    const snap0 = inbox.find((m) => m.type === "snapshot");
    ok(snap0 && Array.isArray(snap0.positions) && snap0.positions[0].ticket === 100, "initial snapshot received");
    ok(Array.isArray(snap0.devices) && snap0.devices.length === 1, "snapshot.devices populated");

    // Ping
    inbox.length = 0;
    ws.send(JSON.stringify({ op: "ping" }));
    await new Promise((r) => setTimeout(r, 200));
    ok(inbox.some((m) => m.type === "ack" && m.op === "ping"), "ping ack received");

    // close_position
    inbox.length = 0;
    ws.send(JSON.stringify({ op: "close_position", ticket: 100 }));
    await new Promise((r) => setTimeout(r, 200));
    ok(calls.some((c) => c[0] === "closePosition" && c[1] === 100), "close_position routed to commandBus");

    // cancel_pending
    inbox.length = 0;
    ws.send(JSON.stringify({ op: "cancel_pending", ticket: 200 }));
    await new Promise((r) => setTimeout(r, 200));
    ok(calls.some((c) => c[0] === "cancelPending" && c[1] === 200), "cancel_pending routed");

    // hold
    inbox.length = 0;
    ws.send(JSON.stringify({ op: "hold", symbol: "XAUUSD", enable: true }));
    await new Promise((r) => setTimeout(r, 200));
    ok(calls.some((c) => c[0] === "hold"), "hold routed");

    // list_devices (admin)
    inbox.length = 0;
    ws.send(JSON.stringify({ op: "list_devices" }));
    await new Promise((r) => setTimeout(r, 200));
    const listAck = inbox.find((m) => m.type === "ack" && m.op === "list_devices");
    ok(listAck && Array.isArray(listAck.devices) && listAck.devices.length === 1, "list_devices ack with one device");

    // Try with viewer role: pair a 2nd device with viewer role and ensure
    // restart_hub gets denied.
    const tok2 = gateway.newPairingToken({ role: "viewer", ttlMs: 60_000 });
    const pair2 = await _fetch("/m/pair", { token: tok2.token, device_name: "Pixel", platform: "android" });
    const auth2 = await _fetch("/m/auth", { device_id: pair2.device_id, secret: pair2.secret });
    const ws2 = new WebSocket(`wss://127.0.0.1:${PORT}/m/ws?session=${encodeURIComponent(auth2.session)}`,
      { rejectUnauthorized: false });
    const inbox2 = [];
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error("ws2 open timeout")), 4000);
      ws2.on("open", () => { clearTimeout(to); res(); });
      ws2.on("error", (e) => { clearTimeout(to); rej(e); });
    });
    ws2.on("message", (raw) => inbox2.push(JSON.parse(String(raw))));
    await new Promise((r) => setTimeout(r, 200));
    ws2.send(JSON.stringify({ op: "restart_hub" }));
    await new Promise((r) => setTimeout(r, 200));
    const deny = inbox2.find((m) => m.type === "ack" && m.op === "restart_hub" && m.reason === "role_denied");
    ok(!!deny, "viewer role denied restart_hub");

    // Revoke device-2 from device-1 (admin)
    inbox.length = 0;
    ws.send(JSON.stringify({ op: "revoke_device", device_id: pair2.device_id }));
    await new Promise((r) => setTimeout(r, 250));
    const revAck = inbox.find((m) => m.type === "ack" && m.op === "revoke_device" && m.ok);
    ok(!!revAck, "revoke_device ack ok=true");
    // After revoke, sending a command from ws2 should kick the socket
    ws2.send(JSON.stringify({ op: "ping" }));
    await new Promise((r) => setTimeout(r, 250));
    ok(inbox2.some((m) => m.type === "kick" && m.reason === "revoked"), "revoked device kicked on next msg");

    // Bad session string — must close immediately
    const wsBad = new WebSocket(`wss://127.0.0.1:${PORT}/m/ws?session=garbage`,
      { rejectUnauthorized: false });
    const closed = await new Promise((res) => {
      wsBad.on("close", (code) => res(code));
      wsBad.on("error", () => res(0));
      setTimeout(() => res(-1), 1500);
    });
    ok(closed === 4401 || closed === 1006, "bad session rejected (4401/1006)");

    // ───────── TOTP step-up auth ─────────
    // 1) Pair another admin device so we can drive the enrollment flow
    //    without interfering with the device that is already revoked.
    const tok3 = gateway.newPairingToken({ role: "admin", ttlMs: 60_000 });
    const pair3 = await _fetch("/m/pair", { token: tok3.token, device_name: "Tablet", platform: "ios" });
    const auth3 = await _fetch("/m/auth", { device_id: pair3.device_id, secret: pair3.secret });
    const ws3   = new WebSocket(`wss://127.0.0.1:${PORT}/m/ws?session=${encodeURIComponent(auth3.session)}`,
      { rejectUnauthorized: false });
    const inbox3 = [];
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error("ws3 open timeout")), 4000);
      ws3.on("open", () => { clearTimeout(to); res(); });
      ws3.on("error", (e) => { clearTimeout(to); rej(e); });
    });
    ws3.on("message", (raw) => inbox3.push(JSON.parse(String(raw))));
    await new Promise((r) => setTimeout(r, 200));

    // 2) update_api_key BEFORE TOTP enrollment → must be denied
    inbox3.length = 0;
    ws3.send(JSON.stringify({ op: "update_api_key", provider: "openai", key: "sk-test", stepUp: "000000" }));
    await new Promise((r) => setTimeout(r, 200));
    const preEnroll = inbox3.find((m) => m.type === "ack" && m.op === "update_api_key");
    ok(preEnroll && preEnroll.reason === "totp_not_enrolled", "update_api_key denied without TOTP enrollment");

    // 3) Enroll TOTP → server returns secret + otpauth URI
    inbox3.length = 0;
    ws3.send(JSON.stringify({ op: "totp_enroll" }));
    await new Promise((r) => setTimeout(r, 250));
    const enroll = inbox3.find((m) => m.type === "ack" && m.op === "totp_enroll");
    ok(enroll && enroll.secret && enroll.otpauth_url && enroll.otpauth_url.startsWith("otpauth://"),
       "totp_enroll returned secret + otpauth URI");

    // 4) Confirm with a WRONG code → denied
    inbox3.length = 0;
    ws3.send(JSON.stringify({ op: "totp_confirm", code: "123456" }));
    await new Promise((r) => setTimeout(r, 200));
    const badC = inbox3.find((m) => m.type === "ack" && m.op === "totp_confirm");
    ok(badC && badC.reason === "bad_code", "totp_confirm rejects bad code");

    // 5) Confirm with the correct code computed locally
    const TotpAuth = require("./src/services/TotpAuth");
    const goodCode = TotpAuth.totp(TotpAuth.base32Decode(enroll.secret));
    inbox3.length = 0;
    ws3.send(JSON.stringify({ op: "totp_confirm", code: goodCode }));
    await new Promise((r) => setTimeout(r, 200));
    const okC = inbox3.find((m) => m.type === "ack" && m.op === "totp_confirm" && m.ok && m.totp_active === true);
    ok(!!okC, "totp_confirm activates step-up");

    // 6) update_api_key with WRONG step-up code → denied
    inbox3.length = 0;
    ws3.send(JSON.stringify({ op: "update_api_key", provider: "openai", key: "sk-test", stepUp: "000000" }));
    await new Promise((r) => setTimeout(r, 200));
    const wrongStep = inbox3.find((m) => m.type === "ack" && m.op === "update_api_key");
    ok(wrongStep && wrongStep.reason === "bad_step_up_code", "update_api_key denied with wrong step-up");

    // 7) update_api_key with CORRECT step-up code → forwarded to commandBus
    inbox3.length = 0;
    const goodStep = TotpAuth.totp(TotpAuth.base32Decode(enroll.secret));
    ws3.send(JSON.stringify({ op: "update_api_key", provider: "openai", key: "sk-live-xyz", stepUp: goodStep }));
    await new Promise((r) => setTimeout(r, 200));
    ok(calls.some((c) => c[0] === "updateApiKey" && c[1] === "openai"),
       "update_api_key with valid step-up reaches commandBus");

    // 8) snapshot.devices must NEVER leak the raw TOTP secret
    inbox3.length = 0;
    ws3.send(JSON.stringify({ op: "snapshot" }));
    await new Promise((r) => setTimeout(r, 250));
    const snap = inbox3.find((m) => m.type === "snapshot");
    const me   = snap?.devices?.find((d) => d.device_id === pair3.device_id);
    ok(!!me && me.totp_active === true && me.totp_secret === undefined,
       "snapshot.devices exposes totp_active but never totp_secret");

    log(`PASS ${pass} / FAIL ${fail}`);
    process.exitCode = fail ? 1 : 0;
  } catch (err) {
    console.error("smoke test crashed:", err);
    process.exitCode = 1;
  } finally {
    try { ws?.close(); } catch (_) {}
    try { gateway?.stop(); } catch (_) {}
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
})();
