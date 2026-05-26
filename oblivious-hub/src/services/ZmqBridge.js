// OBLIVIOUS HUB — ZmqBridge
// ----------------------------------------------------------------
// Three-socket bridge to the MT4 EA:
//   • REP  on repPort  (sync RPC; EA → Hub request/response)
//   • PUB  on pubPort  (broadcast hub state to EA: news, bookmap, commands)
//   • PULL on pullPort (async stream from EA: context_push, trade events)
//
// Uses the `zeromq` npm module if installed; otherwise loads a
// no-op shim so the renderer + UI can still boot in environments
// without ZMQ (e.g. CI smoke tests, browser preview).
// ----------------------------------------------------------------

const { EventEmitter } = require("events");

// Try the modern (zeromq@6) async/await API. Fall back to legacy
// (zeromq@5 callback-style) if needed; finally to a stub.
let zmq = null;
let zmqMode = "stub";
try {
  zmq = require("zeromq");
  // zeromq@6 exports Reply / Publisher / Pull as classes
  zmqMode = (zmq.Reply || zmq.Publisher) ? "v6" : "v5";
} catch (_) { zmq = null; zmqMode = "stub"; }

class ZmqBridge extends EventEmitter {
  constructor({ host, repPort, pubPort, pullPort, decision, newsEngine, providerRouter, bookmap, telemetry } = {}) {
    super();
    this.host = host || "127.0.0.1";
    this.repPort  = +repPort  || 5555;
    this.pubPort  = +pubPort  || 5556;
    this.pullPort = +pullPort || 5557;
    this.decision        = decision || null;
    this.newsEngine      = newsEngine || null;
    this.providerRouter  = providerRouter || null;
    this.bookmap         = bookmap || null;
    this.telemetry       = telemetry || { log: () => {}, emit: () => {} };

    this._rep   = null;
    this._pub   = null;
    this._pull  = null;
    this._running = false;
    this._eaSeenAt = 0;
    this._lastPushTs = 0;
    this._lastContext = null;
    this._pubChain = Promise.resolve();
  }

  // ─────────── lifecycle ───────────

  async start() {
    if (this._running) return;
    if (!zmq || zmqMode === "stub") {
      this.telemetry.log("warn", "ZmqBridge",
        "zeromq module unavailable — running as no-op shim (EA bridge disabled)");
      this._running = true;
      return;
    }

    try {
      if (zmqMode === "v6") {
        this._rep  = new zmq.Reply();
        this._pub  = new zmq.Publisher();
        this._pull = new zmq.Pull();
        await this._rep.bind(`tcp://${this.host}:${this.repPort}`);
        await this._pub.bind(`tcp://${this.host}:${this.pubPort}`);
        await this._pull.bind(`tcp://${this.host}:${this.pullPort}`);
        this._running = true;
        this._loopRepV6();
        this._loopPullV6();
        this.telemetry.log("info", "ZmqBridge", "REP/PULL loops running");
      } else {
        // zeromq@5 fallback
        this._rep  = zmq.socket("rep");
        this._pub  = zmq.socket("pub");
        this._pull = zmq.socket("pull");
        this._rep.bindSync(`tcp://${this.host}:${this.repPort}`);
        this._pub.bindSync(`tcp://${this.host}:${this.pubPort}`);
        this._pull.bindSync(`tcp://${this.host}:${this.pullPort}`);
        this._running = true;
        this._rep.on("message", (msg) => this._onRepMessage(msg));
        this._pull.on("message", (msg) => this._onPullMessage(msg));
      }
      if (!this._running) this._running = true;
      this.telemetry.log("info", "ZmqBridge",
        `bound REP:${this.repPort} PUB:${this.pubPort} PULL:${this.pullPort} (${zmqMode})`);
    } catch (err) {
      this.telemetry.log("error", "ZmqBridge", `bind failed: ${err.message}`);
      throw err;
    }
  }

  async stop() {
    this._running = false;
    const close = async (s) => {
      if (!s) return;
      try {
        if (typeof s.close === "function")    s.close();
        else if (typeof s.disconnect === "function") s.disconnect();
      } catch (_) {}
    };
    await close(this._rep);
    await close(this._pub);
    await close(this._pull);
    this._rep = this._pub = this._pull = null;
  }

  // ─────────── inbound (EA → Hub) ───────────

  async _loopRepV6() {
    while (this._running && this._rep) {
      let raw;
      try {
        [raw] = await this._rep.receive();
      } catch (err) {
        if (!this._running) break;
        this.telemetry.log("warn", "ZmqBridge", `REP recv: ${err.message}`);
        continue;
      }
      let reply = { ok: false, reason: "internal_error" };
      try {
        reply = await this._handleReq(this._parse(raw));
      } catch (err) {
        this.telemetry.log("warn", "ZmqBridge", `REQ handle: ${err.message}`);
        reply = { ok: false, reason: err.message };
      }
      try {
        await this._rep.send(JSON.stringify(reply));
      } catch (err) {
        if (!this._running) break;
        this.telemetry.log("warn", "ZmqBridge", `REP send: ${err.message}`);
      }
    }
  }

