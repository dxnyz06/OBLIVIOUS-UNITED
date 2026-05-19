// OBLIVIOUS HUB — DecisionEngine (BRAIN)
// ----------------------------------------------------------------
// Aggregates news / bookmap / provider state and:
//   1. forwards trade commands to the EA over ZMQ (PUB on
//      `oblivious.command`) when the operator OR an AI policy
//      explicitly issues one.
//   2. answers synchronous `ai_query` REQ/REP roundtrips coming
//      from the EA: builds a unified decision frame by fusing
//        - the EA's strategy/engine context (REQ payload)
//        - the latest per-symbol bookmap orderflow decision
//        - the live news state
//        - optionally the ProviderRouter (AI providers)
//      and returns:
//        { final_bias, ai_confidence, hold_continue, cancel_signal,
//          news_block_state, tp1..tp3, tpmax, invalidate_if,
//          of_context: { ... 16 of_* fields ... } }
//
// Role separation enforced here:
//   • Bookmap = sensor only.
//   • Hub     = brain (this file is the only place that produces
//                ai_query responses).
//   • EA      = executor (owns risk, lot, TP/SL placement,
//                spread/news/license/schedule hard gates).
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
    this._lastBookmap    = null;
    this._trace          = []; // last 50 decisions
    this._aiqStats       = { count: 0, lastTs: 0, lastSymbol: "", lastBias: "neutral" };
  }

  setPublishCommand(fn) {
    if (typeof fn === "function") this._publishCommand = fn;
  }

  onBookmap(snap) {
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

  // ─────────────────────────────────────────────────────────────
  // AI-QUERY: synchronous decision builder.
  //
  // Input  (eaCtx) — plain object as parsed from the EA's REQ:
  //   { op:"ai_query", symbol, timeframe, strategy_name, tpsl_mode,
  //     mode, direction_context, price:{bid,ask,spread_points},
  //     account:{balance,equity},
  //     engines:{ pattern_consensus, indicator_consensus,
  //               filter_confidence, hybrid_confidence },
  //     setup:{ fvg_valid, bos_detected, mss_detected,
  //             retracement_quality, entry_zone_score },
  //     trade_state:{ has_open_trade, has_pending },
  //     risk_state:{ max_risk_trade_percent, manual_lot },
  //     news_state:{ high_impact_block, cooldown_state } }
  //
  // Output — the "EA contract" frame the spec asks for.
  // ─────────────────────────────────────────────────────────────
  async buildAiResponse(eaCtx) {
    const sym  = String(eaCtx?.symbol || "").trim();
    if (!sym) return { ok: false, reason: "missing_symbol" };

    const requestId  = String(eaCtx?.request_id || "");
    const strategy   = String(eaCtx?.strategy_name || "");
    const tpslMode   = String(eaCtx?.tpsl_mode || "Native");

    // 1) Bookmap orderflow decision for this symbol — SOURCE OF
    //    TRUTH. The EA's `orderflow_hint` is just a hint and is
    //    only consulted when the hub's own cache is missing
    //    (e.g. just-booted, no Bookmap frame received yet).
    let ofDec = (this.bookmap && typeof this.bookmap.decision === "function")
      ? (this.bookmap.decision(sym) || null)
      : null;
    let bookmapFrom = ofDec ? "hub_cache" : "none";
    if (!ofDec && eaCtx?.orderflow_hint &&
        Number(eaCtx.orderflow_hint.fresh) === 1) {
      // Promote the EA-provided hint to a synthetic decision so we
      // don't return an empty of_context just because the hub
      // hasn't yet received its first frame from the Java sensor.
      ofDec = { ...eaCtx.orderflow_hint };
      bookmapFrom = "ea_hint";
    }
    const ofTs   = Number(ofDec?.last_update_ts) || Number(ofDec?.ts) ||
                   Number(ofDec?.timestamp)      || 0;
    const ofSeq  = Number(ofDec?.sequence) || 0;
    const ofAge  = ofTs > 0 ? Math.max(0, Date.now() - ofTs) : -1;
    const ofFresh = (ofTs > 0 && ofAge >= 0 && ofAge < 5000);

    // 2) News snapshot (block state + next event impact).
    const newsSnap = this.newsEngine ? this.newsEngine.snapshot() : null;
    const newsBlock = !!(eaCtx?.news_state?.high_impact_block || newsSnap?.blockTrading);
    const newsImpact = Number(newsSnap?.currentImpact ?? eaCtx?.news_state?.impact ?? 0);
    const newsBlockState = newsBlock ? "high_impact_block"
                          : (newsImpact >= 2 ? "soft" : "none");

    // 3) Engine consensus from EA context (already in 0..1).
    const eng = eaCtx?.engines || {};
    const engHybrid    = clamp01(eng.hybrid_confidence,    0);
    const engPattern   = clamp01(eng.pattern_consensus,    0);
    const engIndicator = clamp01(eng.indicator_consensus,  0);
    const engFilter    = clamp01(eng.filter_confidence,    0);

    // 4) Strategy-aware bias fusion. Each strategy uses different
    //    weights because their natural edge is different:
    //    • SMC / ICT lean on hybrid + orderflow (structural)
    //    • FVG / Reverse lean on orderflow (delta + absorption)
    //    • Breakout leans on hybrid + filter (momentum + regime)
    //    • Grid is range-only, so orderflow weight is small
    //    • Predicted is news/AI-driven; we still answer for it but
    //      with an orderflow-light profile.
    const W = strategyBiasWeights(strategy);
    const ofBiasNum    = ofBiasToNumber(ofDec?.of_bias);
    const ofConfNum    = clamp01((ofDec?.of_confidence || 0) /
                                 ((ofDec?.of_confidence || 0) > 1 ? 100 : 1), 0);
    const eaDirCtx     = clampSigned(Number(eaCtx?.direction_context || 0));

    const votes = [];
    if (ofConfNum > 0)    votes.push({ v: ofBiasNum,             w: W.orderflow * ofConfNum });
    if (engHybrid > 0)    votes.push({ v: eaDirCtx || ofBiasNum, w: W.hybrid    * engHybrid });
    if (engPattern > 0)   votes.push({ v: eaDirCtx,              w: W.pattern   * engPattern });
    if (engIndicator > 0) votes.push({ v: eaDirCtx,              w: W.indicator * engIndicator });
    if (engFilter > 0)    votes.push({ v: eaDirCtx,              w: W.filter    * engFilter });
    let finalBias = 0, weightSum = 0;
    for (const v of votes) { finalBias += v.v * v.w; weightSum += v.w; }
    if (weightSum > 0) finalBias = finalBias / weightSum;
    finalBias = clampSigned(finalBias);

    // 5) 4-component confidence: setup quality + orderflow conf
    //    + news clarity + execution/risk health. Each component
    //    in [0..1]; final = weighted blend per strategy.
    const setup = eaCtx?.setup || {};
    const setupQuality = clamp01(
      0.30 * boolToNum(setup.bos_detected) +
      0.20 * boolToNum(setup.mss_detected) +
      0.20 * (Number(setup.retracement_quality) || 0) +
      0.15 * (Number(setup.entry_zone_score)    || 0) +
      0.15 * (Number(setup.liquidity_target_score) || 0)
    , 0);
    const newsClarity = newsBlock ? 0.0 : (newsImpact >= 2 ? 0.5 : 1.0);
    // Execution health: low spread, free margin healthy, no high
    // execution_danger from orderflow.
    const market = eaCtx?.market || eaCtx?.price || {};
    const acct   = eaCtx?.account || {};
    const spreadHealth = clamp01(1.0 - (Number(market.spread_points) || 0) / 50, 0);
    const marginHealth = clamp01((Number(acct.margin_free) || Number(acct.equity) || 1)
                                 / Math.max(1, Number(acct.equity) || 1), 0);
    const execDanger   = clamp01(Number(ofDec?.of_execution_danger) || 0, 0);
    const execHealth   = clamp01((spreadHealth * 0.45 +
                                 marginHealth * 0.30 +
                                 (1 - execDanger) * 0.25), 0);

    const C = strategyConfWeights(strategy);
    let aiConf = C.setup    * setupQuality
               + C.orderflow * ofConfNum
               + C.news     * newsClarity
               + C.exec     * execHealth;
    if (newsBlock)                  aiConf *= 0.4;
    if (Math.abs(finalBias) < 0.15) aiConf *= 0.7;
    aiConf = clamp01(aiConf, 0);

    // 6) Hold / cancel hints — start from bookmap's derived
    //    `of_hold_continue` / `of_cancel_signal`, dampen with
    //    setup quality, escalate cancel on news block.
    let holdContinue = clamp01(Number(ofDec?.of_hold_continue), 0);
    let cancelSignal = clamp01(Number(ofDec?.of_cancel_signal), 0);
    if (setupQuality < 0.4) holdContinue *= 0.6;
    if (newsBlock)          cancelSignal = Math.max(cancelSignal, 0.7);

    // 7) TP ladder — Electron does NOT place orders; it can only
    //    suggest. By default we send 0s (EA's TPSLEngine takes
    //    over). When a provider explicitly yields target prices,
    //    inject them here. Predicted-mode AI delegations will
    //    fill these via a future ProviderRouter hook.
    const tp1 = 0.0, tp2 = 0.0, tp3 = 0.0, tpMax = 0.0;

    // 8) Invalidation hint — strongest negative signal we have.
    let invalidateIf = "none";
    if (cancelSignal > 0.6) invalidateIf = "delta_divergence_worsens_and_absorption_fails";
    else if (newsBlock)     invalidateIf = "high_impact_news_within_window";
    else if (Number(ofDec?.of_exhaustion) > 0.6) invalidateIf = "exhaustion_pattern_persists";

    // 9) Predicted-specific: setup_valid is True when the EA
    //    flagged a fresh news-driven impulse AND we have a clean
    //    orderflow context. Used by the EA to gate Predicted
    //    pending-limit placement.
    const predictedValid = strategy === "Predicted"
      ? !newsBlock && setupQuality >= 0.4 && execHealth >= 0.5
      : false;

    // 10) Provider used label (purely informational).
    const providerUsed = (ofDec
      ? `bookmap[${bookmapFrom}]+local`
      : "local")
      + (this.providerRouter ? "+ai_avail" : "");

    // 11) Build the response.
    const response = {
      ok:                     true,
      op:                     "ai_response",
      request_id:             requestId,
      symbol:                 sym,
      strategy_name:          strategy,
      tpsl_mode:              tpslMode,
      provider_used:          providerUsed,
      news_block_state:       newsBlockState,
      news_impact:            newsImpact,
      bookmap_fresh:          ofFresh ? 1 : 0,
      bookmap_stale:          ofFresh ? 0 : 1,
      bookmap_sequence:       ofSeq,
      bookmap_age_ms:         ofAge,
      orderflow_bias:         round3(ofBiasNum),
      orderflow_confidence:   round3(ofConfNum),
      final_bias:             round3(finalBias),
      ai_confidence:          round3(aiConf),
      hold_continue:          round3(holdContinue),
      cancel_signal:          round3(cancelSignal),
      predicted_setup_valid:  predictedValid ? 1 : 0,
      tp1, tp2, tp3, tpmax:   tpMax,
      invalidate_if:          invalidateIf,
      of_context: ofDec ? {
        of_bias:             ofBiasToNumber(ofDec.of_bias),
        of_confidence:       round3((ofDec.of_confidence || 0) / 100),
        of_signal:           ofDec.of_signal || "NONE",
        of_imbalance:        round3(ofDec.of_imbalance),
        of_dom_pressure:     round3(domPressureToNumber(ofDec.of_dom_pressure)),
        of_delta_shift:      round3(ofDec.of_delta_shift),
        of_delta_divergence: round3(ofDec.of_delta_divergence),
        of_absorption:       round3(ofDec.of_absorption),
        of_exhaustion:       round3(ofDec.of_exhaustion),
        of_iceberg_side:     icebergSideToNumber(ofDec.of_iceberg_side),
        of_iceberg_strength: round3(ofDec.of_iceberg_strength),
        of_stop_activity:    round3(ofDec.of_stop_activity),
        of_sweep_signal:     sweepSignalToNumber(ofDec.of_sweep_signal),
        of_trap_signal:      sweepSignalToNumber(ofDec.of_trap_signal),
        of_hold_continue:    round3(ofDec.of_hold_continue),
        of_cancel_signal:    round3(ofDec.of_cancel_signal),
        of_execution_danger: round3(Math.min(1,
          (Number(ofDec.of_exhaustion)  || 0) * 0.45 +
          (Number(ofDec.of_cancel_signal) || 0) * 0.55)),
        // Freshness markers — used by the MQ4 side to gate the
        // SOFT helpers (OF_IsFresh, OF_RefineBias, ...).
        sequence:            Number(ofDec.sequence)        || 0,
        last_update_ts:      Number(ofDec.last_update_ts)  || Number(ofDec.ts) || 0,
        fresh:               (Number(ofDec.last_update_ts || ofDec.ts || 0) > Date.now() - 5000),
      } : null,
      ts: Date.now(),
    };

    // 11) Telemetry: trace last 50, plus log line every reply.
    this._aiqStats.count++;
    this._aiqStats.lastTs     = Date.now();
    this._aiqStats.lastSymbol = sym;
    this._aiqStats.lastBias   = response.final_bias > 0.1 ? "BULL"
                              : response.final_bias < -0.1 ? "BEAR" : "NEUT";
    this._trace.push({
      t:      Date.now(),
      op:     "ai_query",
      sym,
      bias:   this._aiqStats.lastBias,
      conf:   response.ai_confidence,
      strat:  response.strategy_name,
    });
    if (this._trace.length > 50) this._trace.shift();
    this.telemetry.log("info", "Decision",
      `ai_query ${sym} ${eaCtx.strategy_name || "?"} → bias=${response.final_bias} ` +
      `conf=${response.ai_confidence} hold=${response.hold_continue} cancel=${response.cancel_signal}`);

    return response;
  }

  snapshot() {
    return {
      lastContext: this._lastCtx,
      trace:       this._trace.slice(-20),
      news:        this.newsEngine ? this.newsEngine.snapshot() : null,
      aiq:         { ...this._aiqStats },
    };
  }
}

