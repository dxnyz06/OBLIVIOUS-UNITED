// Offline smoke-test for BookmapClient (3-stream router).
// Spins up a tiny WS server, feeds it the same frame shapes the
// Python bridge emits, and asserts client state after coalesce.

const { WebSocketServer } = require("ws");
const assert              = require("assert");
const BookmapClient       = require("./src/services/BookmapClient");

(async () => {
  const PORT = 18081;
  const server = new WebSocketServer({ host: "127.0.0.1", port: PORT });

  // ── Simulate the Python bridge ──────────────────────────────────
  server.on("connection", (ws) => {
    // Hello
    ws.send(JSON.stringify({
      type: "hello", ts: Date.now(),
      current_symbol: "XAUUSD",
      tracked_symbols: ["XAUUSD"],
      supported_assets: ["XAUUSD", "EURUSD", "GBPUSD", "US100", "US500", "BTCUSD"],
    }));
    // A small burst of mixed-stream frames separated by '\n'
    const frames = [
      // Stream-1 raw
      { type: "depth", symbol: "XAUUSD", side: "bid", price: 2050.00, qty: 50 },
      { type: "trade", symbol: "XAUUSD", side: "buy", price: 2050.01, qty: 5 },
      { type: "mbo",   symbol: "XAUUSD", action: "add", side: "ask", price: 2050.10, qty: 3 },
      // Stream-2 snapshot
      {
        type: "snapshot", symbol: "XAUUSD", ts: Date.now(),
        top_bid: 2050.00, top_ask: 2050.10,
        bid_qty: 500, ask_qty: 50, imbalance: 0.82, dom_pressure: "bid_heavy",
        delta: 42.5, cvd: 320.0,
        absorption: [{ ts: Date.now(), absorbed_by: "ask", size: 22.5, price: 2050.00 }],
        sweep_trap: [{ ts: Date.now(), side: "buy", levels: 4, size: 80.0 }],
        iceberg: [{ price: 2050.00, side: "bid", refills: 5 }],
        exhaustion: "buy_exhaustion",
        last_price: 2050.01,
        dom: {
          bids: [{ p: 2050.00, q: 50 }, { p: 2049.99, q: 30 }, { p: 2049.98, q: 25 }],
          asks: [{ p: 2050.10, q:  5 }, { p: 2050.11, q:  8 }, { p: 2050.12, q: 12 }],
        },
      },
      // Stream-3 decision
      {
        type: "decision", symbol: "XAUUSD", ts: Date.now(),
        of_bias: "bullish", of_confidence: 71, of_signal: "ICEBERG_BID",
      },
      // Second symbol (EURUSD) — multi-asset routing test
      {
        type: "decision", symbol: "EURUSD", ts: Date.now(),
        of_bias: "bearish", of_confidence: 58, of_signal: "ABSORPTION_ASK",
      },
    ];
    ws.send(frames.map((f) => JSON.stringify(f)).join("\n"));
  });

  // ── Drive the client ────────────────────────────────────────────
  const decisions = [];
  const snapshots = [];
  const client = new BookmapClient({
    url: `ws://127.0.0.1:${PORT}`,
    telemetry: { log: () => {} },
  });
  client.on("snapshot", (s) => snapshots.push(s));
  client.on("decision", (d) => decisions.push(d));
  client.start();

  // Wait for coalesced emit (50 ms throttle)
  await new Promise((r) => setTimeout(r, 250));

  // ── Assertions ──────────────────────────────────────────────────
  console.log("[smoke] decisions received:", decisions.length);
  console.log("[smoke] snapshot count:    ", snapshots.length);
  console.log("[smoke] tracked symbols:   ", client.symbols());

  const flat = client.snapshot();
  console.log("[smoke] flat.connected:    ", flat.connected);
  console.log("[smoke] flat.symbol:       ", flat.symbol);
  console.log("[smoke] flat.icebergCount: ", flat.icebergCount);
  console.log("[smoke] flat.absorption:   ", flat.absorptionCount);
  console.log("[smoke] flat.stopRunCount: ", flat.stopRunCount);
  console.log("[smoke] flat.exhaustionCt: ", flat.exhaustionCount);
  console.log("[smoke] flat.events types: ", flat.events.map((e) => e.type));
  console.log("[smoke] flat.decision:     ", flat.decision);
  console.log("[smoke] EURUSD decision:   ", flat.decisions.EURUSD);
  console.log("[smoke] mbo top-3:         ", flat.mboLevels.slice(0, 3));

  assert.strictEqual(flat.connected, true,                      "client.connected");
  assert.strictEqual(flat.symbol,    "XAUUSD",                  "current symbol");
  assert.strictEqual(client.symbols().includes("XAUUSD"), true, "XAUUSD tracked");
  assert.strictEqual(client.symbols().includes("EURUSD"), true, "EURUSD tracked");
  assert.strictEqual(decisions.length >= 2, true,               "2+ decision frames");
  assert.strictEqual(flat.icebergCount,    1, "iceberg counter");
  assert.strictEqual(flat.stopRunCount,    1, "sweep (alias=stopRunCount)");
  assert.strictEqual(flat.absorptionCount, 1, "absorption counter");
  assert.strictEqual(flat.exhaustionCount, 1, "exhaustion counter");
  assert.strictEqual(flat.decision.of_bias, "bullish",          "current bias");
  assert.strictEqual(flat.decisions.EURUSD.of_bias, "bearish",  "EUR/USD bias");
  assert.strictEqual(flat.mboLevels.length, 6,                  "MBO top-3 each side");
  // Event surface contains BOTH raw types AND signal types
  const types = new Set(flat.events.map((e) => e.type));
  assert.ok(types.has("depth"),      "raw depth surfaced");
  assert.ok(types.has("trade"),      "raw trade surfaced");
  assert.ok(types.has("iceberg"),    "iceberg signal surfaced");
  assert.ok(types.has("absorption"), "absorption signal surfaced");
  assert.ok(types.has("sweep"),      "sweep signal surfaced");
  assert.ok(types.has("exhaustion"), "exhaustion signal surfaced");

  client.stop();
  server.close();
  console.log("\n✅ BookmapClient 3-stream smoke test PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("❌ smoke test failed:", e);
  process.exit(1);
});
