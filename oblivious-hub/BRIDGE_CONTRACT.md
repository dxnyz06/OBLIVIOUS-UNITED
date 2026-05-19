# OBLIVIOUS — JSON Contracts & Transport Spec

**Version:** 1.0 · final · spec-locked
**Scope:** definitive contract for the three live channels of the
`Bookmap → Electron → MQ4/EX4` pipeline.

---

## 1. Architecture in one picture

```
[Bookmap plugin Java]                         sensor only
   ws://127.0.0.1:8081  (one-way push)
                ▼
[Electron BookmapClient]                      normalise + sequence
   PUB tcp://127.0.0.1:5556  topic=oblivious.bookmap
                ▼
[MQ4 EA · AI_HandleBookmap]                   g_of_*  (live cache)

[MQ4 EA]  REQ tcp://127.0.0.1:5555  →  [Electron DecisionEngine]
                         ai_query  →
                                       ←  ai_response
                ▼
[MQ4 EA · g_aiq_*]                            official decision
                ▼
[6 owner strategies] · SOFT helpers           OF_RefineBias / Confidence
                                              OF_ShouldDiscourage

[Electron operator/UI]
   PUB tcp://127.0.0.1:5556  topic=oblivious.command
                ▼
[MQ4 EA · AI_HandleCommand]
   Hard gates → Risk_Preflight → Ownership_Add → Order
```

**Mother rule.**
- Bookmap = sensor (only)
- Electron = brain (decides bias/confidence/hold/cancel/tpsl/invalidation)
- MQ4 = executor + final hard gates + ownership + risk

---

## 2. Transports — exact ports & topics

| Direction              | Tech       | Endpoint                       | Pattern  | Topic / op     |
|------------------------|-----------:|--------------------------------|----------|----------------|
| Bookmap → Electron     | WebSocket  | `ws://127.0.0.1:8081`          | one-way  | (raw frames)   |
| Electron → MQ4 (live)  | ZeroMQ     | `tcp://127.0.0.1:5556`         | PUB/SUB  | `oblivious.bookmap` |
| Electron → MQ4 (cmd)   | ZeroMQ     | `tcp://127.0.0.1:5556`         | PUB/SUB  | `oblivious.command` |
| Electron → MQ4 (news)  | ZeroMQ     | `tcp://127.0.0.1:5556`         | PUB/SUB  | `oblivious.news`    |
| MQ4 ↔ Electron (sync)  | ZeroMQ     | `tcp://127.0.0.1:5555`         | REQ/REP  | `op:"ai_query"`     |
| MQ4 → Electron (push)  | ZeroMQ     | `tcp://127.0.0.1:5557`         | PUSH/PULL| `op:"context_push"` |

There is **no** secondary bridge, **no** named pipes, **no** `.txt` transport,
and **no** business-DLL between Electron and the EA.

---

## 3. DLLs / libraries

### MQ4 / EX4 side (MetaTrader 4 terminal)
- `MQL4/Include/Zmq/...`            — header bindings (Zmq.mqh and friends)
- `MQL4/Libraries/libzmq.dll`       — ZeroMQ runtime (REQ/SUB/PUSH sockets)
- `MQL4/Libraries/libsodium.dll`    — *only if* the libzmq build was linked
                                      against `--with-libsodium`. Otherwise omit.

> The EA does **not** load any custom business-DLL. ZeroMQ alone is enough.
> The legacy `BridgeConnect / Bridge_PollAIData` named-pipe path was kept as
> a no-op shim for back-compat compilation only — it never opens a pipe.

### Electron / Node.js side
- `zeromq`        — Node binding to `libzmq` (auto-installed via `npm i`).
- `electron`      — main process & renderer.
- (no other transport-related deps)

### Bookmap plugin (Java)
- Bookmap SDK / L1 API (provided by the host)
- `Java-WebSocket`                — server on 127.0.0.1:8081
- `gson`                          — JSON encode

---

## 4. Bookmap → Electron — `ws://127.0.0.1:8081`

Every frame is a JSON object. Common envelope:

```json
{
  "source":   "bookmap",
  "type":     "event|snapshot|normalized|heartbeat",
  "symbol":   "XAUUSD",
  "timestamp":1710000000000,
  "sequence": 152344,
  "session":  "london",
  "payload":  { /* see below */ }
}
```

### 4.1 Immediate events (`type: "event"`)
| `payload.event`  | Required keys |
|------------------|---------------|
| `iceberg`        | `side, price, executed_size, hidden_estimated_size, visible_reloads, persistence_score` |
| `stop_run`       | `side, price_start, price_end, cluster_size, intensity, speed` |
| `sweep`          | `direction, start_price, end_price, levels_swept, total_volume, speed, reclaimed` |
| `absorption`     | `side, price, absorbed_volume, aggressor_volume, repetitions, strength, iceberg_related` |
| `exhaustion`     | `side, price, exhaustion_score, delta_context, tape_slowdown, follow_through_failure` |
| `trap`           | `trap_side, trap_score, trigger_price, reclaim_price` |

### 4.2 Periodic snapshots (`type: "snapshot"`)
- `payload.mbo`        — order-flow book counters (new/mod/cancel/exec)
- `payload.dom`        — DOM pressure & passive walls
- `payload.flow`       — aggressor flow / delta / tape speed
- `payload.liquidity`  — add/remove totals + magnet level + spoof risk

### 4.3 Normalized state (`type: "normalized"`)
Optional shortcut for sensors that already reduce to the 11 `of_*` numerics:
`of_absorption`, `of_exhaustion`, `of_iceberg_side`, `of_iceberg_strength`,
`of_stop_activity`, `of_sweep_signal`, `of_trap_signal`, `of_dom_pressure`,
`of_imbalance`, `of_delta_shift`, `of_delta_divergence`.

> The Electron `BookmapClient` always re-derives the **16-field** orderflow
> state on its side. The sensor's `normalized` payload is treated as a hint.

---

## 5. Electron → MQ4 — `oblivious.bookmap` live-context envelope

PUB topic on `tcp://127.0.0.1:5556`. **Exact** payload shape:

```json
{
  "topic":      "oblivious.bookmap",
  "symbol":     "XAUUSD",
  "timestamp":  1710000000600,
  "sequence":   152353,
  "fresh":      true,
  "stale":      false,
  "age_ms":     46,
  "of_context": {
    "of_bias":             0.41,
    "of_confidence":       0.72,
    "of_absorption":       0.79,
    "of_exhaustion":       0.18,
    "of_delta_shift":      0.63,
    "of_delta_divergence": 0.22,
    "of_imbalance":        0.27,
    "of_dom_pressure":     0.31,
    "of_iceberg_side":    -1,
    "of_iceberg_strength": 0.81,
    "of_stop_activity":    0.34,
    "of_sweep_signal":     0.12,
    "of_trap_signal":      0.09,
    "of_hold_continue":    0.66,
    "of_cancel_signal":    0.14,
    "of_execution_danger": 0.21
  }
}
```

- Numbers are JSON numbers (NOT strings). Hub-side normalisation collapses
  `"bullish" / "bid_heavy"`-style enums to `±1 / 0`.
- `sequence` is monotonic per `(symbol)`. The EA drops out-of-order frames.
- `fresh = true` ⇔ `age_ms < 5000`. The EA's `OF_IsFresh()` re-checks both.

---

## 6. MQ4 → Electron — `ai_query` (REQ/REP on 5555)