  async _loopPullV6() {
    while (this._running && this._pull) {
      try {
        const [raw] = await this._pull.receive();
        this._onPullMessage(raw);
      } catch (err) {
        if (this._running) this.telemetry.log("warn", "ZmqBridge", `PULL loop: ${err.message}`);
        else break;
      }
    }
  }

  _onRepMessage(msg) {
    // v5 callback path
    Promise.resolve(this._handleReq(this._parse(msg))).then((reply) => {
      try { this._rep.send(JSON.stringify(reply)); } catch (_) {}
    });
  }

  _normalizeContext(msg) {
    if (!msg || typeof msg !== "object") return {};
    const nested = (msg.payload && typeof msg.payload === "object") ? msg.payload : null;
    const flat = (msg.balance != null || msg.account_id != null || msg.equity != null) ? msg : null;
    const ctx = flat || nested || msg;
    if (ctx.op === "context_push" && ctx.context && typeof ctx.context === "object") {
      return ctx.context;
    }
    return ctx;
  }

  _onPullMessage(raw) {
    const msg = this._parse(raw);
    if (!msg) return;
    const now = Date.now();
    this._eaSeenAt = now;
    if (this._isContextMsg(msg)) {
      this._lastPushTs = now;
      this._lastContext = this._normalizeContext(msg);
      this.telemetry.log("info", "ZmqBridge",
        `context_push bal=${this._lastContext.balance ?? "?"} eq=${this._lastContext.equity ?? "?"}`);
      this.emit("context_push", this._lastContext);
    } else if (msg.op === "trade_event") {
      this.emit("trade_event", msg);
    } else {
      this.telemetry.log("debug", "ZmqBridge", `pull op=${msg.op || "?"}`);
      this.emit("ea_msg", msg);
    }
  }

  _buildAiResponse(msg) {
    const symbol = msg.symbol || msg.sym || "XAUUSD";
    const strategy = msg.strategy_name || msg.strategyName || "Native";
    const requestId = msg.request_id || "";
    const bm = this.bookmap ? this.bookmap.decision(symbol) : null;
    const ofBias = bm?.of_bias != null ? bm.of_bias : 0;
    const ofConf = bm?.of_confidence != null ? bm.of_confidence : 0;
    const newsSnap = this.newsEngine ? this.newsEngine.snapshot() : null;
    const upcoming = newsSnap?.upcoming || [];
    const nextEv = upcoming[0] || null;
    const newsBlock = !!(newsSnap?.block || nextEv?.impact === "high");
    const engines = msg.engines || {};
    const hybrid = engines.hybrid_confidence != null ? +engines.hybrid_confidence : 0.5;
    const finalBias = typeof ofBias === "number" ? ofBias : (hybrid - 0.5);
    return {
      op: "ai_response",
      ok: true,
      request_id: requestId,
      symbol,
      strategy_name: strategy,
      tpsl_mode: msg.tpsl_mode || "Native",
      provider_used: bm ? "bookmap[hub_cache]+local" : "local",
      news_block_state: newsBlock ? "high" : "none",
      news_impact: nextEv?.impact === "high" ? 3 : 0,
      bookmap_fresh: bm ? 1 : 0,
      bookmap_stale: bm ? 0 : 1,
      bookmap_sequence: bm?.sequence || 0,
      bookmap_age_ms: bm?.age_ms || 0,
      orderflow_bias: ofBias,
      orderflow_confidence: ofConf,
      final_bias: finalBias,
      ai_confidence: hybrid,
      hold_continue: bm?.of_hold_continue ?? 0.5,
      cancel_signal: bm?.of_cancel_signal ?? 0,
      predicted_setup_valid: strategy === "Predicted" ? 1 : 0,
      tp1: 0, tp2: 0, tp3: 0, tpmax: 0,
      invalidate_if: "none",
      of_context: bm ? {
        of_bias: ofBias,
        of_confidence: ofConf,
        of_signal: bm.of_signal || "neutral",
        of_imbalance: bm.of_imbalance ?? 0,
        of_dom_pressure: bm.of_dom_pressure ?? 0,
      } : {},
    };
  }

