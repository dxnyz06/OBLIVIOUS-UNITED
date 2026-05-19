# ─────────────────────────────────────────────────────────────────────
# OBLIVIOUS HUB ← Bookmap Python-API bridge   (SENSOR-ONLY EDITION)
# ─────────────────────────────────────────────────────────────────────
# DESIGN RULES (do NOT violate):
#   1. Bookmap is a SENSOR. It reads orderflow and forwards raw events
#      + compact snapshots. It NEVER decides "long / short / cancel".
#   2. The EXE (BookmapClient.js) is the brain. It receives our raw
#      events + snapshots and computes the normalised `of_*` fields
#      consumed by the EA.
#   3. The EA is the executor. It owns risk, TP/SL, news, lot sizing.
#
# Pattern identical to Bookmap's own `hello_world.py`:
#   create_addon -> start_addon(sub, unsub) -> wait_until_addon_is_turned_off
#
# ZERO external dependencies — only Python stdlib.
# Compatible with Bookmap's embedded GraalPy / Jython interpreter.
#
# ── WIRE PROTOCOL OVER WS ws://127.0.0.1:8081 ───────────────────────
# We multiplex the following frame types over a single newline-
# delimited WebSocket text stream:
#
#   ── Stream A — RAW EVENTS (low-latency, only when triggered) ────
#     {"type":"depth",      "symbol", "side":"bid|ask", "price", "qty"}
#     {"type":"trade",      "symbol", "side":"buy|sell","price", "qty"}
#     {"type":"mbo",        "symbol", "action":"add|modify|cancel|exec",
#                           "order_id", "side":"bid|ask", "price", "qty"}
#
#   ── Stream B — SEMANTIC EVENTS (only when detected) ─────────────
#     {"type":"iceberg",    "symbol","price","side",
#                           "visible_executed_size",
#                           "hidden_estimated_size",
#                           "persistence_score"}                  # 0..1
#     {"type":"stop_run",   "symbol","price","side",
#                           "intensity","cluster_size"}
#     {"type":"sweep",      "symbol","direction":"up|down",
#                           "swept_levels","total_volume","speed"}
#     {"type":"absorption", "symbol","price","side",
#                           "absorbed_volume","aggressor_volume",
#                           "repetitions","strength"}             # 0..1
#     {"type":"exhaustion", "symbol","price","side",
#                           "exhaustion_score",                    # 0..1
#                           "delta_context","tape_slowdown"}
#
#   ── Stream C — SNAPSHOTS (every SNAPSHOT_PERIOD_MS) ─────────────
#     {"type":"dom_pressure", "symbol",
#         "best_bid_size","best_ask_size",
#         "bid_pressure_near","ask_pressure_near",
#         "passive_wall_above","passive_wall_below",
#         "dom_imbalance","pulling_score","stacking_score"}
#     {"type":"delta_tape", "symbol",
#         "aggr_buy_volume","aggr_sell_volume",
#         "delta_now","delta_window","delta_shift",
#         "delta_divergence","tape_speed","burst_score"}
#     {"type":"liquidity", "symbol",
#         "liquidity_added_above","liquidity_added_below",
#         "liquidity_removed_above","liquidity_removed_below",
#         "magnet_level","spoof_risk_score","stability_score"}
#
# Supported assets (state per symbol):
#   XAUUSD, EURUSD, GBPUSD, US100, US500, BTCUSD
# ─────────────────────────────────────────────────────────────────────

import json
import socket
import struct
import base64
import hashlib
import threading
import time
import sys
import inspect
from collections import deque

import bookmap as bm

# ─── Force UTF-8 on stdout/stderr to survive cp1252-only consoles. ───
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# ─────────────────────── config ────────────────────────
WS_HOST       = "127.0.0.1"
WS_PORT       = 8081
RAW_COALESCE_MS    = 50      # coalesce raw events
SNAPSHOT_PERIOD_MS = 150     # 3 snapshots per period
MAX_CLIENTS   = 8

# Per-asset configuration — tick size & "large trade" threshold tuned
# for normal lot/contract sizes per broker. Defaults are sane for retail.
ASSET_CONFIG = {
    "XAUUSD": {"tick": 0.01,    "large_qty": 5.0,   "dom_depth": 10, "near_ticks": 5},
    "EURUSD": {"tick": 0.00001, "large_qty": 10.0,  "dom_depth": 10, "near_ticks": 5},
    "GBPUSD": {"tick": 0.00001, "large_qty": 10.0,  "dom_depth": 10, "near_ticks": 5},
    "US100":  {"tick": 0.25,    "large_qty": 20.0,  "dom_depth": 10, "near_ticks": 5},
    "US500":  {"tick": 0.25,    "large_qty": 30.0,  "dom_depth": 10, "near_ticks": 5},
    "BTCUSD": {"tick": 0.01,    "large_qty": 1.0,   "dom_depth": 10, "near_ticks": 5},
}

# Rolling windows
WIN_DELTA_S       = 5.0       # delta_now window
WIN_DELTA_LONG_S  = 30.0      # delta_window (longer for shift detection)
WIN_ABSORPTION_S  = 1.0       # absorption check window
WIN_SWEEP_MS      = 300       # sweep/stop-run detection window
WIN_LIQ_S         = 2.0       # liquidity add/remove rolling window
ICEBERG_REFILL_N  = 3         # refills at same price → iceberg
EXHAUSTION_HIST_N = 40        # samples kept for CVD/price divergence
# ───────────────────────────────────────────────────────


# ═════════════════════ Shared state ═══════════════════════
_lock          = threading.Lock()
_clients       = []           # [(conn, addr), ...]
_raw_queue     = deque(maxlen=4096)
_books         = {}           # {symbol: BookState}
_server_started = False
_current_symbol = ""
_counters = {"depth": 0, "trade": 0, "mbo": 0, "bbo": 0, "last_report_ts": 0}


def _normalize_symbol(alias):
    if not alias:
        return ""
    a = str(alias).upper()
    if "XAU" in a or "GOLD" in a:                          return "XAUUSD"
    if "EUR" in a and "USD" in a:                          return "EURUSD"
    if "GBP" in a and "USD" in a:                          return "GBPUSD"
    if "NAS" in a or "US100" in a or "NDX" in a or "NQ" in a: return "US100"
    if "SPX" in a or "US500" in a or "ES" in a:            return "US500"
    if "BTC" in a:                                         return "BTCUSD"
    return a


def _cfg(symbol):
    return ASSET_CONFIG.get(symbol,
        {"tick": 0.01, "large_qty": 1.0, "dom_depth": 10, "near_ticks": 5})


