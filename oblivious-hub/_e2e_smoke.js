// End-to-end smoke: simulates a real EA over ZMQ and exercises the
// full Hub command lifecycle.  Asserts that all 5 op codes the EA
// supports (EXECUTE_ORDER / HOLD / CANCEL / INVALIDATE / REFINE_TPSL)
// flow through publishCommand and reach the SUB topic with the
// canonical R7 schema (owner, magic, comment, TP ladder, OCO peer,
// corr UUID).

require("dotenv").config();
const zmq            = require("zeromq");
const ZmqBridge      = require("./src/services/ZmqBridge");
const NewsEngine     = require("./src/services/NewsEngine");
const ProviderRouter = require("./src/services/ProviderRouter");
const DecisionEngine = require("./src/services/DecisionEngine");
const AiCache        = require("./src/services/AiCache");
const KeyVault       = require("./src/services/KeyVault");
const BookmapClient  = require("./src/services/BookmapClient");
const Telemetry      = require("./src/services/Telemetry");

const HUB = "127.0.0.1";
const REQ = 5555, PUB = 5556, PULL = 5557;

function parseKv(body) {
  const out = {};
  if (!body) return out;
  if (body.startsWith("{")) try { return JSON.parse(body); } catch (_) {}
  for (const seg of body.split("|")) {
    const eq = seg.indexOf("=");
    if (eq < 0) continue;
    out[seg.slice(0, eq)] = seg.slice(eq + 1);
  }
  return out;
}