  async _handleReq(msg) {
    if (msg == null) return { ok: false, reason: "bad_request" };
    if (typeof msg === "string") {
      if (msg.indexOf("GET_AI|") === 0) {
        const parts = msg.split("|");
        msg = { op: "ai_query", symbol: parts[1] || "XAUUSD", strategy_name: parts[2] || "Native" };
      } else {
        try { msg = JSON.parse(msg); } catch { return { ok: false, reason: "bad_json" }; }
      }
    }
    if (typeof msg !== "object") return { ok: false, reason: "bad_request" };
    this._eaSeenAt = Date.now();
    const op = msg.op || msg.type || "";
    switch (op) {
      case "ping":
        return { ok: true, t: Date.now() };
      case "heartbeat":
        return { ok: true, hub_ts: Date.now() };
      case "news":
      case "news_query": {
        const snap = this.newsEngine ? this.newsEngine.snapshot() : null;
        const panel = snap ? this.newsPanelFromSnapshot(snap) : {};
        const top = snap?.upcoming?.[0];
        const imp = String(top?.impact || "").toLowerCase();
        return {
          ok: true,
          block: snap?.block ? 1 : (panel.block ?? 0),
          impact: imp === "high" ? 3 : imp === "medium" ? 2 : (panel.impact ?? 0),
          next_event: panel.next_event || top?.title || top?.event || "",
          until_ts: panel.until_ts || 0,
          panel_line0: panel.panel_line0 || "",
          panel_line1: panel.panel_line1 || "",
          panel_line2: panel.panel_line2 || "",
          panel_pack:  panel.panel_pack || "",
          hub_ts: Date.now(),
          news: snap,
        };
      }
      case "providers":
        return { ok: true, providers: this.providerRouter ? this.providerRouter.snapshot() : null };
      case "ai_query":
        return this._buildAiResponse(msg);
      default:
        if (op) this.telemetry.log("debug", "ZmqBridge", `req op=${op}`);
        return { ok: true, echo: msg };
    }
  }

  // ─────────── outbound (Hub → EA) ───────────

  publishCommand(payload)  { this._pub_send("oblivious.command",  payload); }

  _formatNewsPanelLine(ev) {
    if (!ev || typeof ev !== "object") return "";
    const country = (ev.country || ev.cur || "").toString().trim();
    const title   = (ev.title || ev.event || "").toString().trim();
    if (country && title) return `${country} ${title}`;
    return (title || country).trim();
  }

  _enrichNewsForEa(snapshot) {
    const snap = snapshot && typeof snapshot === "object" ? { ...snapshot } : {};
    const up = Array.isArray(snap.upcoming) ? snap.upcoming.slice() : [];
    const now = Date.now();
    const items = up
      .filter((e) => e && Number.isFinite(Number(e.time ?? e.ts)))
      .map((e) => ({ ev: e, t: Number(e.time ?? e.ts) }));
    const future = items
      .filter((x) => x.t >= now - 60_000)
      .sort((a, b) => a.t - b.t);
    const past = items
      .filter((x) => x.t < now - 60_000)
      .sort((a, b) => b.t - a.t);
    const ordered = [...future.map((x) => x.ev), ...past.map((x) => x.ev)];
    const lines = [];
    for (const ev of ordered) {
      const line = this._formatNewsPanelLine(ev);
      if (line) lines.push(line);
      if (lines.length >= 3) break;
    }
    snap.panel_line0 = lines[0] || "";
    snap.panel_line1 = lines[1] || "";
    snap.panel_line2 = lines[2] || "";
    const next = ordered[0];
    if (next) {
      const imp = String(next.impact || "").toUpperCase();
      snap.impact = imp === "HIGH" ? 3 : imp === "MEDIUM" ? 2 : imp === "LOW" ? 1 : 0;
      snap.next_event = next.title || next.event || "";
      snap.until_ts = Math.floor(Number(next.time ?? next.ts) / 1000);
      snap.block = imp === "HIGH" ? 1 : 0;
    }
    snap.hub_ts = Date.now();
    return snap;
  }

  newsPanelFromSnapshot(snapshot) {
    const e = this._enrichNewsForEa(snapshot);
    const lines = [e.panel_line0, e.panel_line1, e.panel_line2].filter(Boolean);
    return {
      panel_line0: e.panel_line0 || "",
      panel_line1: e.panel_line1 || "",
      panel_line2: e.panel_line2 || "",
      panel_pack:  lines.join("|||"),
      block:       e.block ?? 0,
      impact:      e.impact ?? 0,
      next_event:  e.next_event || "",
      until_ts:    e.until_ts || 0,
    };
  }

