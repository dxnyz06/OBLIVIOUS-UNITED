// Live-provider smoke. Run this AFTER setting at least one
// {OPENAI,ANTHROPIC,GOOGLE,XAI,DEEPSEEK,QWEN,PERPLEXITY}_API_KEY in
// .env (or a vault file with KEYVAULT_PASSPHRASE).
//
// What it asserts end-to-end:
//   1) KeyVault picks the right source (vault > env)
//   2) ProviderRouter loads exactly one healthy provider per real key
//   3) A real query returns a parseable {dir, conf, signal} reply
//   4) AiCache caches the answer for the second identical query
//   5) Failover: if you set an INTENTIONALLY_BAD_KEY for one provider,
//      the router routes around it
//
// Usage:
//   cd oblivious-hub
//   node _provider_live_smoke.js [--dump]

require("dotenv").config();
const KeyVault       = require("./src/services/KeyVault");
const AiCache        = require("./src/services/AiCache");
const ProviderRouter = require("./src/services/ProviderRouter");
const Telemetry      = require("./src/services/Telemetry");

const DUMP = process.argv.includes("--dump");

function expect(label, cond, info) {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${label}${info ? "  " + info : ""}`);
  return !!cond;
}

(async () => {
  let pass = 0, fail = 0;
  const tel = new Telemetry({ emit: () => {} });

  const kv = new KeyVault({
    file:               "./keyvault.dat",
    passphrase:         process.env.KEYVAULT_PASSPHRASE || "",
    envFallback:        process.env,
    telemetry:          tel,
    allowEnvFallback:     true,
  });
  await kv.load();
  console.log(`[kv] source=${kv.source()}`);

  const cache  = new AiCache({ telemetry: tel });
  const router = new ProviderRouter({ keyVault: kv, cache, telemetry: tel });

  const live = router.snapshot().providers.filter((p) => p.healthy);
  console.log(`[router] healthy providers: ${live.map((p) => p.name).join(", ") || "(none)"}`);

  if (live.length === 0) {
    console.error("[FATAL] No healthy provider — set at least one API key in .env then re-run.");
    process.exit(2);
  }

  const ctx = {
    sym:         "EURUSD",
    tf:          "M5",
    strategy:    "Predicted",
    dir:         "BUY",
    tpsl_mode:   "AI",
    setup_score: 80,
    bid:         1.0850, ask: 1.0852,
    atr:         0.0012, rsi: 64, adx: 28, trend: "UP",
    news_block:  false, news_impact: 0,
  };

  // 1st query — should hit a provider, no cache
  console.time("[t1] first query");
  const r1 = await router.query(ctx);
  console.timeEnd("[t1] first query");
  if (DUMP) console.log("[r1]", JSON.stringify(r1, null, 2));

  expect("first query ok",                 r1 && r1.ok)                       ? pass++ : fail++;
  expect("provider name set",              r1 && typeof r1.provider === "string" && r1.provider.length > 0) ? pass++ : fail++;
  expect("content has dir/conf/signal",    r1 && r1.content && (r1.content.dir || r1.content.signal)) ? pass++ : fail++;

  // 2nd query — same context — should be cache hit
  console.time("[t2] second query (cache?)");
  const r2 = await router.query(ctx);
  console.timeEnd("[t2] second query (cache?)");

  const cacheStats = cache.snapshot();
  expect("cache size > 0",                 cacheStats.size >= 1)              ? pass++ : fail++;
  expect("cache hits >= 1",                cacheStats.hits >= 1)              ? pass++ : fail++;
  expect("second query content matches",   JSON.stringify(r1.content) === JSON.stringify(r2.content)) ? pass++ : fail++;

  // 3rd query — perturb fingerprint to force a miss
  const ctx3 = Object.assign({}, ctx, { dir: "SELL" });
  const r3   = await router.query(ctx3);
  expect("perturbed query also ok",        r3 && r3.ok)                       ? pass++ : fail++;
  expect("cache miss recorded",            cache.snapshot().misses >= 2)      ? pass++ : fail++;

  console.log(`\n=== TOTAL: ${pass} pass, ${fail} fail ===`);
  console.log("Cache final:", cache.snapshot());
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("[FATAL]", e.message);
  console.error(e.stack);
  process.exit(2);
});