# ═════════════════════ Per-symbol book state ═══════════════════════
class BookState(object):
    """Maintains DOM, trades, MBO order lifecycle and rolling
    orderflow metrics for ONE symbol. State is mutated by the
    Bookmap callback threads and READ by the snapshot thread."""

    __slots__ = (
        "symbol",
        # Aggregated DOM (price -> qty)
        "bids", "asks",
        # Trades & deltas
        "trades", "delta_hist", "price_hist",
        # Iceberg state
        "level_refills", "level_last_qty", "level_exec_volume",
        # MBO order lifecycle (order_id -> dict)
        "orders",
        # Liquidity add/remove timeline:  (ts, side, qty, level_rel_mid)
        "liq_add", "liq_rem",
        # Cumulative aggregates
        "cum_delta", "last_trade_price", "last_mid",
        # Tape speed sampling
        "tape_ts",
    )

    def __init__(self, symbol):
        self.symbol            = symbol
        self.bids              = {}
        self.asks              = {}
        self.trades            = deque(maxlen=4000)   # (ts, price, qty, side)
        self.delta_hist        = deque(maxlen=2048)   # (ts, signed_qty)
        self.price_hist        = deque(maxlen=EXHAUSTION_HIST_N)
        self.level_refills     = {}                   # (price, side) -> int
        self.level_last_qty    = {}                   # (price, side) -> float
        self.level_exec_volume = {}                   # price -> total executed there
        self.orders            = {}                   # order_id -> {price,side,size,ts}
        self.liq_add           = deque(maxlen=2048)
        self.liq_rem           = deque(maxlen=2048)
        self.cum_delta         = 0.0
        self.last_trade_price  = None
        self.last_mid          = None
        self.tape_ts           = deque(maxlen=128)

    # ── DOM mutators ───────────────────────────────────────────────
    def on_depth(self, side, price, qty):
        if price is None or qty is None:
            return
        book = self.bids if side == "bid" else self.asks
        key  = (price, side)
        prev = book.get(price, 0.0)
        now  = time.time()
        if qty <= 0:
            if price in book:
                if prev > 0:
                    # Track removal for liquidity snapshot
                    self.liq_rem.append((now, side, prev, price))
                del book[price]
            self.level_last_qty[key] = 0.0
        else:
            last_q = self.level_last_qty.get(key, 0.0)
            # Liquidity added (new level OR size grew)
            if qty > prev:
                self.liq_add.append((now, side, qty - prev, price))
            elif qty < prev:
                self.liq_rem.append((now, side, prev - qty, price))
            # Iceberg refill detection: level went to 0 then came back
            if last_q <= 0.0 and prev <= 0.0 and qty > 0.0:
                self.level_refills[key] = self.level_refills.get(key, 0) + 1
                if self.level_refills[key] >= ICEBERG_REFILL_N:
                    _emit_iceberg_event(self, price, side)
            book[price] = qty
            self.level_last_qty[key] = qty
        self._update_mid()

    def _update_mid(self):
        if self.bids and self.asks:
            try:
                top_bid = max(self.bids.keys())
                top_ask = min(self.asks.keys())
                self.last_mid = (top_bid + top_ask) / 2.0
            except Exception:
                pass

    def on_trade(self, price, qty, side):
        if price is None or qty is None:
            return
        now = time.time()
        signed = qty if side == "buy" else -qty
        self.trades.append((now, price, qty, side))
        self.delta_hist.append((now, signed))
        self.cum_delta += signed
        self.last_trade_price = price
        self.tape_ts.append(now)
        self.price_hist.append((int(now * 1000), price, self.cum_delta))
        # Track executed volume per price (iceberg hidden-size estimate)
        self.level_exec_volume[price] = self.level_exec_volume.get(price, 0.0) + qty
        # Event checks (these may push to the raw queue)
        self._check_absorption(now, price, qty, side)
        self._check_sweep_and_stop_run(now, side)
        self._check_exhaustion(now)

    # ── MBO event (order lifecycle) ───────────────────────────────
    def on_mbo(self, action, order_id, side, price, qty):
        if order_id is None:
            return
        now = time.time()
        prev = self.orders.get(order_id)
        if action == "add":
            self.orders[order_id] = {"price": price, "side": side, "size": qty, "ts": now}
            self.liq_add.append((now, side, qty, price))
        elif action == "modify":
            if prev:
                d = (qty or 0.0) - prev["size"]
                if d > 0:
                    self.liq_add.append((now, side, d, price))
                elif d < 0:
                    self.liq_rem.append((now, side, -d, price))
                prev["size"]  = qty
                prev["price"] = price
                prev["ts"]    = now
        elif action == "cancel":
            if prev:
                self.liq_rem.append((now, side, prev["size"], prev["price"]))
                del self.orders[order_id]
        elif action == "exec":
            if prev:
                executed = min(prev["size"], qty or prev["size"])
                prev["size"] -= executed
                if prev["size"] <= 0:
                    del self.orders[order_id]

    # ── Metric helpers ─────────────────────────────────────────────
    def _trim(self, now):
        cutoff_short = now - max(WIN_DELTA_S, WIN_ABSORPTION_S)
        cutoff_long  = now - WIN_DELTA_LONG_S
        while self.trades and self.trades[0][0] < cutoff_long:
            self.trades.popleft()
        while self.delta_hist and self.delta_hist[0][0] < cutoff_long:
            self.delta_hist.popleft()
        cutoff_liq = now - WIN_LIQ_S
        while self.liq_add and self.liq_add[0][0] < cutoff_liq:
            self.liq_add.popleft()
        while self.liq_rem and self.liq_rem[0][0] < cutoff_liq:
            self.liq_rem.popleft()
        while self.tape_ts and self.tape_ts[0] < cutoff_short:
            self.tape_ts.popleft()
        _ = cutoff_short  # silence

    # ── Event detectors (push to raw queue if triggered) ───────────
    def _check_absorption(self, now, price, qty, side):
        cfg = _cfg(self.symbol)
        if qty < cfg["large_qty"]:
            return
        cutoff = now - WIN_ABSORPTION_S
        same_side_qty = 0.0
        reps = 0
        prices = []
        for ts, p, q, s in self.trades:
            if ts < cutoff: continue
            prices.append(p)
            if s == side:
                same_side_qty += q
                if abs(p - price) <= cfg["tick"] * 1.5:
                    reps += 1
        if not prices:
            return
        rng = (max(prices) - min(prices)) / max(cfg["tick"], 1e-9)
        if rng <= 2.0 and same_side_qty >= cfg["large_qty"] * 2:
            absorbed_by = "ask" if side == "buy" else "bid"
            strength = min(1.0, same_side_qty / (cfg["large_qty"] * 6.0))
            _enqueue_raw({
                "type": "absorption",
                "symbol": self.symbol,
                "price": price,
                "side":  absorbed_by,
                "absorbed_volume":   round(same_side_qty, 4),
                "aggressor_volume":  round(same_side_qty, 4),
                "repetitions":       reps,
                "strength":          round(strength, 3),
            })

    def _check_sweep_and_stop_run(self, now, side):
        cfg = _cfg(self.symbol)
        cutoff = now - (WIN_SWEEP_MS / 1000.0)
        levels = set()
        total_q = 0.0
        first_ts = None
        last_ts  = None
        for ts, p, q, s in self.trades:
            if ts < cutoff: continue
            if s != side: continue
            levels.add(round(p / cfg["tick"]) if cfg["tick"] > 0 else p)
            total_q += q
            if first_ts is None: first_ts = ts
            last_ts = ts
        if len(levels) >= 3 and total_q >= cfg["large_qty"] * 2:
            duration = max((last_ts or now) - (first_ts or now), 1e-3)
            speed = total_q / duration  # qty per second
            direction = "up" if side == "buy" else "down"
            _enqueue_raw({
                "type": "sweep",
                "symbol": self.symbol,
                "direction":     direction,
                "side":          side,
                "swept_levels":  len(levels),
                "total_volume":  round(total_q, 4),
                "speed":         round(speed, 3),
            })
            # Stop-run = a sweep that LOOKS LIKE stops being hit:
            # aggressive same-side burst across ≥4 levels in <250ms.
            if len(levels) >= 4 and duration < 0.25:
                intensity = min(1.0, total_q / (cfg["large_qty"] * 8.0))
                _enqueue_raw({
                    "type": "stop_run",
                    "symbol": self.symbol,
                    "price":        self.last_trade_price,
                    "side":         side,
                    "intensity":    round(intensity, 3),
                    "cluster_size": len(levels),
                })

    def _check_exhaustion(self, now):
        if len(self.price_hist) < 12:
            return
        recent = list(self.price_hist)
        half   = len(recent) // 2
        old, new = recent[:half], recent[half:]
        try:
            pmax_old = max(p for _, p, _ in old)
            pmax_new = max(p for _, p, _ in new)
            cvd_old  = max(c for _, _, c in old)
            cvd_new  = max(c for _, _, c in new)
            pmin_old = min(p for _, p, _ in old)
            pmin_new = min(p for _, p, _ in new)
            cvd_lo_old = min(c for _, _, c in old)
            cvd_lo_new = min(c for _, _, c in new)
        except Exception:
            return
        score = 0.0
        side  = None
        if pmax_new > pmax_old and cvd_new <= cvd_old:
            score = min(1.0, (pmax_new - pmax_old) /
                         max(_cfg(self.symbol)["tick"] * 5, 1e-9))
            side = "buy"  # buy-side exhaustion = bears about to take over
        elif pmin_new < pmin_old and cvd_lo_new >= cvd_lo_old:
            score = min(1.0, (pmin_old - pmin_new) /
                         max(_cfg(self.symbol)["tick"] * 5, 1e-9))
            side = "sell"
        if side is None or score < 0.2:
            return
        # Tape slowdown contributes
        tape_speed = self._tape_speed(now)
        tape_slowdown = max(0.0, 1.0 - min(1.0, tape_speed / 5.0))
        _enqueue_raw({
            "type": "exhaustion",
            "symbol": self.symbol,
            "price":             self.last_trade_price,
            "side":              side,
            "exhaustion_score":  round(score, 3),
            "delta_context":     round(self.cum_delta, 3),
            "tape_slowdown":     round(tape_slowdown, 3),
        })

    def _tape_speed(self, now):
        if not self.tape_ts: return 0.0
        cutoff = now - WIN_DELTA_S
        n = 0
        for t in self.tape_ts:
            if t >= cutoff: n += 1
        return n / WIN_DELTA_S

    # ── Three independent snapshot builders ────────────────────────
    def snapshot_dom(self, now):
        cfg     = _cfg(self.symbol)
        depth_n = cfg["dom_depth"]
        bids_sorted = sorted(self.bids.items(), key=lambda kv: -kv[0])[:depth_n]
        asks_sorted = sorted(self.asks.items(), key=lambda kv:  kv[0])[:depth_n]
        bid_qty = sum(q for _, q in bids_sorted)
        ask_qty = sum(q for _, q in asks_sorted)
        total   = bid_qty + ask_qty
        imbalance = 0.0
        if total > 0:
            imbalance = round((bid_qty - ask_qty) / total, 4)
        best_bid_size = bids_sorted[0][1] if bids_sorted else 0.0
        best_ask_size = asks_sorted[0][1] if asks_sorted else 0.0
        # Pressure "near": sum of top near_ticks levels
        near = cfg["near_ticks"]
        bid_pressure_near = sum(q for _, q in bids_sorted[:near])
        ask_pressure_near = sum(q for _, q in asks_sorted[:near])
        # Passive walls: largest single level above/below mid
        passive_wall_above = max((q for _, q in asks_sorted), default=0.0)
        passive_wall_below = max((q for _, q in bids_sorted), default=0.0)
        # Pulling / stacking from MBO event timeline
        rem_q = sum(q for _, _, q, _ in self.liq_rem)
        add_q = sum(q for _, _, q, _ in self.liq_add)
        total_evt = rem_q + add_q
        pulling_score  = round(rem_q / total_evt, 3) if total_evt > 0 else 0.0
        stacking_score = round(add_q / total_evt, 3) if total_evt > 0 else 0.0
        return {
            "type":               "dom_pressure",
            "symbol":             self.symbol,
            "ts":                 int(now * 1000),
            "best_bid_size":      round(best_bid_size, 4),
            "best_ask_size":      round(best_ask_size, 4),
            "bid_pressure_near":  round(bid_pressure_near, 4),
            "ask_pressure_near":  round(ask_pressure_near, 4),
            "passive_wall_above": round(passive_wall_above, 4),
            "passive_wall_below": round(passive_wall_below, 4),
            "dom_imbalance":      imbalance,
            "pulling_score":      pulling_score,
            "stacking_score":     stacking_score,
            "top_bid":            bids_sorted[0][0] if bids_sorted else None,
            "top_ask":            asks_sorted[0][0] if asks_sorted else None,
            "dom": {
                "bids": [{"p": p, "q": round(q, 4)} for p, q in bids_sorted],
                "asks": [{"p": p, "q": round(q, 4)} for p, q in asks_sorted],
            },
        }

    def snapshot_delta(self, now):
        cfg = _cfg(self.symbol)
        cutoff_s = now - WIN_DELTA_S
        cutoff_l = now - WIN_DELTA_LONG_S
        aggr_buy = 0.0; aggr_sell = 0.0
        delta_now = 0.0; delta_window = 0.0
        for ts, p, q, s in self.trades:
            signed = q if s == "buy" else -q
            if ts >= cutoff_s:
                delta_now += signed
                if s == "buy":  aggr_buy  += q
                else:           aggr_sell += q
            if ts >= cutoff_l:
                delta_window += signed
        # Delta shift = delta_now versus long-window average
        avg = (delta_window - delta_now) / max(WIN_DELTA_LONG_S - WIN_DELTA_S, 1e-9)
        cur = delta_now / max(WIN_DELTA_S, 1e-9)
        delta_shift = round(cur - avg, 4)
        # Divergence: price vs CVD direction over last EXHAUSTION_HIST_N samples
        delta_divergence = 0.0
        if len(self.price_hist) >= 8:
            ph = list(self.price_hist)
            try:
                p0, p1 = ph[0][1], ph[-1][1]
                c0, c1 = ph[0][2], ph[-1][2]
                dp = p1 - p0
                dc = c1 - c0
                # Normalised divergence in [-1, 1]
                tick = max(cfg["tick"], 1e-9)
                lq   = max(cfg["large_qty"], 1e-9)
                np_  = dp / (tick * 10)
                nc_  = dc / (lq * 5)
                if (np_ > 0 and nc_ < 0) or (np_ < 0 and nc_ > 0):
                    delta_divergence = round(max(-1.0, min(1.0, np_ - nc_)), 3)
            except Exception:
                pass
        tape_speed = self._tape_speed(now)
        # Burst = how many trades in the LAST 500ms vs the average
        cutoff_burst = now - 0.5
        n_burst = sum(1 for t in self.tape_ts if t >= cutoff_burst)
        burst_score = round(min(1.0, n_burst / 20.0), 3)
        return {
            "type":             "delta_tape",
            "symbol":           self.symbol,
            "ts":               int(now * 1000),
            "aggr_buy_volume":  round(aggr_buy, 4),
            "aggr_sell_volume": round(aggr_sell, 4),
            "delta_now":        round(delta_now, 4),
            "delta_window":     round(delta_window, 4),
            "delta_shift":      delta_shift,
            "delta_divergence": delta_divergence,
            "tape_speed":       round(tape_speed, 3),
            "burst_score":      burst_score,
            "cvd":              round(self.cum_delta, 4),
            "last_price":       self.last_trade_price,
        }

    def snapshot_liquidity(self, now):
        mid = self.last_mid or self.last_trade_price or 0.0
        added_above = sum(q for _, _, q, p in self.liq_add if p >= mid)
        added_below = sum(q for _, _, q, p in self.liq_add if p <  mid)
        rem_above   = sum(q for _, _, q, p in self.liq_rem if p >= mid)
        rem_below   = sum(q for _, _, q, p in self.liq_rem if p <  mid)
        # Magnet level: largest single resting size within 10 ticks of mid
        cfg = _cfg(self.symbol)
        magnet_level = None
        magnet_qty   = 0.0
        for book in (self.bids, self.asks):
            for p, q in book.items():
                if mid and abs(p - mid) <= cfg["tick"] * 20 and q > magnet_qty:
                    magnet_qty = q
                    magnet_level = p
        # Spoof risk: high adds + high removes in same window = churn
        total_evt = added_above + added_below + rem_above + rem_below
        churn = 0.0
        if total_evt > 0:
            adds = added_above + added_below
            rems = rem_above + rem_below
            churn = 1.0 - abs(adds - rems) / total_evt
        spoof_risk_score = round(churn, 3)
        # Stability: low churn + book size > 0
        stability_score = round(1.0 - spoof_risk_score, 3)
        return {
            "type":                       "liquidity",
            "symbol":                     self.symbol,
            "ts":                         int(now * 1000),
            "liquidity_added_above":      round(added_above, 4),
            "liquidity_added_below":      round(added_below, 4),
            "liquidity_removed_above":    round(rem_above,   4),
            "liquidity_removed_below":    round(rem_below,   4),
            "magnet_level":               magnet_level,
            "magnet_qty":                 round(magnet_qty, 4),
            "spoof_risk_score":           spoof_risk_score,
            "stability_score":            stability_score,
        }

    def all_snapshots(self):
        now = time.time()
        self._trim(now)
        return [
            self.snapshot_dom(now),
            self.snapshot_delta(now),
            self.snapshot_liquidity(now),
        ]