  publishNews(snapshot) {
    const e = this._enrichNewsForEa(snapshot);
    const lines = [e.panel_line0, e.panel_line1, e.panel_line2].filter(Boolean);
    // MT4 parses small flat JSON reliably; omit the huge upcoming[] array.
    this._pub_send("oblivious.news", {
      op:          "news",
      block:       e.block ?? 0,
      impact:      e.impact ?? 0,
      next_event:  e.next_event || "",
      until_ts:    e.until_ts || 0,
      panel_line0: e.panel_line0 || "",
      panel_line1: e.panel_line1 || "",
      panel_line2: e.panel_line2 || "",
      panel_pack:  lines.join("|||"),
      hub_ts:      e.hub_ts || Date.now(),
    });
  }
  publishBookmap(snap)     { this._pub_send("oblivious.bookmap",  snap); }
  // Hub → EA liveness (EA SUB on 5556; g_ai_lastHeartbeat / panel HUB row).
  publishHeartbeat(extra = {}) {
    this._pub_send("oblivious.heartbeat", {
      type: "heartbeat",
      hub_ts: Date.now(),
      ts: Math.floor(Date.now() / 1000),
      ...extra,
    });
  }
  // Stream-3: per-symbol orderflow decision payload consumed by EA.
  // Topic is intentionally distinct so the MQ4 side can subscribe to it
  // alone (single, compact frame: {symbol, of_bias, of_confidence, of_signal}).
  publishDecision(payload) { this._pub_send("oblivious.decision", payload); }

  _pub_send(topic, payload) {
    if (!this._pub || !this._running) return;
    const body = JSON.stringify(payload || {});
    const frames = [topic, body];
    if (zmqMode === "v6") {
      this._pubChain = this._pubChain
        .then(() => this._pub.send(frames))
        .catch((e) => {
          this.telemetry.log("warn", "ZmqBridge", `pub failed: ${e.message}`);
        });
    } else {
      try { this._pub.send(frames); } catch (e) {
        this.telemetry.log("warn", "ZmqBridge", `pub failed: ${e.message}`);
      }
    }
  }

  _parseLooseContext(text) {
    if (!text || typeof text !== "string") return null;
    if (text.indexOf("context_push") < 0 && text.indexOf("\"balance\"") < 0) return null;
    const num = (re) => { const m = text.match(re); return m ? parseFloat(m[1]) : undefined; };
    const str = (re) => { const m = text.match(re); return m ? m[1] : undefined; };
    const ctx = {
      op: "context_push",
      sym: str(/"sym"\s*:\s*"([^"]+)"/),
      balance: num(/"balance"\s*:\s*([-\d.]+)/),
      equity: num(/"equity"\s*:\s*([-\d.]+)/),
      free_margin: num(/"free_margin"\s*:\s*([-\d.]+)/),
      margin_level: num(/"margin_level"\s*:\s*([-\d.]+)/),
      leverage: num(/"leverage"\s*:\s*(\d+)/),
      account_id: num(/"account_id"\s*:\s*(\d+)/),
      broker: str(/"broker"\s*:\s*"([^"]*)"/),
      server: str(/"server"\s*:\s*"([^"]*)"/),
      perf_total: num(/"perf_total"\s*:\s*([-\d.]+)/),
      perf_today: num(/"perf_today"\s*:\s*([-\d.]+)/),
      perf_open: num(/"perf_open"\s*:\s*([-\d.]+)/),
    };
    return (ctx.balance != null || ctx.account_id != null) ? ctx : null;
  }

  _parse(raw) {
    if (raw == null) return null;
    if (typeof raw === "string") {
      try { return JSON.parse(raw); } catch {
        return this._parseLooseContext(raw) || { raw };
      }
    }
    if (Buffer.isBuffer(raw)) {
      const s = raw.toString("utf8");
      try { return JSON.parse(s); } catch {
        return this._parseLooseContext(s) || { raw: s };
      }
    }
    return raw;
  }

  _isContextMsg(msg) {
    if (!msg || typeof msg !== "object") return false;
    if (msg.op === "context_push" || msg.kind === "context") return true;
    return (msg.balance != null || msg.account_id != null || msg.equity != null);
  }

  // ─────────── snapshot for renderer ───────────

  snapshot() {
    const ctx = this._lastContext || {};
    const ageMs = this._eaSeenAt ? Date.now() - this._eaSeenAt : Infinity;
    const socketsUp = !!(this._running && this._rep && this._pull);
    const hasContext = (ctx.balance != null || ctx.account_id != null || ctx.equity != null);
    return {
      connected:    socketsUp && hasContext && ageMs < 15000,
      repBound:     !!(this._running && this._rep),
      pullBound:    !!(this._running && this._pull),
      hasContext,
      lastPushTs:   this._lastPushTs || 0,
      mode:         zmqMode,
      lastSeenAgo:  Number.isFinite(ageMs) ? ageMs : null,
      lastContext:  ctx,
      ports: {
        rep: this.repPort, pub: this.pubPort, pull: this.pullPort,
      },
    };
  }
}

module.exports = ZmqBridge;
