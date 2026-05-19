// OBLIVIOUS HUB — BookmapClient (EXE BRAIN).
//
// Role separation (do NOT violate):
//   Bookmap bridge  = SENSOR (raw events + 3 specialised snapshots).
//   THIS file       = EXE / BRAIN. Receives sensor data and computes
//                     normalised `of_*` decision fields for the EA.
//   EA              = executor (owns risk, TP/SL, news, lot sizing).
//
// Bridge protocol (matches oblivious_bridge.py header):
//
//   RAW events (Stream A) :  depth | trade | mbo
//   SEMANTIC events (B)   :  iceberg | stop_run | sweep |
//                            absorption | exhaustion
//   SNAPSHOTS (C, every ~150ms, 3 frames per symbol):
//                            dom_pressure | delta_tape | liquidity
//
// This client folds all of the above into a per-symbol state, then
// emits a derived `of_*` decision frame for downstream consumers
// (renderer chips + ZMQ → EA).
//
// Output fields we produce per symbol (the EXE contract):
//   of_bias              : "bullish" | "bearish" | "neutral"
//   of_confidence        : 0..100
//   of_signal            : last semantic label ("ABSORPTION_BID", ...)
//   of_imbalance         : -1..1
//   of_dom_pressure      : "bid_heavy" | "ask_heavy" | "neutral"
//   of_delta_shift       : float
//   of_delta_divergence  : -1..1
//   of_absorption        : 0..1
//   of_exhaustion        : 0..1
//   of_iceberg_side      : "bid" | "ask" | ""
//   of_iceberg_strength  : 0..1
//   of_stop_activity     : 0..1
//   of_sweep_signal      : "up" | "down" | ""
//   of_trap_signal       : "up" | "down" | ""
//   of_hold_continue     : 0..1     (continuation confidence)
//   of_cancel_signal     : 0..1     (cancel pending orders confidence)

const { EventEmitter } = require("events");
const WebSocket = require("ws");

const RECONNECT_BASE_MS    = 500;
const RECONNECT_MAX_MS     = 15_000;
const COALESCE_THROTTLE_MS = 50;
const SEMANTIC_TTL_MS      = 2_000;  // how long a semantic event stays "fresh"
const DECISION_TICK_MS     = 200;    // recompute decisions at most this often

class BookmapClient extends EventEmitter {
  constructor({ url, telemetry, keyVault } = {}) {
    super();
    this.url        = url || "ws://127.0.0.1:8081";
    this.telemetry  = telemetry;
    this.keyVault   = keyVault || null;
    this._ws        = null;
    this._connected = false;
    this._stopped   = false;
    this._backoff   = RECONNECT_BASE_MS;

    // Per-symbol pipeline. Each slot holds the latest of each frame
    // type and a small rolling buffer of recent semantic events.
    //   {
    //     dom:       <dom_pressure frame>,
    //     delta:     <delta_tape    frame>,
    //     liquidity: <liquidity     frame>,
    //     semantic:  Array<{ts,type,...payload}>  // capped & TTL-trimmed
    //     decision:  <derived of_* frame>,
    //     lastUpdateTs
    //   }
    this._perSymbol     = {};
    this._currentSymbol = "";
    this._lastSymbol    = "";
    this._events        = [];          // rolling renderer feed (raw + signals)
    this._counters      = { iceberg: 0, sweep: 0, absorption: 0,
                            exhaustion: 0, stop_run: 0 };
    this._lastEmitMs    = 0;
    this._coalesceTimer = null;
    this._lastDecisionMs = 0;
    // Per-symbol monotonic decision sequence — the EA uses this to
    // detect out-of-order or replayed PUB frames and to flag stale
    // cache when no new sequence arrives within OF_FRESH_TTL_SEC.
    this._seq           = {};          // {symbol: integer}
  }

  // ── Public accessors ─────────────────────────────────────────────
  events()             { return this._events.slice(); }
  symbols()            { return Object.keys(this._perSymbol); }
  snapshotFor(symbol)  { return this._perSymbol[symbol] || null; }
  decision(symbol) {
    const sym = symbol || this._currentSymbol || this._lastSymbol;
    return sym ? (this._perSymbol[sym]?.decision || null) : null;
  }

