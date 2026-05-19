// Headless reproduction of main.js bootServices(): instantiates every
// service the same way the Electron main process does, calls .start()
// on each, prints a snapshot of every service, then stops everything
// cleanly. Exit code 0 means "all services boot, bind, snapshot, stop".

require("dotenv").config();
const path = require("path");

const KeyVault       = require("./src/services/KeyVault");
const AiCache        = require("./src/services/AiCache");
const NewsEngine     = require("./src/services/NewsEngine");
const ProviderRouter = require("./src/services/ProviderRouter");
const BookmapClient  = require("./src/services/BookmapClient");
const DecisionEngine = require("./src/services/DecisionEngine");
const ZmqBridge      = require("./src/services/ZmqBridge");
const Telemetry      = require("./src/services/Telemetry");

const HUB_HOST       = "127.0.0.1";
const ZMQ_REQ_PORT   = +process.env.ZMQ_REQ_PORT  || 5555;
const ZMQ_PUB_PORT   = +process.env.ZMQ_PUB_PORT  || 5556;
const ZMQ_PULL_PORT  = +process.env.ZMQ_PULL_PORT || 5557;
const BOOKMAP_WS_URL = `ws://${HUB_HOST}:${+process.env.BOOKMAP_WS_PORT || 8081}`;

(async () => {
  const t0 = Date.now();
  const tel = new Telemetry({ emit: () => {} });

  const kv = new KeyVault({
    file:               path.join(process.env.TEMP || ".", "oblivious-boot-smoke-kv.dat"),
    passphrase:         process.env.KEYVAULT_PASSPHRASE || "",
    envFallback:        process.env,
    telemetry:          tel,
    allowEnvFallback:   true,
  });
  await kv.load();
  console.log(`[boot] keyvault.source=${kv.source()}`);

  const cache  = new AiCache({ telemetry: tel });
  const news   = new NewsEngine({
    url: "https://nfs.faireconomy.media/ff_calendar_thisweek.csv",
    refreshMinutes: 60, telemetry: tel,
  });
  const router = new ProviderRouter({ keyVault: kv, cache, telemetry: tel });
  const bm     = new BookmapClient({ url: BOOKMAP_WS_URL, telemetry: tel });
  const dec    = new DecisionEngine({
    newsEngine: news, bookmap: bm, providerRouter: router, telemetry: tel,
  });
  const zmq    = new ZmqBridge({
    host: HUB_HOST,
    repPort:  ZMQ_REQ_PORT,
    pubPort:  ZMQ_PUB_PORT,
    pullPort: ZMQ_PULL_PORT,
    decision: dec, newsEngine: news, providerRouter: router, telemetry: tel,
  });

  await news.start();    console.log("[boot] news.start    OK");
  bm.start();            console.log("[boot] bookmap.start OK (async retry)");
  await zmq.start();     console.log("[boot] zmq.start     OK");
  dec.setPublishCommand((p) => zmq.publishCommand(p));

  console.log(`[snap] zmq=      ${JSON.stringify(zmq.snapshot())}`);
  console.log(`[snap] news=     etag=${news.snapshot().etag} upcoming=${news.snapshot().upcoming.length}`);
  console.log(`[snap] router=   ${router.snapshot().providers.map((p) => p.name).join(",")}`);
  console.log(`[snap] decision= ${JSON.stringify(dec.snapshot())}`);
  console.log(`[snap] bookmap=  ${JSON.stringify(bm.snapshot())}`);
  console.log(`[snap] aicache=  ${JSON.stringify(cache.snapshot())}`);

  await new Promise((r) => setTimeout(r, 1500));

  await zmq.stop();      console.log("[stop] zmq      OK");
  news.stop();           console.log("[stop] news     OK");
  bm.stop();             console.log("[stop] bookmap  OK");
  console.log(`[done] elapsed=${Date.now() - t0}ms`);
  process.exit(0);
})().catch((e) => {
  console.error("[FATAL]", e.message);
  console.error(e.stack);
  process.exit(2);
});