// ── helpers ────────────────────────────────────────────────────
function clamp01(x, def = 0)   { x = Number(x); return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : def; }
function clampSigned(x)        { x = Number(x); if (!Number.isFinite(x)) return 0; return Math.max(-1, Math.min(1, x)); }
function round3(x)             { x = Number(x); return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : 0; }
function boolToNum(b)          { return b ? 1 : 0; }
function ofBiasToNumber(s) {
  if (typeof s === "number") return clampSigned(s);
  s = String(s || "").toLowerCase();
  if (s === "bullish" || s === "bull" || s === "up")   return 1;
  if (s === "bearish" || s === "bear" || s === "down") return -1;
  return 0;
}
function domPressureToNumber(s) {
  s = String(s || "").toLowerCase();
  if (s === "bid_heavy") return 1;
  if (s === "ask_heavy") return -1;
  return 0;
}
function icebergSideToNumber(s) {
  s = String(s || "").toLowerCase();
  if (s === "bid" || s === "buy")  return 1;
  if (s === "ask" || s === "sell") return -1;
  return 0;
}
function sweepSignalToNumber(s) {
  s = String(s || "").toLowerCase();
  if (s === "up")   return 1;
  if (s === "down") return -1;
  return 0;
}

// Strategy-aware bias-fusion weights. Each strategy's natural edge
// is different, so we don't apply uniform weights:
//   • SMC / ICT lean on hybrid + orderflow (structural edge)
//   • FVG / Reverse rely most on orderflow (delta + absorption)
//   • Breakout = hybrid + filter (regime + momentum)
//   • Grid is range-only; orderflow weight is small and pattern
//     barely contributes (ranges are statistically defined)
//   • Predicted is news/AI-driven; orderflow only as confirmation
function strategyBiasWeights(strat) {
  switch (String(strat)) {
    case "SMC":      return { orderflow: 0.40, hybrid: 0.30, pattern: 0.10, indicator: 0.10, filter: 0.10 };
    case "ICT":      return { orderflow: 0.40, hybrid: 0.30, pattern: 0.10, indicator: 0.10, filter: 0.10 };
    case "FVG":      return { orderflow: 0.50, hybrid: 0.20, pattern: 0.10, indicator: 0.10, filter: 0.10 };
    case "Reverse":  return { orderflow: 0.45, hybrid: 0.20, pattern: 0.15, indicator: 0.10, filter: 0.10 };
    case "Breakout": return { orderflow: 0.30, hybrid: 0.30, pattern: 0.10, indicator: 0.10, filter: 0.20 };
    case "Grid":     return { orderflow: 0.20, hybrid: 0.10, pattern: 0.10, indicator: 0.30, filter: 0.30 };
    case "Predicted":return { orderflow: 0.25, hybrid: 0.25, pattern: 0.10, indicator: 0.10, filter: 0.30 };
    default:         return { orderflow: 0.45, hybrid: 0.25, pattern: 0.15, indicator: 0.10, filter: 0.05 };
  }
}