def _get_book(symbol):
    if not symbol:
        return None
    sym  = _normalize_symbol(symbol)
    book = _books.get(sym)
    if book is None:
        book = BookState(sym)
        _books[sym] = book
    return book


# Helper used by BookState.on_depth when iceberg threshold hit.
def _emit_iceberg_event(book, price, side):
    cfg = _cfg(book.symbol)
    visible_executed = book.level_exec_volume.get(price, 0.0)
    n_refills        = book.level_refills.get((price, side), 0)
    hidden_estimate  = visible_executed * max(0, n_refills - 1)
    persistence      = min(1.0, n_refills / 6.0)
    _enqueue_raw({
        "type": "iceberg",
        "symbol":                book.symbol,
        "price":                 price,
        "side":                  side,
        "visible_executed_size": round(visible_executed, 4),
        "hidden_estimated_size": round(hidden_estimate,  4),
        "persistence_score":     round(persistence,      3),
    })
    _ = cfg


# ═════════════════════ WebSocket plumbing ═════════════════
_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def _ws_handshake(conn):
    conn.settimeout(15.0)   # Bookmap on Windows: Node ws client can be slow
    buf = b""
    while b"\r\n\r\n" not in buf:
        try:
            chunk = conn.recv(4096)
        except Exception as e:
            print("[oblivious-bridge] handshake recv error: " + str(e), flush=True)
            return False
        if not chunk:
            print("[oblivious-bridge] handshake: peer closed mid-handshake", flush=True)
            return False
        buf += chunk
        if len(buf) > 16384:
            print("[oblivious-bridge] handshake: header too big", flush=True)
            return False
    headers = {}
    try:
        head, _ = buf.split(b"\r\n\r\n", 1)
        for line in head.split(b"\r\n")[1:]:
            if b":" in line:
                k, v = line.split(b":", 1)
                headers[k.strip().lower()] = v.strip()
    except Exception as e:
        print("[oblivious-bridge] handshake: parse error " + str(e), flush=True)
        return False
    key = headers.get(b"sec-websocket-key", b"")
    if not key:
        print("[oblivious-bridge] handshake: no Sec-WebSocket-Key", flush=True)
        return False
    accept = base64.b64encode(hashlib.sha1(key + _GUID.encode("ascii")).digest()).decode("ascii")
    try:
        conn.sendall(
            ("HTTP/1.1 101 Switching Protocols\r\n"
             "Upgrade: websocket\r\nConnection: Upgrade\r\n"
             "Sec-WebSocket-Accept: " + accept + "\r\n\r\n").encode("ascii")
        )
    except Exception as e:
        print("[oblivious-bridge] handshake: write error " + str(e), flush=True)
        return False
    # Keep a long-ish read timeout: clients don't speak much, but we
    # don't want a zombie socket to live forever either.
    conn.settimeout(120.0)
    return True


