// OBLIVIOUS HUB — main process entry point.
//
// Boots the Electron BrowserWindow, wires every long-running service
// (ZmqBridge, NewsEngine, ProviderRouter, BookmapClient, DecisionEngine,
// KeyVault, AiCache) and forwards their telemetry to the renderer over
// IPC.  All sockets bind on 127.0.0.1 only; nothing else is exposed.

const path = require("path");
const fs   = require("fs");
const os   = require("os");
const crypto = require("crypto");
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");

// Dev/headless: load .env if present.  In packaged VPS builds we ship no
// .env file — config.enc is the canonical store and SecureBoot resolves it.
try { require("dotenv").config({ path: path.join(__dirname, "..", ".env") }); } catch {}

const AiCache        = require("./services/AiCache");
const NewsEngine     = require("./services/NewsEngine");
const ProviderRouter = require("./services/ProviderRouter");
const BookmapClient  = require("./services/BookmapClient");
const DecisionEngine = require("./services/DecisionEngine");
const ZmqBridge      = require("./services/ZmqBridge");
const Telemetry      = require("./services/Telemetry");
const SecureBoot     = require("./services/SecureBoot");
const KeyVault       = require("./services/KeyVault");
const passwordPrompt = require("./security/password-prompt");

const HUB_HOST     = "127.0.0.1";
const ZMQ_REQ_PORT = +process.env.ZMQ_REQ_PORT  || 5555;
const ZMQ_PUB_PORT = +process.env.ZMQ_PUB_PORT  || 5556;
const ZMQ_PULL_PORT= +process.env.ZMQ_PULL_PORT || 5557;
const BOOKMAP_WS_PORT = +process.env.BOOKMAP_WS_PORT || 8081;

// SecureBoot resolution: each of `config.enc`, `license.lic`, `public_key.pem`
// is searched independently across an ordered list of candidate directories.
// First existing match wins.  Supports three deployment shapes simultaneously:
//
//   shape A — split layout (preferred VPS):
//     OBLIVIOUS-VPS/app/Oblivious Hub.exe
//     OBLIVIOUS-VPS/config/config.enc
//     OBLIVIOUS-VPS/licenses/{license.lic,public_key.pem}
//
//   shape B — single-folder layout (NSIS install):
//     <install>/Oblivious Hub.exe
//     <install>/{config.enc,license.lic,public_key.pem}
//
//   shape C — dev:
//     repo/oblivious-hub/app/{config.enc,license.lic,public_key.pem}
//
// Override with OBLIVIOUS_CONFIG_DIR, OBLIVIOUS_LICENSES_DIR, OBLIVIOUS_APP_DIR.
function resolveSearchDirs() {
  const dirs = [];
  const push = (d) => { if (d && !dirs.includes(d)) dirs.push(d); };

  push(process.env.OBLIVIOUS_CONFIG_DIR);
  push(process.env.OBLIVIOUS_LICENSES_DIR);
  push(process.env.OBLIVIOUS_APP_DIR);

  if (app.isPackaged) {
    const exeDir = path.dirname(app.getPath("exe"));
    const parent = path.dirname(exeDir);
    push(path.join(parent, "config"));
    push(path.join(parent, "licenses"));
    push(path.join(exeDir, "app"));
    push(exeDir);
  } else {
    // dev tree
    const root = path.join(__dirname, "..");
    const repo = path.join(root, "..");
    push(path.join(root, "app"));
    // Optional DEV-only vault (password + keys separate from OBLIVIOUS-VPS/config in repo)
    push(path.join(repo, "OBLIVIOUS-DEV", "secure-config", "dev-local"));
    push(path.join(repo, "OBLIVIOUS-VPS", "config"));
    push(path.join(repo, "OBLIVIOUS-VPS", "licenses"));
    push(path.join(repo, "OBLIVIOUS-VPS", "app"));
  }
  return dirs;
}

let mainWindow = null;
let services   = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 980,
    minWidth: 1280,
    minHeight: 820,
    backgroundColor: "#05060a",
    title: "OBLIVIOUS AI",
    frame: false,           // custom titlebar in renderer matches PNG mockup
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => { mainWindow = null; });
}