function expect(label, cond, info) {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${label}${info ? "  " + info : ""}`);
  return !!cond;
}

(async () => {
  let pass = 0, fail = 0;
  const tel = new Telemetry({ emit: () => {} });

  // ---- HUB BOOT ----
  const fakeRouter = {
    query: async () => ({ ok: true, content: { dir: "BUY", conf: 0.81, signal: "OTE2" } }),
    snapshot: () => ({ providers: [], routing: {} }),
  };
  const fakeNews = { getContextForSymbol: () => ({ block: false, impact: 0 }), snapshot: () => ({}), on: () => {}, start: async () => {}, stop: () => {} };
  const dec = new DecisionEngine({
    newsEngine: fakeNews, bookmap: null, providerRouter: fakeRouter, telemetry: tel,
  });
  const bridge = new ZmqBridge({
    host: HUB, repPort: REQ, pubPort: PUB, pullPort: PULL,
    decision: dec, newsEngine: fakeNews, providerRouter: fakeRouter, telemetry: tel,
  });
  await bridge.start();
  dec.setPublishCommand((p) => bridge.publishCommand(p));
  // Match main.js wiring: PULL→DecisionEngine via the bridge's EventEmitter.
  bridge.on("context_push", (ctx) => dec.onContextPush(ctx));
  console.log("[hub] bridge bound");

  // ---- SIMULATED EA SOCKETS ----
  const eaReq  = new zmq.Request();
  const eaSub  = new zmq.Subscriber();
  const eaPush = new zmq.Push();
  await eaReq .connect(`tcp://${HUB}:${REQ}`);
  await eaSub .connect(`tcp://${HUB}:${PUB}`);
  await eaPush.connect(`tcp://${HUB}:${PULL}`);
  for (const t of ["oblivious.command", "oblivious.heartbeat", "oblivious.news", "oblivious.bookmap"]) {
    eaSub.subscribe(t);
  }

  // Drain SUB into a queue.
  const incoming = [];
  (async () => {
    for await (const [topic, body] of eaSub) {
      incoming.push({ topic: topic.toString(), body: body.toString() });
    }
  })().catch(() => {});

  // Give the SUB a tick to subscribe.
  await new Promise((r) => setTimeout(r, 200));

  // ---- TEST A: REQ heartbeat ----
  await eaReq.send(JSON.stringify({ op: "heartbeat", ts: Math.floor(Date.now() / 1000) }));
  const [hbReply] = await eaReq.receive();
  const hb = parseKv(hbReply.toString());
  expect("REQ heartbeat acked",                    hb.ok === "true" && hb.hub_ts) ? pass++ : fail++;

  // ---- TEST B: REQ news_query ----
  await eaReq.send(JSON.stringify({ op: "news_query", sym: "EURUSD" }));
  const [nReply] = await eaReq.receive();
  const nr = parseKv(nReply.toString());
  expect("REQ news_query has schema",              nr.ok === "true" && "block" in nr && "impact" in nr) ? pass++ : fail++;

  // ---- TEST C: REQ ai_query ----
  await eaReq.send(JSON.stringify({ op: "ai_query", sym: "EURUSD", strategyName: "Predicted" }));
  const [aReply] = await eaReq.receive();
  const ar = parseKv(aReply.toString());
  expect("REQ ai_query routed to provider",        ar.ok === "true") ? pass++ : fail++;

  // ---- TEST D: PUSH context_push triggers Predicted EXECUTE_ORDER ----
  await eaPush.send(JSON.stringify({
    op: "context_push", sym: "EURUSD",
    strategies: { predicted: true }, predicted_setup: true,
    sl_pips: 35, predicted_magic: 778801, ord_type: "LIMIT",
    entry_price: 1.0850, point: 0.0001, tp_r_multiple: 1,
  }));
  // Wait for the AI query + PUB to land in our SUB queue.
  for (let i = 0; i < 50 && !incoming.some((m) => m.topic === "oblivious.command"); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const cmdMsg = incoming.find((m) => m.topic === "oblivious.command");
  const cmd = cmdMsg ? parseKv(cmdMsg.body) : null;
  expect("PUSH context_push -> SUB EXECUTE_ORDER", cmd && cmd.op === "EXECUTE_ORDER") ? pass++ : fail++;
  expect("R7: owner=Predicted",                    cmd && cmd.owner === "Predicted") ? pass++ : fail++;
  expect("R7: magic=778801",                       cmd && +cmd.magic === 778801) ? pass++ : fail++;
  expect("R7: TP ladder tp1/tp2/tp3/tp_max",       cmd && cmd.tp1 && cmd.tp2 && cmd.tp3 && cmd.tp_max) ? pass++ : fail++;
  expect("R7: comment OBLIVIOUS-Predicted-*",      cmd && /^OBLIVIOUS-Predicted-/.test(cmd.comment)) ? pass++ : fail++;
  expect("R7: corr is UUID",                       cmd && /^[0-9a-f-]{36}$/i.test(cmd.corr)) ? pass++ : fail++;
  expect("R7: ord_type=LIMIT",                     cmd && cmd.ord_type === "LIMIT") ? pass++ : fail++;

  // ---- TEST E: command lifecycle direct publish (HOLD/CANCEL/INVALIDATE/REFINE_TPSL) ----
  bridge.publishCommand({ op: "HOLD",        owner: "FVG",       reason: "news_window" });
  bridge.publishCommand({ op: "CANCEL",      owner: "Predicted", ticket: 123456 });
  bridge.publishCommand({ op: "INVALIDATE",  owner: "Predicted", ticket: 123456, reason: "stale_setup" });
  bridge.publishCommand({ op: "REFINE_TPSL", owner: "TPSL_AI",   ticket: 123456, sl: 1.0820, tp1: 1.0890 });
  // Wait for them to round-trip.
  await new Promise((r) => setTimeout(r, 250));

  const ops = incoming.filter((m) => m.topic === "oblivious.command").map((m) => parseKv(m.body).op);
  for (const op of ["HOLD", "CANCEL", "INVALIDATE", "REFINE_TPSL"]) {
    expect(`SUB received op=${op}`, ops.includes(op)) ? pass++ : fail++;
  }

  // ---- TEST F: heartbeat is published periodically (one explicit + ticking timer) ----
  bridge.publishHeartbeat();
  await new Promise((r) => setTimeout(r, 100));
  expect("SUB received oblivious.heartbeat",       incoming.some((m) => m.topic === "oblivious.heartbeat")) ? pass++ : fail++;

  // ---- TEST G: news publish ----
  bridge.publishNews({ block: true, impact: 3, next_event: "USD:NFP", until_ts: 1234567890 });
  await new Promise((r) => setTimeout(r, 100));
  const nMsg = incoming.find((m) => m.topic === "oblivious.news");
  const np = nMsg ? parseKv(nMsg.body) : null;
  expect("SUB received oblivious.news block=1",    np && +np.block === 1 && +np.impact === 3) ? pass++ : fail++;

  // ---- CLEANUP ----
  try { await eaReq.close();  } catch (_) {}
  try { await eaSub.close();  } catch (_) {}
  try { await eaPush.close(); } catch (_) {}
  await bridge.stop();

  console.log(`\n=== TOTAL: ${pass} pass, ${fail} fail ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("[FATAL]", e.message);
  console.error(e.stack);
  process.exit(2);
});