def _ws_send_text(conn, text):
    payload = text.encode("utf-8")
    n = len(payload)
    header = bytearray([0x81])
    if n < 126:
        header.append(n)
    elif n < (1 << 16):
        header.append(126); header += struct.pack(">H", n)
    else:
        header.append(127); header += struct.pack(">Q", n)
    conn.sendall(bytes(header) + payload)


def _client_loop(conn, addr):
    try:
        if not _ws_handshake(conn):
            print("[oblivious-bridge] handshake failed for " + str(addr), flush=True)
            conn.close(); return
        with _lock:
            if len(_clients) >= MAX_CLIENTS:
                conn.close(); return
            _clients.append((conn, addr))
        print("[oblivious-bridge] client connected from " + str(addr), flush=True)
        try:
            hello = {
                "type":             "hello",
                "ts":               int(time.time() * 1000),
                "current_symbol":   _current_symbol,
                "tracked_symbols":  list(_books.keys()),
                "supported_assets": list(ASSET_CONFIG.keys()),
                "bridge_role":      "sensor",
                "decision_owner":   "exe",
            }
            _ws_send_text(conn, json.dumps(hello))
        except Exception as e:
            print("[oblivious-bridge] hello send failed: " + str(e), flush=True)
        # Drain client→server traffic. We respond to PING with PONG and
        # honor CLOSE; everything else is ignored.
        while True:
            try:
                hdr = conn.recv(2)
            except socket.timeout:
                # No client traffic for 120s — perfectly fine, just
                # keep waiting. The broadcast loops send their own data.
                continue
            except Exception as e:
                print("[oblivious-bridge] client recv error: " + str(e), flush=True)
                break
            if not hdr or len(hdr) < 2:
                print("[oblivious-bridge] client " + str(addr) +
                      " closed connection (recv returned " +
                      str(len(hdr) if hdr else 0) + " bytes)", flush=True)
                break
            b0 = hdr[0] if isinstance(hdr[0], int) else ord(hdr[0])
            b2 = hdr[1] if isinstance(hdr[1], int) else ord(hdr[1])
            opcode = b0 & 0x0f
            plen = b2 & 0x7f
            if plen == 126:
                plen = struct.unpack(">H", conn.recv(2))[0]
            elif plen == 127:
                plen = struct.unpack(">Q", conn.recv(8))[0]
            mask = None
            if b2 & 0x80:
                mask = conn.recv(4)
            rem = plen
            payload = b""
            while rem > 0:
                chunk = conn.recv(min(4096, rem))
                if not chunk: break
                payload += chunk
                rem -= len(chunk)
            if opcode == 0x8:
                # Client requested close — echo back close frame and exit.
                try:
                    conn.sendall(b"\x88\x00")
                except Exception:
                    pass
                print("[oblivious-bridge] client " + str(addr) +
                      " sent CLOSE frame", flush=True)
                break
            elif opcode == 0x9:
                # Ping — reply with pong (same payload).
                try:
                    n = len(payload)
                    if n < 126:
                        conn.sendall(bytes([0x8A, n]) + payload)
                    else:
                        conn.sendall(bytes([0x8A, 126]) + struct.pack(">H", n) + payload)
                except Exception:
                    pass
            # opcode 0x1 (text) / 0xA (pong) / 0x0 (continuation) → ignore
    except Exception as e:
        print("[oblivious-bridge] client_loop unexpected: " +
              type(e).__name__ + ": " + str(e), flush=True)
    finally:
        with _lock:
            _clients[:] = [c for c in _clients if c[0] is not conn]
        try: conn.close()
        except Exception: pass


def _accept_loop():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind((WS_HOST, WS_PORT))
    except Exception as e:
        print("[oblivious-bridge] FATAL: cannot bind " + str(WS_PORT) + " (" + str(e) + ")", flush=True)
        return
    s.listen(MAX_CLIENTS)
    print("[oblivious-bridge] WS listening on ws://" + WS_HOST + ":" + str(WS_PORT), flush=True)
    while True:
        try:
            conn, addr = s.accept()
            t = threading.Thread(target=_client_loop, args=(conn, addr))
            t.daemon = True
            t.start()
        except Exception as e:
            print("[oblivious-bridge] accept error: " + str(e), flush=True)
            time.sleep(0.2)


def _broadcast_clients(msgs):
    if not msgs:
        return
    with _lock:
        conns = list(_clients)
    if not conns:
        return
    try:
        text = "\n".join(json.dumps(m) for m in msgs)
    except Exception:
        return
    dead = []
    for conn, _addr in conns:
        try:
            _ws_send_text(conn, text)
        except Exception:
            dead.append(conn)
    if dead:
        with _lock:
            _clients[:] = [c for c in _clients if c[0] not in dead]


def _raw_broadcast_loop():
    """Stream A+B: drains the raw event queue every RAW_COALESCE_MS."""
    while True:
        time.sleep(RAW_COALESCE_MS / 1000.0)
        with _lock:
            if not _clients or not _raw_queue:
                if _clients and (int(time.time() * 1000) % 2000) < RAW_COALESCE_MS:
                    msgs = [{"type": "heartbeat", "ts": int(time.time() * 1000),
                             "symbol": _current_symbol}]
                else:
                    continue
            else:
                msgs = list(_raw_queue); _raw_queue.clear()
        _broadcast_clients(msgs)


