// Bookmap layer smoke test (no real SDK): spins up a fake plugin
// WebSocket server on 127.0.0.1:8081, lets BookmapClient connect and
// receive 6 simulated frames (mbo / iceberg / stop / imbalance), then
// verifies snapshot fields match what the real Java plugin emits.

const WebSocket     = require("ws");
const BookmapClient = require("./src/services/BookmapClient");
const Telemetry     = require("./src/services/Telemetry");

const PORT = 8081;

function expect(label, cond, info) {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${label}${info ? "  " + info : ""}`);
  return !!cond;
}

(async () => {
  let pass = 0, fail = 0;

  // ---- fake plugin server ----
  const wss = new WebSocket.Server({ host: "127.0.0.1", port: PORT });
  let serverConn = null;
  wss.on("connection", (ws) => {
    serverConn = ws;
    console.log("[fake-plugin] client connected");
  });

  await new Promise((r) => wss.on("listening", r));
  console.log(`[fake-plugin] listening on ws://127.0.0.1:${PORT}`);

  // ---- client ----
  const tel = new Telemetry({ emit: () => {} });
  const captured = [];
  const client = new BookmapClient({ url: `ws://127.0.0.1:${PORT}`, telemetry: tel });
  client.on("snapshot", (s) => captured.push(s));
  client.start();

  // wait connect
  for (let i = 0; i < 50 && !serverConn; i++) await new Promise((r) => setTimeout(r, 50));
  expect("plugin received connection",          !!serverConn) ? pass++ : fail++;
  expect("BookmapClient.snapshot connected=true", client.snapshot().connected) ? pass++ : fail++;

  // ---- 4 plugin events: mbo / iceberg / stop / imbalance ----
  // Field names match BookmapClient._absorb: msg.symbol/sym, msg.bidImbalance,
  // msg.askImbalance, msg.type, msg.mbo (array).
  serverConn.send(JSON.stringify({ type: "mbo",       sym: "EURUSD", mbo: [{ price: 1.0851, qty: 120, side: "BID" }, { price: 1.0850, qty: 80, side: "BID" }], ts: Date.now() }));
  serverConn.send(JSON.stringify({ type: "iceberg",   sym: "EURUSD", side: "ASK", price: 1.0852, hidden_q: 1500, ts: Date.now() }));
  serverConn.send(JSON.stringify({ type: "stop",      sym: "EURUSD", side: "BID", price: 1.0830, q: 5000, ts: Date.now() }));
  serverConn.send(JSON.stringify({ type: "imbalance", sym: "EURUSD", bidImbalance: 0.62, askImbalance: 0.38, ts: Date.now() }));

  await new Promise((r) => setTimeout(r, 250));

  const snap = client.snapshot();
  expect("symbol locked to EURUSD",             snap.symbol === "EURUSD") ? pass++ : fail++;
  expect("imbalance bid=0.62",                  Math.abs(snap.bidImbalance - 0.62) < 1e-9) ? pass++ : fail++;
  expect("imbalance ask=0.38",                  Math.abs(snap.askImbalance - 0.38) < 1e-9) ? pass++ : fail++;
  expect("iceberg counter incremented",         snap.icebergCount >= 1) ? pass++ : fail++;
  expect("stop counter incremented",            snap.stopRunCount >= 1) ? pass++ : fail++;
  expect("mbo levels recorded",                 Array.isArray(snap.mboLevels) && snap.mboLevels.length >= 1) ? pass++ : fail++;
  expect("client emitted >=1 snapshot to listeners", captured.length >= 1) ? pass++ : fail++;

  // ---- reconnect: kill server, see client retry ----
  console.log("[fake-plugin] closing socket -> reconnect smoke");
  try { serverConn.terminate(); } catch (_) {}
  serverConn = null;
  wss.close();
  await new Promise((r) => setTimeout(r, 400));
  expect("BookmapClient.snapshot connected=false after server gone", client.snapshot().connected === false) ? pass++ : fail++;

  // ---- restart server, expect client to reconnect within ~2s (exp backoff) ----
  const wss2 = new WebSocket.Server({ host: "127.0.0.1", port: PORT });
  await new Promise((r) => wss2.on("listening", r));
  let server2Conn = null;
  wss2.on("connection", (ws) => { server2Conn = ws; });
  for (let i = 0; i < 60 && !server2Conn; i++) await new Promise((r) => setTimeout(r, 100));
  expect("BookmapClient reconnected after server returned", !!server2Conn && client.snapshot().connected) ? pass++ : fail++;

  // ---- cleanup ----
  client.stop();
  try { wss2.close(); } catch (_) {}

  console.log(`\n=== TOTAL: ${pass} pass, ${fail} fail ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("[FATAL]", e.message);
  console.error(e.stack);
  process.exit(2);
});
