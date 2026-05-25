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
  constructor({ host, repPort, pubPort, pullPort, decision, newsEngine, providerRouter, telemetry } = {}) {
    super();
    this.host = host || "127.0.0.1";
    this.repPort  = +repPort  || 5555;
    this.pubPort  = +pubPort  || 5556;
    this.pullPort = +pullPort || 5557;
    this.decision        = decision || null;
    this.newsEngine      = newsEngine || null;
    this.providerRouter  = providerRouter || null;
    this.telemetry       = telemetry || { log: () => {}, emit: () => {} };

    this._rep   = null;
    this._pub   = null;
    this._pull  = null;
    this._running = false;
    this._eaSeenAt = 0;
    this._lastContext = null;
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
        this._loopRepV6();
        this._loopPullV6();
      } else {
        // zeromq@5 fallback
        this._rep  = zmq.socket("rep");
        this._pub  = zmq.socket("pub");
        this._pull = zmq.socket("pull");
        this._rep.bindSync(`tcp://${this.host}:${this.repPort}`);
        this._pub.bindSync(`tcp://${this.host}:${this.pubPort}`);
        this._pull.bindSync(`tcp://${this.host}:${this.pullPort}`);
        this._rep.on("message", (msg) => this._onRepMessage(msg));
        this._pull.on("message", (msg) => this._onPullMessage(msg));
      }
      this._running = true;
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
      try {
        const [raw] = await this._rep.receive();
        const msg = this._parse(raw);
        const reply = await this._handleReq(msg);
        await this._rep.send(JSON.stringify(reply));
      } catch (err) {
        if (this._running) this.telemetry.log("warn", "ZmqBridge", `REP loop: ${err.message}`);
        else break;
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

  _onPullMessage(raw) {
    const msg = this._parse(raw);
    if (!msg) return;
    this._eaSeenAt = Date.now();
    if (msg.op === "context_push" || msg.kind === "context") {
      this._lastContext = msg.payload || msg;
      this.emit("context_push", msg);
    } else if (msg.op === "trade_event") {
      this.emit("trade_event", msg);
    } else {
      this.emit("ea_msg", msg);
    }
  }

  async _handleReq(msg) {
    if (!msg || typeof msg !== "object") return { ok: false, reason: "bad_request" };
    this._eaSeenAt = Date.now();
    switch (msg.op) {
      case "ping":
        return { ok: true, t: Date.now() };
      case "news":
        return { ok: true, news: this.newsEngine ? this.newsEngine.snapshot() : null };
      case "providers":
        return { ok: true, providers: this.providerRouter ? this.providerRouter.snapshot() : null };
      default:
        return { ok: true, echo: msg };
    }
  }

  // ─────────── outbound (Hub → EA) ───────────

  publishCommand(payload)  { this._pub_send("oblivious.command",  payload); }
  publishNews(snapshot)    { this._pub_send("oblivious.news",     snapshot); }
  publishBookmap(snap)     { this._pub_send("oblivious.bookmap",  snap); }
  // Stream-3: per-symbol orderflow decision payload consumed by EA.
  // Topic is intentionally distinct so the MQ4 side can subscribe to it
  // alone (single, compact frame: {symbol, of_bias, of_confidence, of_signal}).
  publishDecision(payload) { this._pub_send("oblivious.decision", payload); }

  _pub_send(topic, payload) {
    if (!this._pub || !this._running) return;
    try {
      const body = JSON.stringify(payload || {});
      // Multipart [topic, body] is the standard ZMQ PUB pattern.
      if (zmqMode === "v6") {
        this._pub.send([topic, body]).catch(() => {});
      } else {
        this._pub.send([topic, body]);
      }
    } catch (e) {
      this.telemetry.log("warn", "ZmqBridge", `pub failed: ${e.message}`);
    }
  }

  _parse(raw) {
    if (raw == null) return null;
    if (typeof raw === "string") {
      try { return JSON.parse(raw); } catch { return { raw }; }
    }
    if (Buffer.isBuffer(raw)) {
      const s = raw.toString("utf8");
      try { return JSON.parse(s); } catch { return { raw: s }; }
    }
    return raw;
  }

  // ─────────── snapshot for renderer ───────────

  snapshot() {
    const ctx = this._lastContext || {};
    const ageMs = this._eaSeenAt ? Date.now() - this._eaSeenAt : Infinity;
    return {
      connected:    ageMs < 5000,
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