def _snapshot_broadcast_loop():
    """Stream C: 3 independent snapshot frames per symbol per period."""
    while True:
        time.sleep(SNAPSHOT_PERIOD_MS / 1000.0)
        now_ms = int(time.time() * 1000)
        # Diagnostic dump every 15 seconds
        if now_ms - _counters["last_report_ts"] >= 15_000:
            _counters["last_report_ts"] = now_ms
            diag = {
                "type":    "diagnostic",
                "ts":      now_ms,
                "depth":   _counters["depth"],
                "trade":   _counters["trade"],
                "mbo":     _counters["mbo"],
                "bbo":     _counters["bbo"],
                "symbols": list(_books.keys()),
                "clients": len(_clients),
            }
            try:
                print(
                    "[oblivious-bridge] events recv: depth=" + str(diag["depth"]) +
                    " trades=" + str(diag["trade"]) +
                    " mbo="    + str(diag["mbo"]) +
                    " bbo="    + str(diag["bbo"]) +
                    " | symbols=" + str(diag["symbols"]) +
                    " | clients=" + str(diag["clients"]),
                    flush=True
                )
            except Exception:
                pass
            try:
                _broadcast_clients([diag])
            except Exception:
                pass
        with _lock:
            if not _clients:
                continue
            symbols = list(_books.items())
        msgs = []
        for sym, book in symbols:
            try:
                msgs.extend(book.all_snapshots())
            except Exception as e:
                print("[oblivious-bridge] snapshot error for " + sym + ": " + str(e), flush=True)
        _broadcast_clients(msgs)


def _start_ws_server_once():
    global _server_started
    if _server_started:
        return
    _server_started = True
    threads = [
        threading.Thread(target=_accept_loop,             name="ob-accept"),
        threading.Thread(target=_raw_broadcast_loop,      name="ob-raw"),
        threading.Thread(target=_snapshot_broadcast_loop, name="ob-snap"),
    ]
    for t in threads:
        t.daemon = True; t.start()


def _enqueue_raw(msg):
    msg.setdefault("ts", int(time.time() * 1000))
    msg["type"] = msg.get("type") or "raw"
    with _lock:
        _raw_queue.append(msg)


# ═════════════════════ Bookmap callbacks ═══════════════════════
_handlers_attached = False
_polling_started_for = set()
_req_id_counter = [0]


def _next_req_id():
    _req_id_counter[0] = (_req_id_counter[0] + 1) & 0x7FFFFFFF
    return _req_id_counter[0]


def _smart_call(fn, fn_name, addon, alias, req_id=None):
    """Call a bm.* function by introspecting its real signature with
    inspect.signature() and mapping each parameter by NAME. This works
    on python-api-0.1.6 where signatures are inconsistent:
      get_bbo(alias)                       -> 1 positional
      create_mbo_book(*, alias=...)        -> 0 positional, kwargs-only
      create_order_book(*, alias=...)      -> 0 positional, kwargs-only
      subscribe_to_depth(alias, req_id)    -> 2 positional
    Returns (result, used_repr) on success, (None, error_str) on failure
    of ALL attempted call shapes.
    """
    if fn is None:
        return (None, "no such function")

    if req_id is None:
        req_id = _next_req_id()

    # Strategy 1 — introspect signature and build kwargs by parameter NAME.
    sig = None
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        sig = None

    if sig is not None:
        kwargs = {}
        pos_args = []
        param_names = []
        for p in sig.parameters.values():
            if p.kind in (inspect.Parameter.VAR_POSITIONAL,
                          inspect.Parameter.VAR_KEYWORD):
                continue
            name_lc = p.name.lower()
            param_names.append(p.name)
            value = inspect.Parameter.empty
            if name_lc in ("alias", "symbol", "instrument"):
                value = alias
            elif name_lc in ("addon", "api", "context"):
                value = addon
            elif name_lc in ("req_id", "request_id", "id", "reqid"):
                value = req_id
            if value is inspect.Parameter.empty:
                if p.default is not inspect.Parameter.empty:
                    value = p.default
                else:
                    # Unknown required param — bail to fallback strategies
                    pos_args = None
                    kwargs = None
                    break
            if p.kind == inspect.Parameter.KEYWORD_ONLY:
                kwargs[p.name] = value
            else:
                pos_args.append(value)
        if pos_args is not None:
            try:
                res = fn(*pos_args, **kwargs)
                return (res, "introspect(pos=" + str(len(pos_args)) +
                        ",kw=" + ",".join(kwargs.keys()) + ")")
            except TypeError as e:
                # Signature was wrong — fall through to brute-force.
                pass
            except Exception as e:
                # Real exception (not a signature issue) — propagate.
                return (None, type(e).__name__ + ": " + str(e))

    # Strategy 2 — brute-force a bunch of common call shapes.
    last_err = "unknown"
    attempts = (
        ((alias,), {}),
        ((alias, req_id), {}),
        ((addon, alias), {}),
        ((addon, alias, req_id), {}),
        ((), {"alias": alias}),
        ((), {"alias": alias, "req_id": req_id}),
        ((), {"alias": alias, "addon": addon}),
        ((), {"addon": addon, "alias": alias}),
        ((), {}),
    )
    for args, kwargs in attempts:
        try:
            res = fn(*args, **kwargs)
            return (res, "brute(pos=" + str(len(args)) +
                    ",kw=" + ",".join(kwargs.keys()) + ")")
        except TypeError as e:
            last_err = type(e).__name__ + ": " + str(e)
            continue
        except Exception as e:
            return (None, type(e).__name__ + ": " + str(e))
    return (None, last_err)


def _try_bm_call(fn_name, addon, alias):
    """Backward-compatible thin wrapper around _smart_call."""
    return _smart_call(getattr(bm, fn_name, None), fn_name, addon, alias)