```json
{
  "op":            "ai_query",
  "request_id":    "req_XAU_5_1710000001_42",
  "symbol":        "XAUUSD",
  "timeframe":     5,
  "strategy_name": "Breakout",
  "setup_id":      "Bre_XAU_5_continuation",
  "setup_class":   "continuation",
  "entry_intent":  "main_entry",
  "tpsl_mode":     "AI",
  "mode":          "Moderate",
  "direction_context": 1,
  "market":  { "bid": 2365.10, "ask": 2365.24, "spread_points": 14 },
  "account": { "balance": 10000.0, "equity": 10042.0, "margin_free": 8740.0 },
  "engines": {
    "pattern_consensus":    0.31,
    "indicator_consensus":  0.22,
    "filter_confidence":    0.74,
    "hybrid_confidence":    0.68
  },
  "setup": {
    "fvg_valid":              true,
    "bos_detected":           true,
    "mss_detected":           false,
    "retracement_quality":    0.61,
    "entry_zone_score":       0.72,
    "liquidity_target_score": 0.58,
    "freshness_score":        0.81,
    "hybrid_model_id":        2,
    "hybrid_model_class":     2,
    "hybrid_model_name":      "Liquidity_Breaker_FVG",
    "hybrid_quality":         0.71,
    "hybrid_penalty":         0.12
  },
  "trade_state": {
    "has_open_trade": false, "has_pending": true, "is_addon": false,
    "open_count":     0,     "pending_count": 1
  },
  "risk_state": {
    "manual_lot": 0.10, "max_risk_trade_percent": 1.0, "max_risk_for_symbol": 2.0
  },
  "news_state": {
    "high_impact_block": false, "impact": 0, "cooldown_state": "none"
  },
  "orderflow_hint": {
    "fresh": true, "sequence": 152353, "timestamp": 1710000000600,
    "age_sec": 0,
    "of_bias": 0.41, "of_confidence": 0.72, "of_absorption": 0.79,
    "of_exhaustion": 0.18, "of_delta_shift": 0.63, "of_delta_divergence": 0.22,
    "of_imbalance": 0.27, "of_dom_pressure": 0.31,
    "of_iceberg_side": -1, "of_iceberg_strength": 0.81,
    "of_stop_activity": 0.34, "of_sweep_signal": 0.12, "of_trap_signal": 0.09,
    "of_hold_continue": 0.66, "of_cancel_signal": 0.14, "of_execution_danger": 0.21
  },
  "ts": 1710000001
}
```

- `request_id` MUST be unique per query; the hub echoes it back. Mismatched
  echoes are dropped on the EA side.
- `orderflow_hint` is just a hint; Electron's source-of-truth is its own
  `BookmapClient.decision(symbol)` cache.

---

## 7. Electron → MQ4 — `ai_response` (REP on 5555)

```json
{
  "op":                    "ai_response",
  "request_id":            "req_XAU_5_1710000001_42",
  "symbol":                "XAUUSD",
  "strategy_name":         "Breakout",
  "tpsl_mode":             "AI",
  "provider_used":         "bookmap[hub_cache]+local",
  "news_block_state":      "none",
  "news_impact":           0,
  "bookmap_fresh":         1,
  "bookmap_stale":         0,
  "bookmap_sequence":      152353,
  "bookmap_age_ms":        46,
  "orderflow_bias":        0.41,
  "orderflow_confidence":  0.72,
  "final_bias":            0.36,
  "ai_confidence":         0.71,
  "hold_continue":         0.66,
  "cancel_signal":         0.14,
  "predicted_setup_valid": 0,
  "tp1": 0.0, "tp2": 0.0, "tp3": 0.0, "tpmax": 0.0,
  "invalidate_if": "none",
  "of_context": { /* same 16 fields as in §5 */ }
}
```

- Booleans are encoded as `0/1` so the EA's `Msg_GetInt(...) != 0` reads
  correctly under both JSON and legacy parsers.
- `tp1..tpmax = 0` means: EA's local TPSL engine owns placement. The hub
  only injects non-zero values when an AI provider returns explicit prices.
- `predicted_setup_valid` is meaningful only when `strategy_name = "Predicted"`.

---

## 8. Electron → MQ4 — `oblivious.command` envelope

PUB on `tcp://127.0.0.1:5556`. The EA's `AI_HandleCommand` enforces:
- `command_id` dedup (64-slot ring)
- `expiry_ts` honor (drop stale)
- wrong-symbol drop (multi-chart safety)
- `decision` verb routing (legacy `op` is also accepted)

