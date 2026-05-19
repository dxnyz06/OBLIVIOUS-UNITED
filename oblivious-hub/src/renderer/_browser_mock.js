// Browser-only mock for window.hub (preview / smoke tests).
// In Electron, preload.js runs first and defines window.hub; this file is then a no-op.
(function () {
  if (window.hub) return;

  const subs = {};
  const fire = (ch, payload) => (subs[ch] || []).forEach((fn) => fn(payload));

  const now = Date.now();
  const positions = [
    { ticket: 12345678, symbol: "XAUUSD", side: "BUY",  lots: 0.10, entry: 2384.55, current: 2391.20, pnl: 66.50,
      sl: 2378.00, tp: 2410.00,
      tp1: 2392.95, tp2: 2401.35, tp3: 2407.45, tpmax: 2410.00,
      tp1_hit: false, tp2_hit: false, tp3_hit: false,
      tpsl_stage: "TP1", strategy: "Smart Reversal", provider: "OpenAI" },
    { ticket: 12345679, symbol: "EURUSD", side: "SELL", lots: 0.25, entry: 1.0852, current: 1.0844, pnl: 20.00,
      sl: 1.0875, tp: 1.0810,
      tp1: 1.0838, tp2: 1.0825, tp3: 1.0815, tpmax: 1.0810,
      tp1_hit: false, tp2_hit: false, tp3_hit: false,
      tpsl_stage: "ENTRY", strategy: "Trend Continuation", provider: "Claude" },
    { ticket: 12345680, symbol: "GBPUSD", side: "BUY",  lots: 0.15, entry: 1.2710, current: 1.2698, pnl: -18.00,
      sl: 1.2685, tp: 1.2755,
      tp1: 1.2725, tp2: 1.2740, tp3: 1.2750, tpmax: 1.2755,
      tp1_hit: false, tp2_hit: false, tp3_hit: false,
      tpsl_stage: "TPMAX", strategy: "Liquidity Grab", provider: "Gemini" },
  ];

  const bars = [];
  let p = 2380;
  for (let i = 0; i < 60; i++) {
    const o = p, c = p + (Math.random() - 0.5) * 4;
    const h = Math.max(o, c) + Math.random() * 2;
    const l = Math.min(o, c) - Math.random() * 2;
    bars.push({ t: now - (60 - i) * 14_400_000, o, h, l, c });
    p = c;
  }

  const snap = {
    bridge: {
      repBound: true,
      pullBound: true,
      lastPushTs: now,
      tpsl_mode: "ADAPTIVE",
      lastContext: {
        account_id: "8412377",
        broker: "ICMarkets",
        server: "Live02",
        balance: 12480.55,
        equity: 12544.05,
        free_margin: 11200.10,
        margin_level: 1842.5,
        leverage: 500,
        spread: 1.4,
        sym: "XAUUSD",
        bid: 2391.18,
        ask: 2391.22,
        perf_total: 3480.50,
        perf_today: 124.30,
        perf_open: 68.50,
        perf_winrate: 68.4,
        perf_pf: 2.14,
        perf_maxdd: 4.2,
        perf_winrate_pct: 68.4,
        perf_pf_pct: 71.3,
        perf_maxdd_pct: 4.2,
        positions,
        bars,
      },
    },
    news: {
      upcoming: [
        { time: now + 1_800_000, cur: "USD", event: "Core CPI m/m",            impact: "HIGH" },
        { time: now + 3_600_000, cur: "EUR", event: "ECB Press Conference",    impact: "HIGH" },
        { time: now + 5_400_000, cur: "GBP", event: "Retail Sales m/m",        impact: "MEDIUM" },
        { time: now + 7_200_000, cur: "JPY", event: "Tankan Manufacturing",    impact: "LOW" },
      ],
    },
    providers: {
      providers: [
        // 🔒 healthy + key  → green lock RGB
        { name: "openai",     healthy: true,  hasKey: true,  latencyMs: 142, model: "gpt-4o",        lastError: null },
        { name: "anthropic",  healthy: true,  hasKey: true,  latencyMs: 198, model: "sonnet-4.5",    lastError: null },
        // ⚠️ key present but DOWN → warning lock
        { name: "google",     healthy: false, hasKey: true,  latencyMs: null, model: "2.5-flash",    lastError: "invalid_key" },
        // 🔓 no key → open lock dim
        { name: "perplexity", healthy: false, hasKey: false, latencyMs: null, model: "sonar-pro",    lastError: "no_api_key" },
        { name: "xai",        healthy: false, hasKey: false, latencyMs: null, model: "grok-2",       lastError: "no_api_key" },
        { name: "deepseek",   healthy: true,  hasKey: true,  latencyMs: 145, model: "deepseek-v3",  lastError: null, balance: { total: 4.82, currency: "USD" } },
        { name: "qwen",       healthy: false, hasKey: true,  latencyMs: null, model: "qwen-turbo",   lastError: "rate_limited" },
        { name: "bookmap",    healthy: false, hasKey: false, latencyMs: null, model: "L2 + MBO",     lastError: "no_api_key" },
      ],
    },
    bookmap: {
      connected: true,
      lastSymbol: "XAUUSD",
      events: [
        { ts: now - 3_000, type: "iceberg",    sym: "XAUUSD", side: "bid", price: 2391.10, refills: 5 },
        { ts: now - 9_000, type: "absorption", sym: "XAUUSD", side: "ask", price: 2390.80, qty: 12.5 },
        { ts: now - 12_000, type: "sweep",     sym: "EURUSD", side: "buy", levels: 4, qty: 80 },
        { ts: now - 15_000, type: "exhaustion", sym: "US100", side: "buy" },
        { ts: now - 22_000, type: "trade",     sym: "BTCUSD", side: "buy", price: 67250.5, qty: 0.5 },
      ],
      mboLevels: [
        { price: 2391.18, qty: 250, side: "bid", ts: now - 2_000 },
        { price: 2391.17, qty: 180, side: "bid", ts: now - 2_000 },
        { price: 2391.15, qty: 110, side: "bid", ts: now - 2_000 },
        { price: 2391.22, qty: 200, side: "ask", ts: now - 2_000 },
        { price: 2391.24, qty: 140, side: "ask", ts: now - 2_000 },
        { price: 2391.27, qty:  90, side: "ask", ts: now - 2_000 },
      ],
      decisions: {
        XAUUSD: { type: "decision", symbol: "XAUUSD", ts: now - 200,  of_bias: "bullish", of_confidence: 78, of_signal: "ICEBERG_BID" },
        EURUSD: { type: "decision", symbol: "EURUSD", ts: now - 300,  of_bias: "bearish", of_confidence: 64, of_signal: "ABSORPTION_ASK" },
        GBPUSD: { type: "decision", symbol: "GBPUSD", ts: now - 250,  of_bias: "neutral", of_confidence: 22, of_signal: "none" },
        US100:  { type: "decision", symbol: "US100",  ts: now - 600,  of_bias: "bullish", of_confidence: 55, of_signal: "SWEEP_BUY" },
        US500:  { type: "decision", symbol: "US500",  ts: now - 800,  of_bias: "bullish", of_confidence: 40, of_signal: "DELTA" },
        BTCUSD: { type: "decision", symbol: "BTCUSD", ts: now - 150,  of_bias: "bearish", of_confidence: 71, of_signal: "EXHAUSTION_BUY" },
      },
      decision: { type: "decision", symbol: "XAUUSD", ts: now - 200, of_bias: "bullish", of_confidence: 78, of_signal: "ICEBERG_BID" },
    },
    decision: { trace: { tp: [2393, 2398, 2410], sl: 2378 } },
    secure:   { boot: "OK" },
    logs: [
      { t: now - 1_000, src: "AI",  msg: "Decision conf 0.84 → EXECUTE_ORDER" },
      { t: now - 4_000, src: "EX4", msg: "OrderSend OK ticket 12345678" },
      { t: now - 9_000, src: "MBO", msg: "Iceberg absorption detected" },
      { t: now - 12_000, src: "EA", msg: "Context push 12.4ms" },
    ],
    env: { dev: true },
  };

  window.hub = {
    getSnapshot: async () => JSON.parse(JSON.stringify(snap)),
    on: (ch, fn) => { (subs[ch] = subs[ch] || []).push(fn); },
    win: { minimize: () => {}, maximize: () => {}, close: () => {} },
    cmd: {
      changeTimeframe: async () => ({ ok: true }),
      changeSymbol:    async () => ({ ok: true }),
      closePosition:   async () => ({ ok: true }),
    },
    vault: {
      listProviders: async () => snap.providers.providers.map((p) => p.name),
      testProvider:  async () => ({ ok: true, latencyMs: 150, latency_ms: 150, provider: "openai" }),
      testKey:       async ({ key }) => key && key.length > 8
        ? { ok: true, latencyMs: 142, provider: "openai" }
        : { ok: false, reason: "invalid_key" },
      setKey:        async () => ({ ok: true }),
      testAll:       async () => ({ ok: true }),
      reconnectAll:  async () => ({ ok: true }),
    },
    vps: {
      generateUnlockKey: async () => ({ ok: true, key: "OBV-MOCK-KEY" }),
      rotateUnlockKey:   async () => ({ ok: true }),
      revokeAccess:      async () => ({ ok: true }),
      bindFingerprint:   async () => ({ ok: true }),
      generateRuntime:   async () => ({ ok: true }),
      status:            async () => ({ dev: true, state: "ONLINE", fingerprint: "ab12cd34" }),
    },
  };

  // Simulate live pushes — every channel ticks so the user sees movement
  setTimeout(() => fire("hub:bridge", snap.bridge), 200);

  // bridge (price + positions): every 1.5s
  setInterval(() => {
    snap.bridge.lastContext.equity   += (Math.random() - 0.5) * 5;
    snap.bridge.lastContext.bid      += (Math.random() - 0.5) * 0.4;
    snap.bridge.lastContext.ask       = snap.bridge.lastContext.bid + 0.04;
    snap.bridge.lastContext.positions[0].current = snap.bridge.lastContext.bid;
    snap.bridge.lastContext.positions[0].pnl     =
      (snap.bridge.lastContext.bid - snap.bridge.lastContext.positions[0].entry) * 100 *
      snap.bridge.lastContext.positions[0].lots;
    snap.bridge.lastPushTs = Date.now();
    fire("hub:bridge", snap.bridge);
  }, 1500);

  // news: rotate the upcoming list every 4s so user sees real-time updates
  setInterval(() => {
    const now = Date.now();
    snap.news.upcoming = snap.news.upcoming.map((n, i) => ({
      ...n,
      time: now + (i + 1) * 1_800_000 + (Math.random() * 60_000 - 30_000),
    }));
    fire("hub:news", snap.news);
  }, 4000);

  // bookmap + MBO: every 2s push a new event
  let evtCnt = 0;
  setInterval(() => {
    evtCnt++;
    const events = [
      "ICEBERG BUY @ %p (size %s)",
      "ABSORPTION sell-side @ %p",
      "STOP RUN above %p",
      "LIQUIDITY VOID @ %p",
      "SPOOFING detected @ %p",
    ];
    const tpl = events[evtCnt % events.length];
    const px = snap.bridge.lastContext.bid.toFixed(2);
    snap.bookmap.events.unshift({ t: Date.now(), msg: tpl.replace("%p", px).replace("%s", 100 + (evtCnt % 5) * 80) });
    snap.bookmap.events = snap.bookmap.events.slice(0, 10);
    snap.bookmap.mboLevels.unshift({
      t: Date.now(), sym: "XAUUSD",
      bid: snap.bridge.lastContext.bid, ask: snap.bridge.lastContext.ask,
      size: 100 + (evtCnt % 6) * 40,
      event: ["BID-PULL","ASK-ADD","BID-ADD","ASK-PULL"][evtCnt % 4],
    });
    snap.bookmap.mboLevels = snap.bookmap.mboLevels.slice(0, 8);
    fire("hub:bookmap", snap.bookmap);
  }, 2000);

  // logs: every 3s a smart-log entry
  setInterval(() => {
    const sources = ["AI", "EX4", "MBO", "MT4", "Hub", "EA"];
    const msgs = [
      "Decision conf 0.%c → EXECUTE_ORDER",
      "OrderSend OK ticket %t",
      "Iceberg absorption detected",
      "Context push %ms",
      "Bookmap reconnect attempt %a",
    ];
    const e = {
      t: Date.now(),
      src: sources[Math.floor(Math.random() * sources.length)],
      msg: msgs[Math.floor(Math.random() * msgs.length)]
        .replace("%c", String(60 + Math.floor(Math.random() * 40)))
        .replace("%t", String(12345680 + evtCnt))
        .replace("%ms", `${(8 + Math.random() * 6).toFixed(1)}ms`)
        .replace("%a", String(evtCnt)),
    };
    fire("hub:logs", e);
  }, 3000);
})();