def _start_polling_thread(addon, alias):
    """Polling fallback: query bm.get_bbo() every 200 ms and synthesize
    depth events into BookState. This is the ONLY reliable data path on
    Bookmap python-api-0.1.6 + RPC bridge — the subscribe_to_*
    functions go through ReqDataConverter which is broken for string
    aliases (NumberFormatException), and the callback handlers alone
    are never invoked without subscribe."""
    if alias in _polling_started_for:
        return
    _polling_started_for.add(alias)

    def _loop():
        last_bid_price = None
        last_ask_price = None
        last_bid_size  = None
        last_ask_size  = None
        ok_count = 0
        err_count = 0
        # Try to create a server-side order book (best-effort). On
        # python-api-0.1.6 the signature is kwargs-only (create_order_book(*,
        # alias=...)) — _smart_call() handles every known variant.
        cob = getattr(bm, "create_order_book", None)
        if cob is not None:
            res, used = _smart_call(cob, "create_order_book", addon, alias)
            if used.startswith("introspect") or used.startswith("brute"):
                print("[oblivious-bridge] create_order_book OK for " + alias +
                      " " + used, flush=True)
            else:
                print("[oblivious-bridge] create_order_book failed: " + used, flush=True)

        get_bbo = getattr(bm, "get_bbo", None)
        if get_bbo is None:
            print("[oblivious-bridge] bm.get_bbo NOT AVAILABLE — cannot poll", flush=True)
            return

        # Build a fast, cached caller for get_bbo by introspecting its real
        # signature ONCE. Map each parameter by name; this works regardless
        # of whether the signature is (alias,) or (alias, req_id) or even
        # keyword-only.
        try:
            _bbo_sig = inspect.signature(get_bbo)
            _bbo_params = [
                p for p in _bbo_sig.parameters.values()
                if p.kind not in (inspect.Parameter.VAR_POSITIONAL,
                                  inspect.Parameter.VAR_KEYWORD)
            ]
            print("[oblivious-bridge] get_bbo sig: " + str(_bbo_sig), flush=True)
        except Exception as _e:
            _bbo_params = None
            print("[oblivious-bridge] get_bbo introspection failed (" +
                  type(_e).__name__ + ") — using brute call", flush=True)

        def _build_bbo_call():
            if _bbo_params is None:
                return lambda: _smart_call(get_bbo, "get_bbo", addon, alias)[0]
            pos_args = []
            kwargs = {}
            for p in _bbo_params:
                name = p.name.lower()
                if name in ("alias", "symbol", "instrument"):
                    val = alias
                elif name in ("addon", "api", "context"):
                    val = addon
                elif name in ("req_id", "request_id", "id", "reqid"):
                    val = _next_req_id()
                elif p.default is not inspect.Parameter.empty:
                    val = p.default
                else:
                    val = None
                if p.kind == inspect.Parameter.KEYWORD_ONLY:
                    kwargs[p.name] = val
                else:
                    pos_args.append(val)
            # Freeze: req_id should be fresh on each call, others static.
            has_req = any(p.name.lower() in ("req_id","request_id","id","reqid")
                          for p in _bbo_params)
            if not has_req:
                def _call_static(_pa=tuple(pos_args), _kw=dict(kwargs)):
                    return get_bbo(*_pa, **_kw)
                return _call_static
            def _call_dynamic():
                pa = []
                kw = {}
                for p in _bbo_params:
                    n = p.name.lower()
                    if n in ("alias","symbol","instrument"): v = alias
                    elif n in ("addon","api","context"):    v = addon
                    elif n in ("req_id","request_id","id","reqid"): v = _next_req_id()
                    elif p.default is not inspect.Parameter.empty: v = p.default
                    else: v = None
                    if p.kind == inspect.Parameter.KEYWORD_ONLY: kw[p.name] = v
                    else: pa.append(v)
                return get_bbo(*pa, **kw)
            return _call_dynamic

        _call_get_bbo = _build_bbo_call()
        # Probe once so we can log the actual call shape.
        try:
            _probe = _call_get_bbo()
            print("[oblivious-bridge] get_bbo probe OK (returned " +
                  type(_probe).__name__ + ")", flush=True)
        except Exception as _e:
            print("[oblivious-bridge] get_bbo probe error (" +
                  type(_e).__name__ + ": " + str(_e) + ") — will retry in loop",
                  flush=True)

        print("[oblivious-bridge] starting BBO polling thread for " + alias +
              " (every 200ms)", flush=True)

        # One-shot diagnostic dump of the first non-None BBO so we can
        # see the actual field structure on this Bookmap build.
        bbo_dumped = [False]
        none_streak = [0]

        def _extract_bbo_fields(bbo):
            """Best-effort extraction of (bid_price, bid_size, ask_price,
            ask_size) from whatever shape Bookmap returns. Tries many
            attribute name variants + dict + tuple unpacking."""
            if bbo is None:
                return (None, None, None, None)
            ATTR_BID_P = ("bid_price", "best_bid_price", "best_bid",
                          "bid", "bidPrice", "bestBidPrice")
            ATTR_BID_S = ("bid_size",  "best_bid_size",  "bid_qty",
                          "bidSize",  "bestBidSize")
            ATTR_ASK_P = ("ask_price", "best_ask_price", "best_ask",
                          "ask", "askPrice", "bestAskPrice")
            ATTR_ASK_S = ("ask_size",  "best_ask_size",  "ask_qty",
                          "askSize",  "bestAskSize")
            def _first_attr(obj, names):
                for n in names:
                    v = getattr(obj, n, None)
                    if v is not None:
                        return v
                return None
            bp  = _first_attr(bbo, ATTR_BID_P)
            bs  = _first_attr(bbo, ATTR_BID_S)
            ap  = _first_attr(bbo, ATTR_ASK_P)
            asz = _first_attr(bbo, ATTR_ASK_S)
            if bp is not None or ap is not None:
                return (bp, bs, ap, asz)
            # dict-like
            if hasattr(bbo, "keys"):
                try:
                    keys = list(bbo.keys())
                except Exception:
                    keys = []
                for n in ATTR_BID_P:
                    if n in keys: bp = bbo[n]; break
                for n in ATTR_BID_S:
                    if n in keys: bs = bbo[n]; break
                for n in ATTR_ASK_P:
                    if n in keys: ap = bbo[n]; break
                for n in ATTR_ASK_S:
                    if n in keys: asz = bbo[n]; break
                if bp is not None or ap is not None:
                    return (bp, bs, ap, asz)
            # tuple/list
            if isinstance(bbo, (list, tuple)):
                if len(bbo) >= 4:
                    return (bbo[0], bbo[1], bbo[2], bbo[3])
                if len(bbo) == 2:
                    return (bbo[0], None, bbo[1], None)
            return (None, None, None, None)

        while True:
            try:
                bbo = _call_get_bbo()
                # First-time diagnostic dump of the actual BBO shape
                if bbo is not None and not bbo_dumped[0]:
                    bbo_dumped[0] = True
                    try:
                        attrs = [a for a in dir(bbo) if not a.startswith("_")]
                    except Exception:
                        attrs = []
                    print("[oblivious-bridge] BBO sample for " + alias +
                          " :: type=" + type(bbo).__name__ +
                          " :: repr=" + repr(bbo)[:200], flush=True)
                    print("[oblivious-bridge] BBO attrs: " +
                          ", ".join(attrs[:50]), flush=True)
                if bbo is None:
                    none_streak[0] += 1
                    if none_streak[0] in (10, 50, 250) or none_streak[0] % 1500 == 0:
                        print("[oblivious-bridge] bbo=None for " + alias +
                              " (" + str(none_streak[0]) +
                              " polls) — abilita MBP+Depth nel chart" +
                              " (right-click → 'Show Bookmap (Heatmap)'" +
                              " + 'MBP Depth')", flush=True)
                else:
                    none_streak[0] = 0
                if bbo is not None:
                    bp, bs, ap, asz = _extract_bbo_fields(bbo)
                    book = _get_book(alias)
                    sym  = _normalize_symbol(alias)
                    if bp is not None and bp != last_bid_price:
                        if book is not None:
                            book.on_depth("bid", float(bp), float(bs or 0))
                        _enqueue_raw({"type": "depth", "symbol": sym, "side": "bid",
                                      "price": float(bp), "qty": float(bs or 0)})
                        _counters["depth"] += 1
                        last_bid_price, last_bid_size = bp, bs
                    if ap is not None and ap != last_ask_price:
                        if book is not None:
                            book.on_depth("ask", float(ap), float(asz or 0))
                        _enqueue_raw({"type": "depth", "symbol": sym, "side": "ask",
                                      "price": float(ap), "qty": float(asz or 0)})
                        _counters["depth"] += 1
                        last_ask_price, last_ask_size = ap, asz
                    # Synthesize a "trade" event when ASK size shrinks at
                    # the same price (someone bought) OR BID size shrinks
                    # at same price (someone sold). Best-effort heuristic.
                    if (ap == last_ask_price and last_ask_size is not None
                        and asz is not None and asz < last_ask_size):
                        delta = float(last_ask_size) - float(asz)
                        if delta > 0 and book is not None:
                            book.on_trade(float(ap), delta, "buy")
                            _enqueue_raw({"type": "trade", "symbol": sym, "side": "buy",
                                          "price": float(ap), "qty": delta})
                            _counters["trade"] += 1
                    if (bp == last_bid_price and last_bid_size is not None
                        and bs is not None and bs < last_bid_size):
                        delta = float(last_bid_size) - float(bs)
                        if delta > 0 and book is not None:
                            book.on_trade(float(bp), delta, "sell")
                            _enqueue_raw({"type": "trade", "symbol": sym, "side": "sell",
                                          "price": float(bp), "qty": delta})
                            _counters["trade"] += 1
                    ok_count += 1
                else:
                    err_count += 1
                # Periodic diagnostic from the polling thread itself
                if (ok_count + err_count) % 100 == 0 and ok_count + err_count > 0:
                    print("[oblivious-bridge] polling " + alias +
                          ": ok=" + str(ok_count) + " err=" + str(err_count) +
                          " last_bbo=(" + str(last_bid_price) + "/" + str(last_ask_price) + ")",
                          flush=True)
            except Exception as e:
                err_count += 1
                if err_count <= 5 or err_count % 50 == 0:
                    print("[oblivious-bridge] get_bbo error #" + str(err_count) +
                          " (" + type(e).__name__ + ": " + str(e) + ")", flush=True)
            time.sleep(0.1)

    t = threading.Thread(target=_loop, name="ob-poll-" + alias, daemon=True)
    t.start()


