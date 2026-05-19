"""Smoke-test for the orderflow logic in oblivious_bridge.py.

Stubs the `bookmap` module so the bridge can be imported without the
Bookmap Java/GraalPy runtime. Drives synthetic depth + trade events
and asserts the snapshot output contains the expected metrics."""

import sys
import types
import time
import json

# ── stub the `bookmap` module ────────────────────────────────────
bm_stub = types.ModuleType("bookmap")
bm_stub.create_addon                = lambda: object()
bm_stub.start_addon                 = lambda *a, **kw: None
bm_stub.wait_until_addon_is_turned_off = lambda *a, **kw: None
sys.modules["bookmap"] = bm_stub

import os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bookmap-bridge"))
import oblivious_bridge as ob  # noqa: E402

print("─" * 60)
print("Smoke test: oblivious_bridge.BookState")
print("─" * 60)


def assert_eq(label, got, expected):
    ok = got == expected
    print(("  ✓ " if ok else "  ✗ ") + label + " — got=" + str(got) + " expected=" + str(expected))
    if not ok:
        sys.exit(1)


def assert_true(label, cond, extra=""):
    print(("  ✓ " if cond else "  ✗ ") + label + (" " + extra if extra else ""))
    if not cond:
        sys.exit(1)


# ─── 1. Symbol normalization ─────────────────────────────────────
print("\n[1] Symbol normalization")
assert_eq("XAU/USD",       ob._normalize_symbol("XAU/USD"),     "XAUUSD")
assert_eq("GOLD",          ob._normalize_symbol("GOLD"),        "XAUUSD")
assert_eq("EUR/USD",       ob._normalize_symbol("EUR/USD"),     "EURUSD")
assert_eq("GBPUSD@BMD",    ob._normalize_symbol("GBPUSD@BMD"),  "GBPUSD")
assert_eq("NAS100",        ob._normalize_symbol("NAS100"),      "US100")
assert_eq("SPX500",        ob._normalize_symbol("SPX500"),      "US500")
assert_eq("BTC-USDT",      ob._normalize_symbol("BTC-USDT"),    "BTCUSD")

# ─── 2. DOM pressure + imbalance ─────────────────────────────────
print("\n[2] DOM pressure + imbalance (XAUUSD)")
book = ob.BookState("XAUUSD")
# Push 5 bid levels (heavy) and 5 thin ask levels
for i in range(5):
    book.on_depth("bid", 2050.00 - i * 0.01, 50.0)
    book.on_depth("ask", 2050.10 + i * 0.01, 5.0)
snap = book.snapshot()["snapshot"]
assert_eq("dom_pressure", snap["dom_pressure"], "bid_heavy")
assert_true("imbalance > 0.5", snap["imbalance"] > 0.5,
            "got=" + str(snap["imbalance"]))
assert_eq("top_bid", snap["top_bid"], 2050.00)
assert_eq("top_ask", snap["top_ask"], 2050.10)

# ─── 3. Delta / CVD ──────────────────────────────────────────────
print("\n[3] Delta + CVD (BTCUSD)")
b = ob.BookState("BTCUSD")
for _ in range(5):
    b.on_trade(67000.0, 2.0, "buy")
for _ in range(2):
    b.on_trade(67000.0, 1.0, "sell")
snap = b.snapshot()["snapshot"]
assert_eq("delta", snap["delta"], 8.0)        # 5*2 - 2*1
assert_eq("cvd",   snap["cvd"],   8.0)

# ─── 4. Iceberg detection ────────────────────────────────────────
print("\n[4] Iceberg detection (EURUSD)")
b = ob.BookState("EURUSD")
PRICE = 1.08500
# Simulate 4 refills: each cycle qty>0 → qty=0 → qty>0 again
for _ in range(4):
    b.on_depth("bid", PRICE, 50.0)
    b.on_depth("bid", PRICE, 0.0)
b.on_depth("bid", PRICE, 50.0)  # final restock so it stays on book
snap = b.snapshot()["snapshot"]
assert_true("at least 1 iceberg", len(snap["iceberg"]) >= 1,
            "got=" + str(snap["iceberg"]))
top_ice = snap["iceberg"][0]
assert_eq("iceberg side", top_ice["side"], "bid")
assert_true("refills >= 3", top_ice["refills"] >= 3,
            "got=" + str(top_ice["refills"]))

# ─── 5. Sweep detection ──────────────────────────────────────────
print("\n[5] Sweep/Trap (US100)")
b = ob.BookState("US100")
# 4 different price levels lifted by buy aggressor, total qty 80
for p in (15000.0, 15000.25, 15000.50, 15000.75):
    b.on_trade(p, 20.0, "buy")
snap = b.snapshot()["snapshot"]
assert_true("sweep recorded", len(snap["sweep_trap"]) >= 1,
            "got=" + str(snap["sweep_trap"]))
assert_eq("sweep side", snap["sweep_trap"][0]["side"], "buy")
assert_true("sweep levels >= 3",
            snap["sweep_trap"][0]["levels"] >= 3,
            "got=" + str(snap["sweep_trap"][0]["levels"]))

# ─── 6. Absorption (large qty into static price) ─────────────────
print("\n[6] Absorption (XAUUSD)")
b = ob.BookState("XAUUSD")
# 30 lots of buy aggression but price stays within 2 ticks → bid absorbing
for _ in range(15):
    b.on_trade(2050.00, 2.0, "buy")  # qty 2 each (each > large_qty=5? no)
# Use a single big lot to trigger
b.on_trade(2050.00, 12.0, "buy")
b.on_trade(2050.01, 8.0,  "buy")
snap = b.snapshot()["snapshot"]
assert_true("absorption recorded",
            len(snap["absorption"]) >= 1,
            "got=" + str(snap["absorption"]))
top_abs = snap["absorption"][0]
assert_eq("absorbed_by", top_abs["absorbed_by"], "ask")  # buy was absorbed

# ─── 7. Decision payload sanity ──────────────────────────────────
print("\n[7] Decision payload (US500 — heavy bid book + buy delta)")
b = ob.BookState("US500")
# Heavy bid stack
for i in range(10):
    b.on_depth("bid", 5000.0 - i * 0.25, 100.0)
    b.on_depth("ask", 5000.25 + i * 0.25, 10.0)
# Strong buying — and price advances tick by tick (no absorption,
# real bullish breakout). 8 trades across 8 price levels.
for i in range(8):
    b.on_trade(5000.0 + i * 0.25, 50.0, "buy")
out = b.snapshot()
dec = out["decision"]
print("  decision: " + json.dumps(dec))
assert_eq("of_bias",    dec["of_bias"], "bullish")
assert_true("confidence > 50",
            dec["of_confidence"] > 50,
            "got=" + str(dec["of_confidence"]))

# ─── 8. JSON serialization sanity ────────────────────────────────
print("\n[8] All payloads are JSON-serializable")
for sym in ("XAUUSD", "EURUSD", "BTCUSD"):
    bb = ob.BookState(sym)
    bb.on_depth("bid", 100.0, 5.0)
    bb.on_trade(100.0, 1.0, "buy")
    out = bb.snapshot()
    s = json.dumps(out["snapshot"])
    d = json.dumps(out["decision"])
    assert_true(sym + " snapshot JSON ok", len(s) > 20)
    assert_true(sym + " decision JSON ok", len(d) > 20)

print("\n" + ("─" * 60))
print("ALL TESTS PASSED ✅")
print(("─" * 60))