let secureBootSnapshot = { ok: false, step: "init", reason: "uninitialized" };

async function bootServices() {
  const telemetry = new Telemetry({
    emit: (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
      }
    },
  });

  // ───────── SecureBoot: password → device_id → license → config.enc ─────────
  // In DEV (unpackaged Electron run) we SKIP the unlock modal entirely.
  // The vault becomes an in-memory KeyVault — keys live only for this session,
  // never written to config.enc. Production password flow still kicks in for
  // the packaged app (where app.isPackaged === true).
  const inDev = !app.isPackaged && process.env.OBLIVIOUS_PROD_VAULT !== "1";
  let keyVault;
  let secureBootSnapshot_loc = null;
  if (inDev) {
    telemetry.log("info", "SecureBoot", "DEV mode → in-memory vault (no password)");
    keyVault = new KeyVault({ inMemory: true, telemetry });
    if (typeof keyVault.unlock === "function") {
      try { await keyVault.unlock("__dev_bypass__"); } catch (_) {}
    }
    secureBootSnapshot_loc = { step: "DEV_BYPASS", ok: true };
  } else {
    const searchDirs = resolveSearchDirs();
    const secure = new SecureBoot({
      searchDirs,
      telemetry,
      askPassword: process.env.OBLIVIOUS_HEADLESS ? null : passwordPrompt.ask,
    });
    const sb = await secure.run();
    secureBootSnapshot_loc = secure.snapshot();
    if (!sb.ok) {
      telemetry.log("error", "SecureBoot",
        `boot refused: step=${secureBootSnapshot_loc.step} reason=${sb.reason}`);
      if (process.env.OBLIVIOUS_HEADLESS !== "1") {
        try {
          dialog.showErrorBox(
            "OBLIVIOUS HUB — boot refused",
            `Step: ${secureBootSnapshot_loc.step}\nReason: ${sb.reason}\n\nSee logs for details.`
          );
        } catch {}
      }
      throw new Error(`secure_boot_failed:${sb.reason}`);
    }
    keyVault = sb.keyVault;
  }
  secureBootSnapshot = secureBootSnapshot_loc;

  const cache         = new AiCache({ ttlMs: 60_000, telemetry });
  const newsEngine    = new NewsEngine({
    url: process.env.FOREXFACTORY_CSV_URL ||
         "https://nfs.faireconomy.media/ff_calendar_thisweek.csv",
    refreshMinutes: +process.env.NEWS_REFRESH_MINUTES || 5,
    telemetry,
  });
  const providerRouter = new ProviderRouter({ keyVault, cache, telemetry });
  const bookmap        = new BookmapClient({
    url: `ws://${HUB_HOST}:${BOOKMAP_WS_PORT}`,
    telemetry,
    keyVault,
  });
  const decision       = new DecisionEngine({
    newsEngine,
    bookmap,
    providerRouter,
    telemetry,
  });
  const zmq            = new ZmqBridge({
    host: HUB_HOST,
    repPort:  ZMQ_REQ_PORT,
    pubPort:  ZMQ_PUB_PORT,
    pullPort: ZMQ_PULL_PORT,
    decision,
    newsEngine,
    providerRouter,
    telemetry,
  });

  await newsEngine.start();
  bookmap.start();
  await zmq.start();

  // Wire DecisionEngine command publication through ZmqBridge.
  decision.setPublishCommand((payload) => zmq.publishCommand(payload));

  // Pump news state to EA over PUB topic.
  newsEngine.on("update", (snapshot) => {
    zmq.publishNews(snapshot);
    telemetry.emit("hub:news",       newsEngine.snapshot());
  });
  bookmap.on("snapshot", (snap) => {
    // Aggregated UI snapshot is for the renderer and back-compat
    // multi-symbol consumers. The MQ4 side consumes only the
    // per-symbol decision frame emitted on `bookmap:decision` below
    // (spec-shaped envelope). Both go on the same topic
    // (`oblivious.bookmap`) but with different payload shapes —
    // AI_HandleBookmap is robust to either.
    zmq.publishBookmap(snap);
    decision.onBookmap(snap);
    telemetry.emit("hub:bookmap",  bookmap.snapshot());
    telemetry.emit("hub:decision", decision.snapshot());
  });
  // Per-symbol live orderflow decision — the OFFICIAL envelope the
  // EA consumes for g_of_* updates. Spec shape:
  //   { topic, symbol, timestamp, sequence, fresh, stale, age_ms, of_context }
  bookmap.on("decision", (frame) => {
    try {
      const sym = frame?.symbol || "";
      const dec = frame?.decision || {};
      const ts  = Number(dec.last_update_ts) || Number(dec.ts) || Date.now();
      const ageMs = Math.max(0, Date.now() - ts);
      const fresh = Boolean(dec.fresh) && ageMs < 5000;
      const envelope = {
        topic:           "oblivious.bookmap",
        symbol:          sym,
        timestamp:       ts,
        sequence:        Number(dec.sequence) || 0,
        fresh,
        stale:           !fresh,
        age_ms:          ageMs,
        of_context: {
          of_bias:             ofBiasNum(dec.of_bias),
          of_confidence:       round3((Number(dec.of_confidence) || 0) / 100),
          of_signal:           dec.of_signal || "NONE",
          of_imbalance:        round3(dec.of_imbalance),
          of_dom_pressure:     round3(domPressureNum(dec.of_dom_pressure)),
          of_delta_shift:      round3(dec.of_delta_shift),
          of_delta_divergence: round3(dec.of_delta_divergence),
          of_absorption:       round3(dec.of_absorption),
          of_exhaustion:       round3(dec.of_exhaustion),
          of_iceberg_side:     icebergSideNum(dec.of_iceberg_side),
          of_iceberg_strength: round3(dec.of_iceberg_strength),
          of_stop_activity:    round3(dec.of_stop_activity),
          of_sweep_signal:     sweepSignalNum(dec.of_sweep_signal),
          of_trap_signal:      sweepSignalNum(dec.of_trap_signal),
          of_hold_continue:    round3(dec.of_hold_continue),
          of_cancel_signal:    round3(dec.of_cancel_signal),
          of_execution_danger: round3(Math.min(1,
            (Number(dec.of_exhaustion)  || 0) * 0.45 +
            (Number(dec.of_cancel_signal) || 0) * 0.55)),
        },
      };
      zmq.publishBookmap(envelope);
    } catch (_) {}
  });
  zmq.on("context_push", (msg) => {
    decision.onContextPush(msg);
    // Push instant bridge snapshot so Account Matrix / Positions / chart
    // react without waiting for the 1Hz tick.
    telemetry.emit("hub:bridge", zmq.snapshot());
  });

  // ─── SMART LOG enrichment ───────────────────────────────────────────
  // The "NEURAL SMART LOG" is the operator's single pane of glass for
  // everything happening in the system. Wire EVERY service to it so
  // the log shows: Bookmap signals, News flips, Decisions, EA context
  // pushes (entries / TP / SL / strategies) and ZMQ heartbeat.
  let _lastEaTs   = 0;
  let _lastPosFp  = "";
  let _lastNewsId = null;
  // Bookmap raw signals (iceberg/absorption/sweep/exhaustion are
  // already promoted into snap.events by BookmapClient).
  bookmap.on("snapshot", (snap) => {
    const ev = (snap.events || [])[0];
    if (!ev || !["iceberg", "absorption", "sweep", "exhaustion"].includes(ev.type)) return;
    const sym  = ev.sym || ev.symbol || snap.symbol || "";
    const px   = ev.price ? Number(ev.price).toFixed(ev.price < 10 ? 5 : 2) : "";
    const side = (ev.side || "").toUpperCase();
    let msg = "";
    if      (ev.type === "iceberg")    msg = `ICEBERG ${side} ${sym} @ ${px} (refills x${ev.refills ?? "?"})`;
    else if (ev.type === "absorption") msg = `ABSORPTION ${side} ${sym} ${ev.qty ?? "?"} lots @ ${px}`;
    else if (ev.type === "sweep")      msg = `SWEEP ${side} ${sym} ${ev.levels ?? "?"}L · ${ev.qty ?? "?"} lots`;
    else if (ev.type === "exhaustion") msg = `EXHAUSTION ${side} ${sym}`;
    if (msg) telemetry.log("info", "MBO", msg);
  });
  // Stream-3 decision frames
  bookmap.on("decision", (frame) => {
    const d = frame?.decision || {};
    if (!d.of_bias) return;
    telemetry.log("info", "MBO",
      `Decision ${frame.symbol}: ${String(d.of_bias).toUpperCase()} · conf ${d.of_confidence ?? 0}% · ${d.of_signal || "none"}`);
  });
  // Diagnostic counters from the Python bridge (every 15s)
  bookmap.on("diagnostic", (d) => {
    const hint = (d.depth === 0 && d.trade === 0 && d.mbo === 0 && d.bbo === 0)
      ? " — NO MARKET DATA, enable 'Show Bookmap' + 'MBP Depth' on your chart"
      : "";
    telemetry.log("info", "MBO",
      `Bridge: depth=${d.depth} trades=${d.trade} mbo=${d.mbo} bbo=${d.bbo} · ${(d.symbols || []).join(",") || "no-symbol"}${hint}`);
  });
  // NewsEngine — log when next-event flips
  newsEngine.on("update", (snap) => {
    const top = Array.isArray(snap?.upcoming) ? snap.upcoming[0] : null;
    if (!top) return;
    const id = `${top.time}:${top.title || top.event || ""}`;
    if (id === _lastNewsId) return;
    _lastNewsId = id;
    const eta = top.time ? Math.max(0, Math.round((top.time - Date.now()) / 60000)) : null;
    const impact = (top.impact || "?").toString().toUpperCase();
    telemetry.log("info", "News",
      `Next: ${top.country || top.cur || ""} ${top.title || top.event || ""} in ${eta}m [${impact}]`);
  });
  // EA context_push: heartbeat (5s rate-limited) + per-position diff
  zmq.on("context_push", (msg) => {
    const ctx = (msg && msg.context) || msg || {};
    const sym = ctx.sym || ctx.symbol || "";
    const now = Date.now();
    if (sym && now - _lastEaTs > 5_000) {
      _lastEaTs = now;
      telemetry.log("info", "EA",
        `Context ${sym} · bal $${(+ctx.balance || 0).toFixed(2)} · eq $${(+ctx.equity || 0).toFixed(2)} · spread ${ctx.spread ?? "?"}`);
    }
    const positions = Array.isArray(ctx.positions) ? ctx.positions : [];
    const fp = positions.map((p) => `${p.ticket}:${p.tpsl_stage || ""}`).join("|");
    if (fp !== _lastPosFp) {
      _lastPosFp = fp;
      for (const p of positions) {
        const side = (p.side || (p.type === 0 ? "BUY" : "SELL") || "").toUpperCase();
        telemetry.log("info", "EA",
          `${side} ${p.sym || p.symbol} ${p.lots ?? p.volume} · entry ${p.entry || p.open_price} · SL ${p.sl} TP ${p.tp} · ${p.tpsl_stage || "ENTRY"}${p.strategy ? " · " + p.strategy : ""}`);
      }
    }
  });

  // 1 Hz refresh tick for the panels that don't emit on their own
  // (system stats, providers metrics, decision trace).
  setInterval(() => {
    telemetry.emit("hub:bridge",    zmq.snapshot());
    telemetry.emit("hub:providers", providerRouter.snapshot());
    telemetry.emit("hub:decision",  decision.snapshot());
  }, 1000);

  // Refresh AI provider balances (DeepSeek currently; others are no-ops)
  // every 60s. Run once immediately so the BALANCE column is populated
  // by the time the first snapshot is sent to the renderer.
  const _refreshBal = () => providerRouter.refreshBalances()
    .then(() => telemetry.emit("hub:providers", providerRouter.snapshot()))
    .catch((e) => telemetry.log("warn", "ProviderRouter", "balance refresh: " + e.message));
  _refreshBal();
  setInterval(_refreshBal, 60_000);

  return { keyVault, cache, newsEngine, providerRouter, bookmap, decision, zmq, telemetry };
}