def handle_subscribe_instrument(addon, alias, full_name, is_crypto, pips,
                                size_multiplier, instrument_multiplier,
                                supported_features):
    """Called by Bookmap when the user opens a chart for an instrument.

    NOTE on timing: Bookmap 7.7+ uses an RPC bridge. Its internal
    `HandlerManager` is created on the first `[RPC-SERVER] Client init`
    message, which arrives ~20–50 ms AFTER our Python script starts.
    If we register depth / trade / MBO handlers from `__main__` (i.e.
    before the RPC server is ready), the RPC EventLoop processes
    incoming events with `handlerManager == null` →
    `NullPointerException` at EventLoop.lambda$new$0:27 and the addon
    becomes a zombie (Bookmap freezes).

    Solution: defer handler attachment to the FIRST call of
    `handle_subscribe_instrument`. At this point the RPC server is
    guaranteed to be fully wired up because Bookmap itself just
    invoked us through it.

    DATA-PATH NOTE: on Bookmap python-api-0.1.6 + RPC bridge the
    `add_*_handler` callbacks never actually fire on their own — they
    only fire IF `subscribe_to_*` is called first, BUT that goes
    through the broken `ReqDataConverter` (NumberFormatException on
    string aliases). So we use a polling fallback via
    `bm.create_order_book` + `bm.get_bbo` which bypasses the converter
    entirely.
    """
    global _current_symbol, _handlers_attached
    sym = _normalize_symbol(alias)
    print("[oblivious-bridge] subscribed: " + alias + " (-> " + sym + ")", flush=True)
    _current_symbol = sym
    _get_book(alias)
    _start_ws_server_once()

    # Lazy attach (first call only) — RPC server is ready here.
    if not _handlers_attached:
        _handlers_attached = True
        _attach_listeners(addon)

    # Try the official subscribe path with detailed error reporting.
    # If it works, we get callback-driven data (low latency). If it
    # fails (most common case on this build), we fall back to polling.
    def _try_subscribe(fn_name):
        fn = getattr(bm, fn_name, None)
        if fn is None:
            return False
        try:
            sig = inspect.signature(fn)
            print("[oblivious-bridge] " + fn_name + " sig: " + str(sig), flush=True)
        except Exception:
            pass
        res, used = _smart_call(fn, fn_name, addon, alias)
        if used.startswith("introspect") or used.startswith("brute"):
            print("[oblivious-bridge] " + fn_name + " OK for " + alias +
                  " " + used, flush=True)
            return True
        print("[oblivious-bridge] " + fn_name + " failed: " + used, flush=True)
        return False

    _try_subscribe("subscribe_to_depth")
    _try_subscribe("subscribe_to_trades")
    _try_subscribe("subscribe_to_mbo")

    # ── REAL full-depth/MBO data path on python-api-0.1.6 ───────────
    # bm.create_mbo_book / bm.create_order_book take ZERO positional
    # args on this build — the signature is kwargs-only (alias=...).
    # _smart_call() handles every known shape via inspect.signature().
    for fn_name in ("create_mbo_book", "create_order_book"):
        fn = getattr(bm, fn_name, None)
        if fn is None:
            continue
        try:
            sig = inspect.signature(fn)
            print("[oblivious-bridge] " + fn_name + " sig: " + str(sig), flush=True)
        except Exception:
            pass
        res, used = _smart_call(fn, fn_name, addon, alias)
        if used.startswith("introspect") or used.startswith("brute"):
            print("[oblivious-bridge] " + fn_name + " OK for " + alias +
                  " " + used, flush=True)
        else:
            print("[oblivious-bridge] " + fn_name + " failed: " + used, flush=True)

    # ALWAYS start the polling fallback. If callbacks happen to work,
    # the BookState dedupes / no-ops on identical updates, so polling
    # adds zero overhead. If callbacks DON'T work (this user's build),
    # polling is the ONLY data path.
    _start_polling_thread(addon, alias)


def handle_unsubscribe_instrument(addon, alias):
    print("[oblivious-bridge] unsubscribed: " + alias, flush=True)


def _attach_listeners(addon):
    """Register depth / trade / MBO handlers.

    Called LAZILY from `handle_subscribe_instrument` (NOT from
    `__main__`) so that the RPC server's `HandlerManager` is
    guaranteed to exist before the first event arrives.

    On Bookmap 7.7+ the modern names are `add_depth_handler`,
    `add_trades_handler`, `add_mbo_handler` (verified via dir(bm)
    on the user's build). We register ONLY those — the legacy
    `*_listener` family does not exist on this RPC build and
    attempting it just adds noise to the log.
    """
    def _try(fn_name, callback):
        fn = getattr(bm, fn_name, None)
        if fn is None:
            print("[oblivious-bridge] " + fn_name + " NOT AVAILABLE on this build", flush=True)
            return False
        try:
            fn(addon, callback)
            print("[oblivious-bridge] handler attached: " + fn_name, flush=True)
            return True
        except Exception as e:
            print("[oblivious-bridge] " + fn_name + " FAILED (" +
                  type(e).__name__ + ": " + str(e) + ")", flush=True)
            return False

    _try("add_depth_handler",  _on_depth)
    _try("add_trades_handler", _on_trade)
    _try("add_mbo_handler",    _on_mbo)


# ═════════════════════ Market-data callbacks ═══════════════════
def _on_depth(*args):
    try:
        if len(args) >= 4:
            alias, is_bid, price, size = args[-4], args[-3], args[-2], args[-1]
        else:
            ev = args[0]
            alias  = getattr(ev, "alias", "")
            is_bid = getattr(ev, "is_bid", True)
            price  = getattr(ev, "price", 0)
            size   = getattr(ev, "size",  0)
        side  = "bid" if is_bid else "ask"
        price = float(price); size = float(size)
        book  = _get_book(alias)
        if book is not None:
            book.on_depth(side, price, size)
        _enqueue_raw({"type": "depth", "symbol": _normalize_symbol(alias),
                      "side": side, "price": price, "qty": size})
        _counters["depth"] += 1
    except Exception:
        pass


def _on_trade(*args):
    try:
        if len(args) >= 4:
            alias, price, size, is_buy = args[-4], args[-3], args[-2], args[-1]
        else:
            ev = args[0]
            alias  = getattr(ev, "alias", "")
            price  = getattr(ev, "price", 0)
            size   = getattr(ev, "size",  0)
            is_buy = getattr(ev, "is_buy_aggressor", True)
        side  = "buy" if is_buy else "sell"
        price = float(price); size = float(size)
        book  = _get_book(alias)
        if book is not None:
            book.on_trade(price, size, side)
        _enqueue_raw({"type": "trade", "symbol": _normalize_symbol(alias),
                      "side": side, "price": price, "qty": size})
        _counters["trade"] += 1
    except Exception:
        pass