// Strategy-aware confidence component weights (4 sums to 1.0).
// setup = local structural quality (BOS/MSS/retracement/...);
// orderflow = bookmap of_confidence;
// news = news clarity (1.0 = quiet, 0.0 = high-impact block);
// exec = execution health (spread + margin + execution_danger).
function strategyConfWeights(strat) {
  switch (String(strat)) {
    case "SMC":      return { setup: 0.40, orderflow: 0.30, news: 0.15, exec: 0.15 };
    case "ICT":      return { setup: 0.40, orderflow: 0.30, news: 0.15, exec: 0.15 };
    case "FVG":      return { setup: 0.35, orderflow: 0.35, news: 0.15, exec: 0.15 };
    case "Reverse":  return { setup: 0.30, orderflow: 0.40, news: 0.10, exec: 0.20 };
    case "Breakout": return { setup: 0.35, orderflow: 0.25, news: 0.20, exec: 0.20 };
    case "Grid":     return { setup: 0.25, orderflow: 0.20, news: 0.20, exec: 0.35 };
    case "Predicted":return { setup: 0.20, orderflow: 0.20, news: 0.40, exec: 0.20 };
    default:         return { setup: 0.35, orderflow: 0.30, news: 0.20, exec: 0.15 };
  }
}

module.exports = DecisionEngine;