function isDevEnvironment() {
  return !app.isPackaged || process.env.OBLIVIOUS_DEV === "1";
}

function registerIpc() {
  // ---- snapshot ----
  ipcMain.handle("hub:getSnapshot", () => {
    if (!services) return null;
    return {
      bridge:    services.zmq.snapshot(),
      news:      services.newsEngine.snapshot(),
      providers: services.providerRouter.snapshot(),
      bookmap:   services.bookmap.snapshot(),
      decision:  services.decision.snapshot(),
      secure:    secureBootSnapshot,
      logs:      services.telemetry.recent().slice(-50),
      env:       { dev: isDevEnvironment() },
    };
  });

  // ---- window controls (custom frame) ----
  ipcMain.handle("win:minimize", () => { if (mainWindow) mainWindow.minimize(); });
  ipcMain.handle("win:maximize", () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) { mainWindow.unmaximize(); return false; }
    mainWindow.maximize(); return true;
  });
  ipcMain.handle("win:close",    () => { if (mainWindow) mainWindow.close(); });
  ipcMain.handle("win:openExternal", (_e, url) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) shell.openExternal(url);
  });

  // ---- News fallback: when NewsEngine snapshot doesn't reach the renderer
  //      (or is in a shape we don't parse), the renderer can directly pull
  //      the FF CSV through this IPC. Main is allowed to do plain HTTP — the
  //      renderer's CSP blocks external connect-src. ----
  let _newsCache = { ts: 0, upcoming: [] };
  ipcMain.handle("news:fetchFallback", async () => {
    // Re-use cache for 30 minutes (FF returns HTTP 429 on aggressive fetches)
    if (Date.now() - _newsCache.ts < 30 * 60 * 1000 && _newsCache.upcoming.length) {
      return { ok: true, upcoming: _newsCache.upcoming, cached: true };
    }
    try {
      const https = require("https");
      // FF only publishes ff_calendar_thisweek.csv. Mirror redundancy
      // for 429 resilience; the renderer fills past slots if upcoming
      // events don't reach 10 rows.
      const mirrors = [
        "https://nfs.faireconomy.media/ff_calendar_thisweek.csv",
      ];
      let text = "";
      for (const url of mirrors) {
        try {
          text = await new Promise((res, rej) => {
            const u = new URL(url);
            const req = https.request({
              host: u.hostname, path: u.pathname + u.search, method: "GET",
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept":     "text/csv,*/*;q=0.9",
                "Accept-Language": "en-US,en;q=0.9",
              },
              timeout: 12000,
            }, (resp) => {
              if (resp.statusCode !== 200) {
                rej(new Error(`status=${resp.statusCode}`));
                resp.resume(); return;
              }
              let body = "";
              resp.on("data", (c) => { body += c.toString("utf8"); });
              resp.on("end",  () => res(body));
              resp.on("error", rej);
            });
            req.on("error", rej);
            req.on("timeout", () => { req.destroy(); rej(new Error("timeout")); });
            req.end();
          });
          if (text) break;
        } catch (_) { /* try next mirror */ }
      }
      if (!text) throw new Error("all mirrors failed");
      // Forex Factory CSV columns: Title,Country,Date,Time,Impact,Forecast,Previous,URL
      const lines = text.split(/\r?\n/).filter(Boolean);
      lines.shift(); // header
      const events = [];
      for (const ln of lines) {
        const cols = ln.split(",");
        if (cols.length < 5) continue;
        const [title, country, date, time, impact] = cols;
        let ts = null;
        try {
          const t = (time || "").trim();
          // Date is MM-DD-YYYY in FF CSV. Convert to YYYY-MM-DD so
          // every JS engine parses it as ISO (avoids locale ambiguity).
          const [mm, dd, yyyy] = String(date || "").split("-");
          const isoDate = (yyyy && mm && dd) ? `${yyyy}-${mm}-${dd}` : date;
          if (/All Day|Tentative|^$/i.test(t)) {
            ts = new Date(`${isoDate}T12:00:00Z`).getTime();
          } else {
            const ampm = /pm/i.test(t);
            const [h, mPart] = t.replace(/[ap]m/i, "").split(":");
            let hr = +h % 12;
            if (ampm) hr += 12;
            const hh = String(hr).padStart(2, "0");
            const mn = String(mPart || "00").padStart(2, "0");
            // EST = UTC-5 (FF uses EST/EDT; close enough for a UI list)
            ts = new Date(`${isoDate}T${hh}:${mn}:00-05:00`).getTime();
          }
        } catch (_) { ts = Date.now(); }
        events.push({
          time:    ts,
          country: (country || "").trim(),
          title:   (title || "").trim().replace(/^"|"$/g, ""),
          impact:  (impact || "Low").trim().toUpperCase(),
        });
      }
      // Return ALL parsed events sorted ascending — the renderer decides
      // which to surface (upcoming first, falling back to recent past).
      const upcoming = events
        .filter((e) => Number.isFinite(e.time))
        .sort((a, b) => a.time - b.time);
      _newsCache = { ts: Date.now(), upcoming };
      return { ok: true, upcoming };
    } catch (e) {
      // On hard failure, return whatever we have cached (even if stale)
      if (_newsCache.upcoming.length) {
        return { ok: true, upcoming: _newsCache.upcoming, stale: true };
      }
      return { ok: false, reason: String(e.message || e) };
    }
  });

  // ---- trading commands (R7: hub never owns trades, only forwards command) ----
  ipcMain.handle("cmd:closePosition", (_e, payload) => {
    if (!services) return { ok: false, reason: "not_ready" };
    const ticket = Number(payload && payload.ticket);
    if (!ticket || !Number.isFinite(ticket)) return { ok: false, reason: "bad_ticket" };
    try {
      services.zmq.publishCommand({
        op:      "CLOSE_POSITION",
        ticket,
        owner:   payload?.owner   || "Operator",
        magic:   payload?.magic   || 0,
        sym:     payload?.sym     || "",
        comment: payload?.comment || "OBLIVIOUS-Operator-Close",
        corr:    crypto.randomUUID(),
      });
      services.telemetry.log("info", "Operator", `CLOSE_POSITION sent for ticket ${ticket}`);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle("cmd:changeSymbol", (_e, payload) => {
    if (!services) return { ok: false, reason: "not_ready" };
    const sym = String(payload && payload.sym || "").toUpperCase().trim();
    if (!sym) return { ok: false, reason: "bad_symbol" };
    try {
      services.zmq.publishCommand({ op: "SET_SYMBOL", sym, corr: crypto.randomUUID() });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  });

  ipcMain.handle("cmd:changeTimeframe", (_e, payload) => {
    if (!services) return { ok: false, reason: "not_ready" };
    const tf = String(payload && payload.tf || "").trim();
    if (!tf) return { ok: false, reason: "bad_tf" };
    services.zmq.publishCommand({ op: "SET_TIMEFRAME", tf, corr: crypto.randomUUID() });
    return { ok: true };
  });

  ipcMain.handle("cmd:setTpslMode", (_e, payload) => {
    if (!services) return { ok: false, reason: "not_ready" };
    const mode = String(payload && payload.mode || "").trim();
    if (!["AI", "Native"].includes(mode)) return { ok: false, reason: "bad_mode" };
    services.zmq.publishCommand({ op: "SET_TPSL_MODE", mode, corr: crypto.randomUUID() });
    return { ok: true };
  });

  // ---- AI provider testing / vault management ----
  ipcMain.handle("vault:listProviders", () => {
    if (!services) return [];
    return services.keyVault.listProviders();
  });

  ipcMain.handle("vault:testProvider", async (_e, payload) => {
    if (!services) return { ok: false, reason: "not_ready" };
    const name = String(payload && payload.provider || "").toLowerCase();
    return await services.providerRouter.testProvider(name);
  });

  // Validate a freshly-typed key WITHOUT writing it to the vault first.
  ipcMain.handle("vault:testKey", async (_e, payload) => {
    if (!services) return { ok: false, reason: "not_ready" };
    const name = String(payload && payload.provider || "").toLowerCase();
    const key  = String(payload && payload.key || "");
    return await services.providerRouter.testProviderKey(name, key);
  });

  ipcMain.handle("vault:testAll", async () => {
    if (!services) return { ok: false, reason: "not_ready" };
    const r = await services.providerRouter.testAll();
    return { ok: true, results: r };
  });

  ipcMain.handle("vault:reconnectAll", () => {
    if (!services) return { ok: false, reason: "not_ready" };
    services.providerRouter.reloadKeys();
    services.telemetry.log("info", "ProviderRouter", "manual reconnect: reloaded keys from vault");
    return { ok: true };
  });

  ipcMain.handle("vault:setKey", async (_e, payload) => {
    if (!services) return { ok: false, reason: "not_ready" };
    const provider = String(payload && payload.provider || "").toLowerCase();
    const key = String(payload && payload.key || "");
    if (!services.keyVault.listProviders().includes(provider)) {
      return { ok: false, reason: "unknown_provider" };
    }
    if (!services.keyVault.passphrase) {
      return { ok: false, reason: "vault_locked" };
    }
    try {
      await services.keyVault.setProviderKey(provider, key);
      services.providerRouter.reloadKeys();
      // Refresh balance immediately on the provider that just got a new
      // key so the BALANCE column updates without waiting for the 60s tick.
      services.providerRouter.refreshBalances().then(() => {
        services.telemetry.emit("hub:providers", services.providerRouter.snapshot());
      }).catch(() => {});
      // If user changed the Bookmap key, force the WS client to reconnect
      // immediately with the new credentials.
      if (provider === "bookmap") {
        try { services.bookmap?.stop?.(); } catch (_) {}
        services.bookmap = new BookmapClient({
          url: `ws://${HUB_HOST}:${BOOKMAP_WS_PORT}`,
          telemetry: services.telemetry,
          keyVault:  services.keyVault,
        });
        services.bookmap.on("snapshot", (snap) => {
          try { services.zmq.publishBookmap(snap); } catch (_) {}
          try { services.decision.onBookmap(snap); } catch (_) {}
          services.telemetry.emit("hub:bookmap", services.bookmap.snapshot());
        });
        services.bookmap.on("decision", (frame) => {
          try { services.zmq.publishDecision(frame); } catch (_) {}
        });
        services.bookmap.on("diagnostic", (d) => {
          const hint = (d.depth === 0 && d.trade === 0 && d.mbo === 0 && d.bbo === 0)
            ? " — NO MARKET DATA, enable 'Show Bookmap' + 'MBP Depth'"
            : "";
          services.telemetry.log("info", "MBO",
            `Bridge: depth=${d.depth} trades=${d.trade} mbo=${d.mbo} bbo=${d.bbo}${hint}`);
        });
        services.bookmap.start();
      }
      services.telemetry.log("info", "KeyVault",
        `API key updated for ${provider} (len=${key.length})`);
      return { ok: true };
    } catch (err) {
      services.telemetry.log("error", "KeyVault", `setKey failed: ${err.message}`);
      return { ok: false, reason: err.message };
    }
  });

  // ---- VPS Control Center (DEV ONLY) ----
  ipcMain.handle("vps:status", () => {
    return {
      dev: isDevEnvironment(),
      device: secureBootSnapshot?.device?.id || null,
      license: secureBootSnapshot?.license || null,
      configSource: secureBootSnapshot?.configSource || null,
    };
  });

  ipcMain.handle("vps:generateUnlockKey", () => {
    if (!isDevEnvironment()) return { ok: false, reason: "dev_only" };
    const key = crypto.randomBytes(32).toString("base64url");
    const fp  = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
    services?.telemetry.log("info", "VPS", `Unlock key generated (fp=${fp})`);
    return { ok: true, key, fingerprint: fp, issuedAt: new Date().toISOString() };
  });

  ipcMain.handle("vps:rotateUnlockKey", () => {
    if (!isDevEnvironment()) return { ok: false, reason: "dev_only" };
    const key = crypto.randomBytes(32).toString("base64url");
    const fp  = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
    services?.telemetry.log("info", "VPS", `Unlock key rotated (fp=${fp})`);
    return { ok: true, key, fingerprint: fp, rotatedAt: new Date().toISOString() };
  });

  ipcMain.handle("vps:revokeAccess", () => {
    if (!isDevEnvironment()) return { ok: false, reason: "dev_only" };
    services?.telemetry.log("warn", "VPS", "Access revocation requested by operator");
    return { ok: true, revokedAt: new Date().toISOString() };
  });

  ipcMain.handle("vps:bindFingerprint", () => {
    if (!isDevEnvironment()) return { ok: false, reason: "dev_only" };
    // In DEV mode SecureBoot is skipped → no device id from snapshot.
    // Derive a stable per-machine id from host hints so the UI button
    // still produces a meaningful result.
    let deviceId = secureBootSnapshot?.device?.id;
    if (!deviceId) {
      const seed = [
        process.platform, process.arch, os.hostname(),
        os.userInfo().username,
      ].join("|");
      deviceId = crypto.createHash("sha256").update(seed).digest("hex");
    }
    services?.telemetry.log("info", "VPS", `Device fingerprint bound: ${deviceId.slice(0,12)}…`);
    return { ok: true, deviceId };
  });

  ipcMain.handle("vps:generateRuntime", () => {
    if (!isDevEnvironment()) return { ok: false, reason: "dev_only" };
    const runtimeId = crypto.randomBytes(8).toString("hex");
    services?.telemetry.log("info", "VPS", `Secure runtime token issued: ${runtimeId}`);
    return { ok: true, runtimeId, issuedAt: new Date().toISOString() };
  });
}

app.whenReady().then(async () => {
  registerIpc();
  try {
    services = await bootServices();
  } catch (err) {
    console.error("[Hub] boot failed:", err);
    app.exit(1);
    return;
  }
  createWindow();
});

// ── Numeric normalisation helpers (used by the per-symbol
// `oblivious.bookmap` envelope publisher above). Mirror the
// converters in DecisionEngine so the EA always sees plain
// numbers (the MQ4 parser is JSON-aware but only for flat
// strings/numbers/bools — strings like "bullish" / "bid_heavy"
// would otherwise become 0 after StringToDouble).
function round3(x) { x = Number(x); return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : 0; }
function ofBiasNum(s) {
  if (typeof s === "number") return Math.max(-1, Math.min(1, s));
  s = String(s || "").toLowerCase();
  if (s === "bullish" || s === "bull" || s === "up")   return 1;
  if (s === "bearish" || s === "bear" || s === "down") return -1;
  return 0;
}
function domPressureNum(s) {
  s = String(s || "").toLowerCase();
  if (s === "bid_heavy") return 1;
  if (s === "ask_heavy") return -1;
  return 0;
}
function icebergSideNum(s) {
  s = String(s || "").toLowerCase();
  if (s === "bid" || s === "buy")  return 1;
  if (s === "ask" || s === "sell") return -1;
  return 0;
}
function sweepSignalNum(s) {
  s = String(s || "").toLowerCase();
  if (s === "up")   return 1;
  if (s === "down") return -1;
  return 0;
}

app.on("window-all-closed", async () => {
  // Release ZMQ ports BEFORE quitting so the next `npm start` won't hit EADDRINUSE.
  if (services) {
    try { await services.zmq?.stop?.(); } catch (e) { /* noop */ }
    try { services.newsEngine?.stop?.(); } catch (e) { /* noop */ }
    try { services.bookmap?.stop?.();    } catch (e) { /* noop */ }
  }
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", async () => {
  if (services) {
    try { await services.zmq?.stop?.(); } catch (e) { /* noop */ }
    try { services.newsEngine?.stop?.(); } catch (e) { /* noop */ }
    try { services.bookmap?.stop?.();    } catch (e) { /* noop */ }
  }
});

// Last-resort cleanup on hard signals (Ctrl+C in PowerShell, SIGTERM, etc.)
const _hardExit = async () => {
  if (services) {
    try { await services.zmq?.stop?.(); } catch {}
    try { services.newsEngine?.stop?.(); } catch {}
    try { services.bookmap?.stop?.();    } catch {}
  }
  process.exit(0);
};
process.on("SIGINT",  _hardExit);
process.on("SIGTERM", _hardExit);