def _on_mbo(*args):
    """MBO event: try to extract order_id + action.

    Bookmap's MBO surface varies by version. We attempt to read every
    common attribute and fall back to using the event as a depth update."""
    try:
        ev = args[-1]
        alias    = getattr(ev, "alias",    _current_symbol)
        order_id = getattr(ev, "order_id", getattr(ev, "id", None))
        # Action mapping
        action = (getattr(ev, "action", None)
                  or getattr(ev, "type",   None)
                  or "update")
        action = str(action).lower()
        if   "add"    in action or "insert" in action or "new"    in action: action = "add"
        elif "mod"    in action or "update" in action or "amend"  in action: action = "modify"
        elif "cancel" in action or "delete" in action or "remove" in action: action = "cancel"
        elif "exec"   in action or "trade"  in action or "fill"   in action: action = "exec"
        else: action = "modify"
        price  = getattr(ev, "price", None)
        size   = getattr(ev, "size",  None)
        is_bid = getattr(ev, "is_bid", True)
        side   = "bid" if is_bid else "ask"
        if price is None:
            return
        book = _get_book(alias)
        if book is not None:
            book.on_mbo(action, order_id, side, float(price), float(size or 0))
            # Maintain aggregated DOM too (add/modify alter resting size,
            # cancel removes it). Best-effort, broker-dependent.
            if action in ("add", "modify"):
                book.on_depth(side, float(price), float(size or 0))
            elif action == "cancel":
                book.on_depth(side, float(price), 0.0)
        _enqueue_raw({
            "type":     "mbo",
            "action":   action,
            "order_id": str(order_id) if order_id is not None else None,
            "symbol":   _normalize_symbol(alias),
            "price":    float(price),
            "qty":      float(size or 0),
            "side":     side,
        })
        _counters["mbo"] += 1
    except Exception:
        pass


def _on_bbo(*args):
    try:
        ev = args[-1] if args else None
        alias = getattr(ev, "alias", _current_symbol)
        bid_p = getattr(ev, "bid_price", None)
        bid_s = getattr(ev, "bid_size",  None)
        ask_p = getattr(ev, "ask_price", None)
        ask_s = getattr(ev, "ask_size",  None)
        book  = _get_book(alias)
        sym   = _normalize_symbol(alias)
        if bid_p is not None:
            if book is not None:
                book.on_depth("bid", float(bid_p), float(bid_s or 0))
            _enqueue_raw({"type": "depth", "symbol": sym, "side": "bid",
                          "price": float(bid_p), "qty": float(bid_s or 0)})
        if ask_p is not None:
            if book is not None:
                book.on_depth("ask", float(ask_p), float(ask_s or 0))
            _enqueue_raw({"type": "depth", "symbol": sym, "side": "ask",
                          "price": float(ask_p), "qty": float(ask_s or 0)})
        _counters["bbo"] += 1
    except Exception:
        pass


# ═════════════════════ Module-level callbacks (python-api 0.1.6) ═════
# These names are recognised by Bookmap's python-api 0.1.6 addon
# framework via dir(user_module). When bm.create_order_book or
# bm.create_mbo_book is active for an alias, Bookmap auto-invokes them
# with the real depth / MBO events — bypassing the broken
# ReqDataConverter that breaks subscribe_to_*. This is the FULL-DEPTH /
# FULL-MBO data path on this build.
# ───────────────────────────────────────────────────────────────────

def on_depth(addon, alias, is_bid, price, size):
    """Auto-invoked by Bookmap for every depth update once
    bm.create_order_book(addon, alias) has been called."""
    try:
        side = "bid" if is_bid else "ask"
        book = _get_book(alias)
        if book is not None:
            book.on_depth(side, float(price), float(size or 0))
        _enqueue_raw({"type": "depth", "symbol": _normalize_symbol(alias),
                      "side": side, "price": float(price),
                      "qty":  float(size or 0)})
        _counters["depth"] += 1
    except Exception as e:
        if _counters["depth"] < 5:
            print("[oblivious-bridge] on_depth error: " + str(e), flush=True)


def on_new_order(addon, alias, order_id, is_bid, price, size):
    """Auto-invoked by Bookmap on every NEW MBO order."""
    try:
        side  = "bid" if is_bid else "ask"
        book  = _get_book(alias)
        oid   = str(order_id) if order_id is not None else None
        if book is not None:
            book.on_mbo("add", oid, side, float(price), float(size or 0))
            book.on_depth(side, float(price), float(size or 0))
        _enqueue_raw({"type": "mbo", "action": "add",
                      "order_id": oid,
                      "symbol":   _normalize_symbol(alias),
                      "price":    float(price), "qty": float(size or 0),
                      "side":     side})
        _counters["mbo"] += 1
    except Exception as e:
        if _counters["mbo"] < 5:
            print("[oblivious-bridge] on_new_order error: " + str(e), flush=True)


def on_replace_order(addon, alias, order_id, new_size=None, new_price=None, **kwargs):
    """Auto-invoked when an MBO order is amended (modified)."""
    try:
        oid  = str(order_id) if order_id is not None else None
        book = _get_book(alias)
        # Look up the previous order side via stored state if available
        prev_side = "bid"
        if book is not None and oid in book.orders:
            prev_side = book.orders[oid].get("side", "bid")
        if book is not None:
            book.on_mbo("modify", oid, prev_side,
                        float(new_price) if new_price is not None else None,
                        float(new_size)  if new_size  is not None else None)
            if new_price is not None and new_size is not None:
                book.on_depth(prev_side, float(new_price), float(new_size or 0))
        _enqueue_raw({"type": "mbo", "action": "modify",
                      "order_id": oid,
                      "symbol":   _normalize_symbol(alias),
                      "price":    float(new_price) if new_price is not None else None,
                      "qty":      float(new_size)  if new_size  is not None else 0,
                      "side":     prev_side})
        _counters["mbo"] += 1
    except Exception as e:
        if _counters["mbo"] < 5:
            print("[oblivious-bridge] on_replace_order error: " + str(e), flush=True)


def on_remove_order(addon, alias, order_id):
    """Auto-invoked when an MBO order is cancelled / filled."""
    try:
        oid  = str(order_id) if order_id is not None else None
        book = _get_book(alias)
        prev_side  = "bid"
        prev_price = None
        if book is not None and oid in book.orders:
            prev_side  = book.orders[oid].get("side", "bid")
            prev_price = book.orders[oid].get("price", None)
        if book is not None:
            book.on_mbo("cancel", oid, prev_side, prev_price, 0.0)
            if prev_price is not None:
                book.on_depth(prev_side, float(prev_price), 0.0)
        _enqueue_raw({"type": "mbo", "action": "cancel",
                      "order_id": oid,
                      "symbol":   _normalize_symbol(alias),
                      "price":    float(prev_price) if prev_price is not None else None,
                      "qty":      0.0, "side": prev_side})
        _counters["mbo"] += 1
    except Exception as e:
        if _counters["mbo"] < 5:
            print("[oblivious-bridge] on_remove_order error: " + str(e), flush=True)


# ═════════════════════ Entry point ═══════════════════════
if __name__ == "__main__":
    # ═══════════════════════════════════════════════════════════════
    # VERSION BANNER — if you don't see "V3 INSPECT" in your log,
    # you are running an OLD .jar/.py. The whole purpose of this
    # block is to make the version visible at a glance.
    # ═══════════════════════════════════════════════════════════════
    print("[oblivious-bridge] ============================================", flush=True)
    print("[oblivious-bridge]   OBLIVIOUS BRIDGE  V3.1  ::  BBO-INTROSPECT", flush=True)
    print("[oblivious-bridge]   build: 2026-05-18  auto-signature + bbo field scan", flush=True)
    print("[oblivious-bridge]   IF YOU SEE THIS LINE THE NEW CODE IS LIVE", flush=True)
    print("[oblivious-bridge] ============================================", flush=True)
    addon = bm.create_addon()
    bm.start_addon(addon, handle_subscribe_instrument, handle_unsubscribe_instrument)
    try:
        names = sorted(n for n in dir(bm) if not n.startswith("_"))
        print("[oblivious-bridge] bm.* surface (" + str(len(names)) + " symbols):", flush=True)
        for n in names:
            print("  bm." + n, flush=True)
    except Exception as e:
        print("[oblivious-bridge] dir(bm) failed: " + str(e), flush=True)
    # Pre-start the WS server so the Electron Hub can connect even
    # BEFORE the user subscribes the first instrument inside Bookmap.
    _start_ws_server_once()
    print("[oblivious-bridge] READY V3 (sensor-only, inspect-sig) — assets: " +
          ", ".join(ASSET_CONFIG.keys()), flush=True)
    bm.wait_until_addon_is_turned_off(addon)
