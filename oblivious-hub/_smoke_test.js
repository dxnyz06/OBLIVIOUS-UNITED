// Smoke test: simulate main.js bootServices() WITHOUT Electron.
// Verifies every service file is requireable, instantiates cleanly,
// and that NewsEngine actually fetches the FF CSV.

const Telemetry      = require("./src/services/Telemetry");
const KeyVault       = require("./src/services/KeyVault");
const AiCache        = require("./src/services/AiCache");
const NewsEngine     = require("./src/services/NewsEngine");
const ProviderRouter = require("./src/services/ProviderRouter");
const BookmapClient  = require("./src/services/BookmapClient");
const DecisionEngine = require("./src/services/DecisionEngine");
const ZmqBridge      = require("./src/services/ZmqBridge");
const SecureBoot     = require("./src/services/SecureBoot");
require("./src/security/password-prompt");

(async () => {
  let pass = 0, fail = 0;
  const ok   = (name) => { pass++; console.log(`  ok  ${name}`); };
  const bad  = (name, e) => { fail++; console.error(`  FAIL ${name} → ${e.message}`); };

  const telemetry = new Telemetry({ emit: () => {} });
  ok("Telemetry");

  const cache = new AiCache({ ttlMs: 1000, telemetry });
  cache.set("a", 1); if (cache.get("a") === 1) ok("AiCache.get/set");
  else bad("AiCache.get/set", new Error("missed"));

  const keyVault = new KeyVault({ inMemory: true, telemetry });
  if (typeof keyVault.unlock === "function") {
    try { await keyVault.unlock("__dev__"); ok("KeyVault.unlock"); }
    catch (e) { bad("KeyVault.unlock", e); }
  } else { ok("KeyVault (no unlock fn)"); }

  const providerRouter = new ProviderRouter({ keyVault, cache, telemetry });
  ok("ProviderRouter");

  const bookmap = new BookmapClient({ url: "ws://127.0.0.1:8081", telemetry });
  ok("BookmapClient");

  const newsEngine = new NewsEngine({
    url: "https://nfs.faireconomy.media/ff_calendar_thisweek.csv",
    refreshMinutes: 5, telemetry,
  });
  try {
    await newsEngine.start();
    const snap = newsEngine.snapshot();
    if (snap.upcoming.length === 10) ok(`NewsEngine.start (10 rows, ${snap.total} total)`);
    else bad("NewsEngine.start", new Error(`got ${snap.upcoming.length} rows`));
    newsEngine.stop();
  } catch (e) { bad("NewsEngine.start", e); }

  const decision = new DecisionEngine({ newsEngine, bookmap, providerRouter, telemetry });
  decision.snapshot(); ok("DecisionEngine.snapshot");

  const zmq = new ZmqBridge({
    host: "127.0.0.1", repPort: 15555, pubPort: 15556, pullPort: 15557,
    decision, newsEngine, providerRouter, telemetry,
  });
  try {
    await zmq.start();
    const snap = zmq.snapshot();
    ok(`ZmqBridge.start (mode=${snap.mode})`);
    await zmq.stop();
    ok("ZmqBridge.stop");
  } catch (e) { bad("ZmqBridge", e); }

  const secure = new SecureBoot({ searchDirs: [], telemetry, askPassword: null });
  const sb = await secure.run();
  if (!sb.ok && sb.reason === "config_not_found") ok("SecureBoot (correctly fails without config)");
  else bad("SecureBoot", new Error(`unexpected ${JSON.stringify(sb)}`));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("CRASH:", e); process.exit(2); });