```json
{
  "topic":          "oblivious.command",
  "command_id":     "cmd_001928",
  "correlation_id": "req_XAU_5_1710000001_42",
  "symbol":         "XAUUSD",
  "strategy_name":  "Predicted",
  "decision":       "EXECUTE_ORDER",
  "expiry_ts":      1710000002500,
  "payload": {
    "direction":     1,
    "lot":           0.10,
    "entry_type":    "limit",
    "entry_price":   2364.80,
    "sl":            2363.90,
    "tp1":           2365.60,
    "tp2":           2366.20,
    "tp3":           2366.90,
    "tpmax":         2367.40,
    "oco_peer":      "pending_sell_limit_001",
    "invalidate_if": "news_impulse_exhausted"
  }
}
```

Verbs accepted in `decision`:
- `EXECUTE_ORDER` — opens (or pendings) an order. Payload as above.
- `HOLD`         — keep current intent; no action.
- `CANCEL`       — cancel the addressed pending / pause owner.
- `INVALIDATE`   — flag invalidation; owner-strategy specific cleanup.
- `REFINE_TPSL`  — adjust TP ladder / SL on already-open ticket.

---

## 9. MQ4 hard gates (always local, even on hub commands)

`Cmd_HandleExecute` runs the following checks **before** `Risk_Preflight`:
1. `IsMaxTotalDDExceeded()`        — drawdown
2. `DailyStopOpenGate()`           — daily stop
3. `IsMarginLevelSufficient(50)`   — margin
4. `IsSessionValid()`              — session/schedule
5. `MarketFiltersActive()`         — spread / regime
6. `NewsPolicy_CanOpen(owner)`     — per-strategy news policy
7. `g_news_blockTrading`           — high-impact news (Predicted only opens)
8. `Risk_Preflight()`              — lot + risk% + broker step + Grid budget
9. `Ownership_Add()`               — registry + OCO peer + correlation_id

Hub may *advise*. MQ4 always *validates*.

---

## 10. Strategy-aware fusion (Electron)

`DecisionEngine.buildAiResponse` blends 5 votes for `final_bias` and 4
components for `ai_confidence`. Weights differ per `strategy_name`:

| strategy   | orderflow | hybrid | pattern | indicator | filter |
|-----------:|----------:|-------:|--------:|----------:|-------:|
| SMC        |     0.40  |  0.30  |   0.10  |    0.10   |  0.10  |
| ICT        |     0.40  |  0.30  |   0.10  |    0.10   |  0.10  |
| FVG        |     0.50  |  0.20  |   0.10  |    0.10   |  0.10  |
| Reverse    |     0.45  |  0.20  |   0.15  |    0.10   |  0.10  |
| Breakout   |     0.30  |  0.30  |   0.10  |    0.10   |  0.20  |
| Grid       |     0.20  |  0.10  |   0.10  |    0.30   |  0.30  |
| Predicted  |     0.25  |  0.25  |   0.10  |    0.10   |  0.30  |

Confidence components (`setup / orderflow / news / exec`) follow the same
strategy-aware table — see `strategyConfWeights()` in `DecisionEngine.js`.

---

## 11. Predicted handling (special path)

- The 6 owner strategies (Breakout/FVG/Grid/SMC/ICT/Reverse) consume the
  hub via the **SOFT** helpers `OF_RefineBias / OF_RefineConfidence /
  OF_ShouldDiscourage` only.
- `Predicted` is **excluded** from those soft helpers and instead receives
  its trade intents through the **command bus** (`oblivious.command`). It
  still passes through:
  - all hard gates listed in §9
  - `Risk_Preflight`
  - local `Ownership_Add`

This keeps the EA the only owner of the trade lifecycle while still
allowing news/AI-driven Predicted entries to flow from the hub.

---

## 12. Operational notes

- `TPSLMode = AI` is the only mode in which the hub's `tp1..tpmax`
  suggestions are honoured for placement. In `Native` the EA's TPSL engine
  owns the entire ladder.
- The hub's `bookmap_fresh / stale / age_ms` echo lets the EA log when an
  ai_response was computed against a stale orderflow view.
- The legacy `GET_AI|...` text request is auto-translated by
  `ZmqBridge._handleReq` into a minimal `ai_query` JSON, so older builds
  continue to work without any operator intervention.
