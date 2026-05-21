// OBLIVIOUS HUB — DecisionEngine
// ----------------------------------------------------------------
// Aggregates news / bookmap / provider state and forwards trade
// commands to the EA over ZMQ. The EA owns ticket lifecycle; the
// hub is read-only by default and only PUBLISHes commands when the
// operator (or a future AI policy) explicitly issues one.
// ----------------------------------------------------------------

const { EventEmitter } = require("events");

class DecisionEngine extends EventEmitter {
  constructor({ newsEngine, bookmap, providerRouter, telemetry } = {}) {
    super();
    this.newsEngine     = newsEngine     || null;
    this.bookmap        = bookmap        || null;
    this.providerRouter = providerRouter || null;
    this.telemetry      = telemetry      || { log: () => {}, emit: () => {} };
    this._publishCommand = () => {};
    this._lastCtx        = null;
    this._trace          = []; // last 50 decisions
  }

  setPublishCommand(fn) {
    if (typeof fn === "function") this._publishCommand = fn;
  }

  onBookmap(snap) {
    // Hook for AI-driven decisions. Default: just record latest snapshot.
    if (snap) this._lastBookmap = snap;
  }

  onContextPush(msg) {
    if (msg) this._lastCtx = msg;
  }

  /**
   * Manual command issue (operator from UI).
   * Wrapped so future AI auto-trade can route through the same path.
   */
  issue(payload) {
    try {
      this._publishCommand(payload);
      const traceEntry = {
        t:      Date.now(),
        op:     payload?.op || "?",
        sym:    payload?.sym || "?",
        owner:  payload?.owner || "Operator",
        corr:   payload?.corr,
      };
      this._trace.push(traceEntry);
      if (this._trace.length > 50) this._trace.shift();
      this.telemetry.log("info", "Decision", `issued ${traceEntry.op} on ${traceEntry.sym}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  snapshot() {
    return {
      lastContext: this._lastCtx,
      trace:       this._trace.slice(-20),
      news:        this.newsEngine ? this.newsEngine.snapshot() : null,
    };
  }
}

module.exports = DecisionEngine;