  // Flat snapshot consumed by renderer.js & ZMQ bridge.
  snapshot() {
    const sym  = this._currentSymbol || this._lastSymbol || "";
    const slot = sym ? this._perSymbol[sym] : null;
    const dom  = slot?.dom       || null;
    const dec  = slot?.decision  || null;

    // Build a flat MBO ladder from dom.bids/asks
    let mboLevels = [];
    if (dom && dom.dom) {
      const ts = dom.ts || Date.now();
      const bids = (dom.dom.bids || []).map((l) => ({ price: l.p, qty: l.q, side: "bid", ts }));
      const asks = (dom.dom.asks || []).map((l) => ({ price: l.p, qty: l.q, side: "ask", ts }));
      mboLevels = bids.concat(asks);
    }

    const decisions = {};
    const perSymbolSnapshots = {};
    for (const [s, slt] of Object.entries(this._perSymbol)) {
      if (slt.decision) decisions[s] = slt.decision;
      // Legacy renderer expects an aggregate frame per symbol with
      // a `.dom` sub-object holding the DOM ladder, plus convenience
      // top-level fields. We synthesise it from the 3 separate
      // snapshot frames coming from the sensor.
      if (slt.dom || slt.delta || slt.liquidity) {
        const d = slt.dom   || {};
        const t = slt.delta || {};
        const q = slt.liquidity || {};
        perSymbolSnapshots[s] = {
          type:         "snapshot",
          symbol:       s,
          ts:           slt.lastUpdateTs,
          // DOM ladder for the renderer
          top_bid:      d.top_bid,
          top_ask:      d.top_ask,
          dom:          d.dom || { bids: [], asks: [] },
          imbalance:    d.dom_imbalance,
          dom_pressure: d.dom_pressure || (
            (d.dom_imbalance || 0) >  0.25 ? "bid_heavy" :
            (d.dom_imbalance || 0) < -0.25 ? "ask_heavy" : "neutral"
          ),
          last_price:   t.last_price,
          delta:        t.delta_now,
          cvd:          t.cvd,
          // Pass-through of the 3 sensor frames for downstream debug
          dom_frame:    slt.dom,
          delta_frame:  slt.delta,
          liq_frame:    slt.liquidity,
          // Recent semantic events folded as legacy arrays for renderer
          absorption: slt.semantic.filter((e) => e.type === "absorption"),
          sweep_trap: slt.semantic.filter((e) => e.type === "sweep" || e.type === "stop_run"),
          iceberg:    slt.semantic.filter((e) => e.type === "iceberg"),
          exhaustion: (slt.semantic.find((e) => e.type === "exhaustion") || {}).side || "none",
        };
      }
    }

    return {
      connected:        this._connected,
      symbol:           sym,
      lastSymbol:       this._lastSymbol,
      bidImbalance:     dom ? Math.max(0,  (dom.dom_imbalance > 0 ?  dom.dom_imbalance : 0)) : 0,
      askImbalance:     dom ? Math.max(0,  (dom.dom_imbalance < 0 ? -dom.dom_imbalance : 0)) : 0,
      icebergCount:     this._counters.iceberg,
      stopRunCount:     this._counters.stop_run + this._counters.sweep,
      absorptionCount:  this._counters.absorption,
      exhaustionCount:  this._counters.exhaustion,
      mboLevels,
      events:           this._events.slice(0, 32),
      lastUpdateTs:     slot?.lastUpdateTs || 0,
      decision:         dec,
      decisions,
      perSymbolSnapshots,
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────
  start() { if (!this._stopped) this._connect(); }
  stop() {
    this._stopped = true;
    if (this._coalesceTimer) { clearTimeout(this._coalesceTimer); this._coalesceTimer = null; }
    if (this._ws) { try { this._ws.removeAllListeners(); this._ws.close(); } catch (_) {} }
    this._ws = null;
    this._connected = false;
  }
  _log(level, msg) { if (this.telemetry) this.telemetry.log(level, "Bookmap", msg); }

  _connect() {
    if (this._stopped) return;
    try {
      const apiKey = this.keyVault ? this.keyVault.get("bookmap") : null;
      const wsOpts = apiKey
        ? { headers: { "X-Bookmap-Key": apiKey, "Authorization": `Bearer ${apiKey}` } }
        : undefined;
      this._ws = new WebSocket(this.url, wsOpts);
    } catch (err) {
      this._scheduleReconnect(err.message);
      return;
    }
    this._ws.on("open", () => {
      this._connected = true;
      this._backoff = RECONNECT_BASE_MS;
      this._log("info", `connected ${this.url}`);
    });
    this._ws.on("message", (raw) => this._onMessage(raw));
    this._ws.on("error",   (err) => this._log("warn", `ws error: ${err.message || err}`));
    this._ws.on("close",   () => {
      this._connected = false;
      if (!this._stopped) this._scheduleReconnect("ws_closed");
    });
  }

  _scheduleReconnect(reason) {
    if (this._stopped) return;
    this._log("warn", `reconnect in ${this._backoff}ms (${reason})`);
    setTimeout(() => this._connect(), this._backoff);
    this._backoff = Math.min(this._backoff * 2, RECONNECT_MAX_MS);
  }

  _slot(sym) {
    if (!sym) return null;
    let s = this._perSymbol[sym];
    if (!s) {
      s = {
        dom: null, delta: null, liquidity: null,
        semantic: [], decision: null, lastUpdateTs: 0,
      };
      this._perSymbol[sym] = s;
    }
    return s;
  }

  _pushEvent(ev) {
    this._events.unshift(ev);
    if (this._events.length > 64) this._events.length = 64;
  }

  _pushSemantic(slot, ev) {
    const ts = ev.ts || Date.now();
    // TTL-trim
    slot.semantic = slot.semantic.filter((e) => ts - (e.ts || 0) < SEMANTIC_TTL_MS);
    slot.semantic.push(ev);
    if (slot.semantic.length > 32) slot.semantic = slot.semantic.slice(-32);
  }

  _onMessage(raw) {
    if (!raw) return;
    let str; try { str = raw.toString("utf8"); } catch (_) { return; }
    let parsed = null;
    try { parsed = [JSON.parse(str)]; }
    catch (_) {
      parsed = [];
      for (const line of str.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try { parsed.push(JSON.parse(t)); } catch (_) { /* skip */ }
      }
    }
    for (const msg of parsed) {
      if (!msg || typeof msg !== "object") continue;
      this._route(msg);
    }
    if (parsed.length) this._scheduleEmit();
  }

  _route(msg) {
    const type = String(msg.type || "").toLowerCase();
    const sym  = msg.symbol || msg.sym || msg.instrument || "";
    if (sym) this._lastSymbol = sym;

    switch (type) {
      case "hello":
        if (msg.current_symbol) this._currentSymbol = msg.current_symbol;
        if (Array.isArray(msg.tracked_symbols)) {
          for (const s of msg.tracked_symbols) this._slot(s);
        }
        return;

      case "heartbeat":
        if (sym) this._currentSymbol = sym;
        return;

      // Stream A — raw passthrough into the renderer feed
      case "depth":
      case "trade":
      case "mbo":
        this._onRaw(type, msg, sym);
        return;

      // Stream B — semantic events
      case "iceberg":
      case "stop_run":
      case "sweep":
      case "absorption":
      case "exhaustion":
        this._onSemantic(type, msg, sym);
        return;

      // Stream C — snapshots
      case "dom_pressure":
        if (sym) {
          const s = this._slot(sym); s.dom = msg; s.lastUpdateTs = msg.ts || Date.now();
          if (!this._currentSymbol) this._currentSymbol = sym;
        }
        return;
      case "delta_tape":
        if (sym) {
          const s = this._slot(sym); s.delta = msg; s.lastUpdateTs = msg.ts || Date.now();
        }
        return;
      case "liquidity":
        if (sym) {
          const s = this._slot(sym); s.liquidity = msg; s.lastUpdateTs = msg.ts || Date.now();
        }
        return;

      case "diagnostic":
        this.emit("diagnostic", msg);
        return;

      default:
        if (msg.text || msg.label) {
          this._pushEvent({ ts: msg.ts || Date.now(), type,
                            text: msg.text || msg.label });
        }
    }
  }

  // ── Stream A — raw passthrough ────────────────────────────────────
  _onRaw(type, msg, sym) {
    if (sym) this._currentSymbol = sym;
    this._pushEvent({
      ts:    msg.ts || Date.now(),
      type,
      sym,
      price: msg.price,
      qty:   msg.qty,
      side:  msg.side,
      action: msg.action,
      order_id: msg.order_id,
    });
  }

  // ── Stream B — semantic events ────────────────────────────────────
  _onSemantic(type, msg, sym) {
    if (!sym) return;
    const slot = this._slot(sym);
    const ev = { ...msg, ts: msg.ts || Date.now() };
    this._pushSemantic(slot, ev);
    this._counters[type] = (this._counters[type] || 0) + 1;
    // Also surface in the renderer rolling feed
    this._pushEvent({
      ts:    ev.ts,
      type,
      sym,
      side:  msg.side || msg.direction,
      price: msg.price,
      qty:   msg.absorbed_volume || msg.total_volume || msg.size,
      label: this._semanticLabel(type, msg),
    });
  }

  _semanticLabel(type, m) {
    switch (type) {
      case "iceberg":    return `ICEBERG ${(m.side || "").toUpperCase()}`;
      case "stop_run":   return `STOP-RUN ${(m.side || "").toUpperCase()}`;
      case "sweep":      return `SWEEP ${(m.direction || "").toUpperCase()}`;
      case "absorption": return `ABSORPTION ${(m.side || "").toUpperCase()}`;
      case "exhaustion": return `EXHAUSTION ${(m.side || "").toUpperCase()}`;
      default:           return type.toUpperCase();
    }
  }

  // ── EXE BRAIN — derive normalised of_* fields ─────────────────────
  _recomputeDecisions() {
    const now = Date.now();
    if (now - this._lastDecisionMs < DECISION_TICK_MS) return;
    this._lastDecisionMs = now;

    for (const [sym, slot] of Object.entries(this._perSymbol)) {
      if (!slot.dom && !slot.delta && !slot.liquidity) continue;

      // Trim stale semantic events
      slot.semantic = slot.semantic.filter((e) => now - (e.ts || 0) < SEMANTIC_TTL_MS);

      const dom    = slot.dom    || {};
      const delta  = slot.delta  || {};
      const liq    = slot.liquidity || {};

      // ── Aggregate raw → normalised metrics ─────────────────────
      const imb            = Number(dom.dom_imbalance) || 0;
      const domPressure    = (imb > 0.25)  ? "bid_heavy"
                           : (imb < -0.25) ? "ask_heavy"
                                           : "neutral";
      const deltaShift     = Number(delta.delta_shift)      || 0;
      const deltaDiverg    = Number(delta.delta_divergence) || 0;
      const tapeSpeed      = Number(delta.tape_speed)       || 0;
      const burstScore     = Number(delta.burst_score)      || 0;

      // Pull the strongest recent semantic of each kind
      const pickStrongest = (kind, key) => {
        let best = null;
        for (const e of slot.semantic) {
          if (e.type !== kind) continue;
          const v = Number(e[key]) || 0;
          if (!best || v > (Number(best[key]) || 0)) best = e;
        }
        return best;
      };
      const lastAbs  = pickStrongest("absorption", "strength");
      const lastExh  = pickStrongest("exhaustion", "exhaustion_score");
      const lastIce  = pickStrongest("iceberg",    "persistence_score");
      const lastSwp  = pickStrongest("sweep",      "speed");
      const lastStop = pickStrongest("stop_run",   "intensity");

      const ofAbsorption = lastAbs  ? Math.min(1, Number(lastAbs.strength)            || 0) : 0;
      const ofExhaustion = lastExh  ? Math.min(1, Number(lastExh.exhaustion_score)    || 0) : 0;
      const ofIceStr     = lastIce  ? Math.min(1, Number(lastIce.persistence_score)   || 0) : 0;
      const ofStopAct    = lastStop ? Math.min(1, Number(lastStop.intensity)          || 0) : 0;

      // ── Bias scoring — each contribution is tracked separately so we
      // can pick the STRONGEST signal (not just the last branch hit)
      // and compute a coherent "agreement" score that boosts the
      // confidence when multiple signals point the same way.
      const contribs = [];   // { side: "bull"|"bear", weight, signal }
      const push = (side, weight, signal) => {
        if (!isFinite(weight) || weight <= 0) return;
        contribs.push({ side, weight, signal });
      };
      if (domPressure === "bid_heavy") push("bull", 1.0 + Math.min(1.0,  imb * 2), "DOM_BID_HEAVY");
      if (domPressure === "ask_heavy") push("bear", 1.0 + Math.min(1.0, -imb * 2), "DOM_ASK_HEAVY");
      if (deltaShift > 0)              push("bull", Math.min(2.0,  deltaShift),    "DELTA_UP");
      if (deltaShift < 0)              push("bear", Math.min(2.0, -deltaShift),    "DELTA_DOWN");
      // price↑ but cvd↓ = bearish divergence (and vice-versa)
      if (deltaDiverg > 0)             push("bear", Math.min(1.5,  deltaDiverg * 2), "DIVERGENCE_BEAR");
      if (deltaDiverg < 0)             push("bull", Math.min(1.5, -deltaDiverg * 2), "DIVERGENCE_BULL");
      if (lastAbs) {
        if (lastAbs.side === "bid") push("bull", 1.5 * ofAbsorption, "ABSORPTION_BID");
        else                        push("bear", 1.5 * ofAbsorption, "ABSORPTION_ASK");
      }
      if (lastSwp) {
        if (lastSwp.direction === "up") push("bull", 1.0, "SWEEP_UP");
        else                            push("bear", 1.0, "SWEEP_DOWN");
      }
      if (lastIce) {
        if (lastIce.side === "bid") push("bull", 0.8 * ofIceStr, "ICEBERG_BID");
        else                        push("bear", 0.8 * ofIceStr, "ICEBERG_ASK");
      }
      if (lastExh) {
        // exhaustion of BUYERS → market is bearish (and vice-versa)
        if (lastExh.side === "buy") push("bear", 1.2 * ofExhaustion, "EXHAUSTION_BUY");
        else                        push("bull", 1.2 * ofExhaustion, "EXHAUSTION_SELL");
      }
      if (lastStop) {
        // stop-run = potential trap → contrarian bias of medium strength
        if (lastStop.side === "buy") push("bear", 0.8 * ofStopAct, "STOP_RUN_TRAP_UP");
        else                         push("bull", 0.8 * ofStopAct, "STOP_RUN_TRAP_DOWN");
      }

      let bull = 0, bear = 0;
      for (const c of contribs) { if (c.side === "bull") bull += c.weight; else bear += c.weight; }
      const total = bull + bear;

      let bias = "neutral", conf = 0, signal = "NONE";
      if (total > 0) {
        const winner   = bull >= bear ? "bull" : "bear";
        bias           = winner === "bull" ? "bullish" : "bearish";
        const winSum   = winner === "bull" ? bull : bear;
        const losSum   = winner === "bull" ? bear : bull;
        // Agreement ratio in [0..1] : 1.0 when ALL signals point same way.
        const agreement = winSum / total;
        // Saturation: more total weight + more agreement → more confidence.
        const saturation = Math.min(1.0, total / 4.0);
        conf = Math.round(100 * agreement * (0.5 + 0.5 * saturation));
        // Pick the STRONGEST contributing signal on the winning side
        // (not the last-evaluated branch as before).
        const winCands = contribs.filter((c) => c.side === winner)
                                 .sort((a, b) => b.weight - a.weight);
        if (winCands.length) signal = winCands[0].signal;
        // Penalise confidence if the strongest signal has very low weight
        // (rare-event noise) — keeps the EA out of trades on weak setups.
        if (winCands[0] && winCands[0].weight < 0.4) conf = Math.round(conf * 0.6);
        // Strong contrarian semantic on the LOSING side → cap confidence
        const losCands = contribs.filter((c) => c.side !== winner);
        if (losCands.length) {
          const losMax = losCands.reduce((m, c) => c.weight > m ? c.weight : m, 0);
          if (losMax > winCands[0].weight * 0.75) conf = Math.round(conf * 0.75);
        }
      }
      conf = Math.max(0, Math.min(100, conf));

      // ── Hold-vs-cancel meta-signals for the EA ─────────────────
      // Continuation if delta confirms direction & dom pressure agrees,
      // tape is active, no exhaustion. Cancel if exhaustion / sweep
      // / large pulling on the side we'd enter on.
      const pullingScore  = Number(dom.pulling_score)  || 0;
      const stackingScore = Number(dom.stacking_score) || 0;
      const spoofRisk     = Number(liq.spoof_risk_score) || 0;

      let holdContinue = 0;
      if (bias !== "neutral") {
        holdContinue = Math.min(1, (conf / 100) * 0.6
                                + Math.min(1, tapeSpeed / 5) * 0.2
                                + stackingScore * 0.2);
        if (ofExhaustion > 0.5) holdContinue *= 0.4;
      }
      let cancelSignal = Math.min(1,
        ofExhaustion * 0.45 + spoofRisk * 0.25 + pullingScore * 0.30);

      // Per-symbol monotonic sequence — bumped on every recompute
      // so the MQ4 side can detect dropped / out-of-order frames.
      this._seq[sym] = (this._seq[sym] || 0) + 1;
      const decision = {
        type:                "decision",
        symbol:              sym,
        ts:                  now,
        sequence:            this._seq[sym],
        last_update_ts:      now,
        fresh:               true,
        of_bias:             bias,
        of_confidence:       conf,
        of_signal:           signal,
        of_imbalance:        Math.round(imb * 1000) / 1000,
        of_dom_pressure:     domPressure,
        of_delta_shift:      Math.round(deltaShift   * 1000) / 1000,
        of_delta_norm:       Math.max(-1, Math.min(1, Math.round(deltaShift / 2 * 1000) / 1000)),
        of_delta_divergence: Math.round(deltaDiverg  * 1000) / 1000,
        of_absorption:       Math.round(ofAbsorption * 1000) / 1000,
        of_exhaustion:       Math.round(ofExhaustion * 1000) / 1000,
        of_iceberg_side:     lastIce  ? (lastIce.side || "") : "",
        of_iceberg_strength: Math.round(ofIceStr  * 1000) / 1000,
        of_iceberg_pressure: Math.round(ofIceStr  * 1000) / 1000,
        of_stop_activity:    Math.round(ofStopAct * 1000) / 1000,
        of_sweep_signal:     lastSwp  ? (lastSwp.direction || "") : "",
        of_sweep_score:      Math.round((lastSwp ? Math.min(1, Number(lastSwp.speed) || 0.6) : 0) * 1000) / 1000,
        of_trap_signal:      lastStop ? (lastStop.side === "buy" ? "down" : "up") : "",
        of_hold_continue:    Math.round(holdContinue * 1000) / 1000,
        of_cancel_signal:    Math.round(cancelSignal * 1000) / 1000,
        of_agreement:        total > 0 ? Math.round(100 * Math.max(bull, bear) / total) / 100 : 0,
        of_contribs:         contribs.length,
        // burst & tape passthroughs for the renderer chips
        burst_score:         Math.round(burstScore * 1000) / 1000,
        tape_speed:          Math.round(tapeSpeed  * 1000) / 1000,
      };
      slot.decision = decision;
      this.emit("decision", { symbol: sym, decision });
    }
  }

  // Coalesce a burst of frames into ONE "snapshot" emit so the renderer
  // and ZMQ bridge see at most 20 snapshot events / second.
  _scheduleEmit() {
    if (this._coalesceTimer) return;
    const now = Date.now();
    const delay = Math.max(0, COALESCE_THROTTLE_MS - (now - this._lastEmitMs));
    this._coalesceTimer = setTimeout(() => {
      this._coalesceTimer = null;
      this._lastEmitMs = Date.now();
      this._recomputeDecisions();
      this.emit("snapshot", this.snapshot());
    }, delay);
  }
}

module.exports = BookmapClient;
