// OBLIVIOUS AI — renderer-side controller.
//
// Wiring per-panel:
//   ACCOUNT MATRIX     ← bridge.lastContext   (EA context_push fields)
//   PERFORMANCE METRICS← bridge.lastContext   (perf_* fields)
//   MARKET NEWS        ← news.upcoming        (NewsEngine ForexFactory CSV)
//   TRADING CMD CENTER ← bridge.lastContext   (sym/bid/ask/tpsl_mode + Decision trace TP/SL)
//   ACTIVE POSITIONS   ← bridge.lastContext.positions[]  (EA push)
//   BOOKMAP FEED       ← bookmap.events[]     (Bookmap WS)
//   MBO FEED           ← bookmap.mboLevels[]  (Bookmap WS)
//   NEURAL SMART LOG   ← telemetry log stream (hub:logs)
//   AI ENGINE STATUS   ← bridge.tpsl_mode + bookmap.connected + bridge.repBound/pullBound
//   AI PROVIDERS       ← providers.providers[]
//   EDIT API KEY       ← vault:* IPC
//   VPS CONTROL CENTER ← vps:* IPC (DEV ONLY)

const $ = (id) => document.getElementById(id);

const state = {
  bridge:    {},
  news:      {},
  providers: {},
  bookmap:   {},
  decision:  {},
  secure:    {},
  logs:      [],
  env:       { dev: false },
};

// Canonical display name for every supported provider. Used identically by
// the AI PROVIDERS table and the EDIT API KEY dropdown so the user can't
// see two different spellings of the same vendor.
const NICE_PROVIDER = {
  openai:     "OpenAI",
  anthropic:  "Anthropic (Claude)",
  google:     "Google (Gemini)",
  xai:        "xAI (Grok)",
  deepseek:   "DeepSeek",
  qwen:       "Qwen",
  perplexity: "Perplexity",
  bookmap:    "Bookmap (L2 Feed)",
};

// =====================================================================
// Utility
// =====================================================================
function fmtNum(v, d = 2) {
  if (v === null || v === undefined || v === "" || isNaN(+v)) return "—";
  return Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtPct(v) {
  if (v === null || v === undefined || v === "" || isNaN(+v)) return "—";
  return `${(+v).toFixed(2)} %`;
}
function fmtMoney(v) {
  if (v === null || v === undefined || v === "" || isNaN(+v)) return "—";
  const n = +v;
  return `${n >= 0 ? "" : "-"}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtTime(d) {
  if (!d) return "—";
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt.getTime())) return "—";
  const h = String(dt.getHours()).padStart(2, "0");
  const m = String(dt.getMinutes()).padStart(2, "0");
  const s = String(dt.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// =====================================================================
// ACCOUNT MATRIX
// =====================================================================
function paintAccount() {
  const ctx = state.bridge.lastContext || {};
  const repBound = !!state.bridge.repBound;
  const connected = repBound && !!state.bridge.lastPushTs;
  const rows = [
    { k: "Account ID",    v: ctx.account_id     ?? ctx.account ?? "—" },
    { k: "Broker / Server", v: ctx.broker || ctx.server
        ? `${ctx.broker || "—"}${ctx.server ? "-" + ctx.server : ""}` : "—" },
    { k: "Balance",       v: fmtMoney(ctx.balance) },
    { k: "Equity",        v: fmtMoney(ctx.equity) },
    { k: "Free Margin",   v: fmtMoney(ctx.free_margin) },
    { k: "Margin Level",  v: ctx.margin_level != null ? fmtPct(ctx.margin_level) : "—" },
    { k: "Leverage",      v: ctx.leverage ? `1:${ctx.leverage}` : "—" },
    { k: "Spread",        v: ctx.spread != null ? `${ctx.spread} pips` : "—" },
    { k: "Status",        v: connected
        ? `<span class="kv-pill"><span class="dot dot-online"></span><span class="kv-green">CONNECTED</span></span>`
        : `<span class="kv-pill"><span class="dot dot-down"></span><span class="kv-red">DISCONNECTED</span></span>`,
      raw: true },
  ];
  $("account-body").innerHTML = rows.map((r) =>
    `<div class="kv-row"><span class="kv-k">${r.k}</span><span class="kv-v">${r.raw ? r.v : escapeHtml(r.v)}</span></div>`
  ).join("");
}

// =====================================================================
// PERFORMANCE METRICS
// =====================================================================
function paintPerf() {
  const ctx = state.bridge.lastContext || {};
  const metrics = [
    { lbl: "Total Profit", pct: ctx.perf_total_pct,   val: fmtMoney(ctx.perf_total),        cls: "val-green",            barCls: "" },
    { lbl: "Today P&L",    pct: ctx.perf_today_pct,   val: fmtMoney(ctx.perf_today),        cls: (ctx.perf_today >= 0 ? "val-green" : "val-red"),  barCls: (ctx.perf_today < 0 ? "bar-red" : "") },
    { lbl: "Open P&L",     pct: ctx.perf_open_pct,    val: fmtMoney(ctx.perf_open),         cls: (ctx.perf_open >= 0 ? "val-green" : "val-red"),   barCls: (ctx.perf_open < 0 ? "bar-red" : "") },
    { lbl: "Total Trades", pct: ctx.perf_trades_pct,  val: ctx.perf_trades ?? "—",          cls: "",                     barCls: "bar-blue" },
    { lbl: "Win Rate",     pct: ctx.perf_winrate_pct ?? ctx.perf_winrate, val: ctx.perf_winrate != null ? `${(+ctx.perf_winrate).toFixed(2)} %` : "—", cls: "val-green", barCls: "" },
    { lbl: "Max Drawdown", pct: ctx.perf_dd_pct ?? ctx.perf_maxdd_pct ?? ctx.perf_maxdd, val: (ctx.perf_max_dd != null || ctx.perf_maxdd != null) ? fmtMoney(-Math.abs(ctx.perf_max_dd ?? ctx.perf_maxdd)) : (ctx.perf_maxdd_pct != null ? `${(+ctx.perf_maxdd_pct).toFixed(2)} %` : "—"), cls: "val-red", barCls: "bar-red" },
    { lbl: "Profit Factor",pct: ctx.perf_pf_pct,      val: ctx.perf_pf != null ? (+ctx.perf_pf).toFixed(2) : "—", cls: "", barCls: "" },
  ];
  $("perf-body").innerHTML = metrics.map((m) => {
    const pctNum = (m.pct != null && !isNaN(+m.pct)) ? Math.max(0, Math.min(100, +m.pct)) : 0;
    return `
      <div class="perf-row">
        <div class="perf-lbl">${m.lbl}</div>
        <div class="perf-bar ${m.barCls}"><span style="width:${pctNum}%"></span></div>
        <div class="perf-val ${m.cls}">${m.val}</div>
      </div>`;
  }).join("");
}

// =====================================================================
// MARKET NEWS
// =====================================================================
function paintNews() {
  // NewsEngine snapshot is implementation-dependent — try every shape.
  const raw = state.news;
  let items = [];
  if (Array.isArray(raw))                items = raw;
  else if (Array.isArray(raw?.upcoming)) items = raw.upcoming;
  else if (Array.isArray(raw?.events))   items = raw.events;
  else if (Array.isArray(raw?.next))     items = raw.next;
  else if (Array.isArray(raw?.list))     items = raw.list;
  else if (Array.isArray(raw?.items))    items = raw.items;
  else if (Array.isArray(raw?.calendar)) items = raw.calendar;
  else if (raw && typeof raw === "object") {
    // Last-resort: pick the first array-valued property
    const arrKey = Object.keys(raw).find((k) => Array.isArray(raw[k]));
    if (arrKey) items = raw[arrKey];
  }

  // Strategy: prefer UPCOMING events (closest first), but if there aren't
  // 10 upcoming, fill the remaining slots with the most-recent PAST events
  // so the panel always shows 10 rows and the user has macro context.
  const nowTs = Date.now();
  const all = (items || [])
    .map((e) => ({
      ...e,
      _t: Number(e.time ?? e.ts ?? e.t ?? e.scheduled ?? e.when ?? 0),
    }))
    .filter((e) => Number.isFinite(e._t));
  const upcoming = all
    .filter((e) => e._t >= nowTs - 60_000) // 1-min grace for "just released"
    .sort((a, b) => a._t - b._t);
  const past = all
    .filter((e) => e._t < nowTs - 60_000)
    .sort((a, b) => b._t - a._t); // most recent past first
  // Newest at top → upcoming first (chronological), then past most-recent.
  items = [...upcoming, ...past].slice(0, 10);

  if (!items.length) {
    // Surface diagnostics so the user can immediately see what shape
    // the NewsEngine is sending if the panel stays empty.
    if (raw && typeof raw === "object") {
      console.warn("[news] empty list — payload keys:", Object.keys(raw),
                   "preview:", JSON.stringify(raw).slice(0, 200));
    }
    $("news-body").innerHTML = `<tr class="empty-row"><td colspan="4">awaiting ForexFactory feed…</td></tr>`;
    return;
  }
  $("news-body").innerHTML = items.map((e) => {
    const impact = String(e.impact || e.severity || "LOW").toUpperCase();
    const cur    = e.country || e.cur || e.currency || e.ccy || e.cc || "";
    const title  = e.title   || e.event || e.name    || e.headline || e.label || "";
    return `<tr>
      <td>${fmtTime(e._t)}</td>
      <td>${escapeHtml(cur)}</td>
      <td>${escapeHtml(title)}</td>
      <td><span class="impact-pill impact-${impact}">${impact}</span></td>
    </tr>`;
  }).join("");
}

// =====================================================================
// TRADING COMMAND CENTER (chart) — minimal live price plot from context_push.
// We don't have OHLC backing service; we plot the rolling bid stream as a
// fan-of-ticks for visual feedback. TP/SL levels overlaid from Decision trace.
// =====================================================================
const priceBuffer = []; // {t, p}
function pushPriceTick(price) {
  if (price == null || isNaN(+price)) return;
  priceBuffer.push({ t: Date.now(), p: +price });
  if (priceBuffer.length > 720) priceBuffer.shift();
}

/**
 * Aggregate raw ticks into proper OHLC bars so lightweight-charts can
 * draw candles instead of single-point lines.
 * @param {{t:number,p:number}[]} ticks
 * @param {number} secPerBar  bar width in seconds (1, 5, 60, …)
 * @returns {{t:number,o:number,h:number,l:number,c:number}[]}
 */
function aggregateTicksToBars(ticks, secPerBar) {
  if (!ticks || !ticks.length) return [];
  const w = (secPerBar || 1) * 1000;
  const bars = new Map();
  for (const tk of ticks) {
    if (!tk || tk.p == null || !isFinite(+tk.p)) continue;
    const bucket = Math.floor(tk.t / w) * w;
    const p = +tk.p;
    let b = bars.get(bucket);
    if (!b) {
      b = { t: bucket, o: p, h: p, l: p, c: p };
      bars.set(bucket, b);
    } else {
      if (p > b.h) b.h = p;
      if (p < b.l) b.l = p;
      b.c = p;
    }
  }
  return [...bars.values()].sort((a, b) => a.t - b.t);
}
function tfToSec(tf) {
  // For the synthetic tick-driven view we use SHORTER bar widths than
  // the EA timeframe so candles actually appear within seconds, not
  // minutes. (The EA OHLC stream — if present — bypasses this entirely.)
  switch ((tf || "").toLowerCase()) {
    case "1m":  return 5;     // 5-second bars
    case "5m":  return 15;    // 15-second
    case "15m": return 30;    // 30-second
    case "1h":  return 60;    // 1-min
    case "4h":  return 300;   // 5-min
    case "1d":  return 900;   // 15-min
    default:    return 5;
  }
}

// =====================================================================
// TRADING COMMAND CENTER (lightweight-charts)
// =====================================================================
let _chartApi = null;       // memoised wrapper from chart.js
let _lastBarsKey = "";      // invalidate setData only on real bar churn

function _lazyChart() {
  if (_chartApi) return _chartApi;
  const host = $("price-chart");
  if (!host || !window.OB_CHART) return null;
  _chartApi = window.OB_CHART.create(host);
  // Continuous size sync: a ResizeObserver triggers chart.resize() any
  // time the panel changes (window maximise, sidebar collapse, F11, …).
  // This is the canonical fix for "chart cropped" scenarios where the
  // canvas size lags behind the layout.
  const ro = new ResizeObserver(() => {
    window.OB_CHART.forceResize(_chartApi, host);
  });
  ro.observe(host);
  if (host.parentElement) ro.observe(host.parentElement);
  // First-paint resize (the panel's height is 0 before flexbox resolves)
  window.OB_CHART.forceResize(_chartApi, host);
  setTimeout(() => window.OB_CHART.forceResize(_chartApi, host), 50);
  setTimeout(() => window.OB_CHART.forceResize(_chartApi, host), 250);
  setTimeout(() => window.OB_CHART.forceResize(_chartApi, host), 800);
  window.addEventListener("resize", () => window.OB_CHART.forceResize(_chartApi, host));
  return _chartApi;
}

function _eaLevelsFor(ctx, sym) {
  const positions = Array.isArray(ctx.positions) ? ctx.positions : [];
  const symPositions = positions.filter((p) =>
    String(p.sym || p.symbol || "").toUpperCase() === String(sym).toUpperCase()
  );
  // Coarse symbol→USD factor for the label P&L.
  const usdFactor = (s) => {
    const u = String(s || "").toUpperCase();
    if (u.startsWith("XAU")) return 100;
    if (u.startsWith("US"))  return 1;
    if (u.startsWith("BTC")) return 1;
    return 100000;
  };
  const out = [];
  symPositions.forEach((p) => {
    const entry = +(p.entry ?? p.open_price);
    const sl    = +p.sl;
    const tp    = +p.tp;
    const lots  = +(p.lots ?? p.volume ?? 0);
    const side  = (p.side || (p.type === 0 ? "BUY" : "SELL") || "BUY").toUpperCase();
    const dir   = side === "BUY" ? 1 : -1;
    const tk    = p.ticket;
    const span  = (!isNaN(entry) && !isNaN(tp)) ? (tp - entry) : 0;
    const tp1   = (p.tp1   != null && !isNaN(+p.tp1))   ? +p.tp1   : entry + span * 0.33;
    const tp2   = (p.tp2   != null && !isNaN(+p.tp2))   ? +p.tp2   : entry + span * 0.66;
    const tp3   = (p.tp3   != null && !isNaN(+p.tp3))   ? +p.tp3   : entry + span * 0.90;
    const tpmax = (p.tpmax != null && !isNaN(+p.tpmax)) ? +p.tpmax : tp;
    const factor = usdFactor(p.sym || p.symbol);
    const pnlAt = (lvl) => (lvl - entry) * dir * lots * factor;
    const usdLbl = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}USD`;

    if (!isNaN(entry)) out.push({ k: "ENTRY", price: entry, lots, ticket: tk, title: "Entry",     usdLabel: usdLbl(0),         hit: false });
    if (!isNaN(sl))    out.push({ k: "SL",    price: sl,    lots, ticket: tk, title: "Stop Loss", usdLabel: usdLbl(pnlAt(sl)), hit: false });
    if (!isNaN(tp1))   out.push({ k: "TP1",   price: tp1,   lots, ticket: tk, title: "TP1",       usdLabel: usdLbl(pnlAt(tp1)), hit: !!p.tp1_hit });
    if (!isNaN(tp2))   out.push({ k: "TP2",   price: tp2,   lots, ticket: tk, title: "TP2",       usdLabel: usdLbl(pnlAt(tp2)), hit: !!p.tp2_hit });
    if (!isNaN(tp3))   out.push({ k: "TP3",   price: tp3,   lots, ticket: tk, title: "TP3",       usdLabel: usdLbl(pnlAt(tp3)), hit: !!p.tp3_hit });
    if (!isNaN(tpmax)) out.push({ k: "TPMAX", price: tpmax, lots, ticket: tk, title: "TPMAX",     usdLabel: usdLbl(pnlAt(tpmax)), hit: false });
  });
  return out;
}

// Synthetic-candle fallback: when the EA hasn't pushed any bar/bid for
// more than 6s the chart would otherwise stay empty. We seed it with a
// rolling random-walk sample so the user can at least see the chart frame
// rendering — it auto-replaces real EA data the moment ZMQ starts pushing.
let _synthBars = null;
let _lastEaPushTs = Date.now();
function _ensureSynthBars(sym) {
  if (_synthBars && _synthBars._sym === sym) return _synthBars;
  const now = Date.now();
  const base = sym?.startsWith("XAU") ? 2390
            : sym === "EURUSD" ? 1.085
            : sym === "GBPUSD" ? 1.270
            : sym === "US100"  ? 18_500
            : sym === "US500"  ? 5_400
            : sym === "BTCUSD" ? 60_000
            : 100;
  const out = [];
  let p = base;
  for (let i = 60; i > 0; i--) {
    const drift = (Math.random() - 0.5) * (base * 0.003);
    const o = p, c = p + drift;
    const h = Math.max(o, c) + Math.random() * (base * 0.001);
    const l = Math.min(o, c) - Math.random() * (base * 0.001);
    out.push({ t: now - i * 14_400_000, o, h, l, c });
    p = c;
  }
  _synthBars = out;
  _synthBars._sym = sym;
  return _synthBars;
}
function _tickSynth(sym) {
  const bars = _ensureSynthBars(sym);
  const last = bars[bars.length - 1];
  // Only refresh the live bar so the chart looks alive
  const drift = (Math.random() - 0.5) * (Math.abs(last.c) * 0.0005 || 0.5);
  last.c = +(last.c + drift);
  last.h = Math.max(last.h, last.c);
  last.l = Math.min(last.l, last.c);
  last.t = Date.now();
  return bars;
}

function paintChart() {
  const ctx = state.bridge.lastContext || {};
  const sym = ctx.sym || ctx.symbol || $("symbol-select")?.value || "XAUUSD";
  const tf  = document.querySelector(".tf-btn.active")?.dataset.tf || "4h";

  // Accept a broad set of price-field names so any EA / mock / smoke
  // payload feeds the chart.
  const livePx = +(
    ctx.bid ?? ctx.last_price ?? ctx.price ?? ctx.last ??
    ctx.close ?? ctx.c ?? ctx.ask ?? NaN
  );
  if (!isNaN(livePx)) pushPriceTick(livePx);

  // ── BOOKMAP FALLBACK FEED ──────────────────────────────────────────
  // When the EA bridge is offline (EX4 BRIDGE = DISCONNECTED) the chart
  // would normally freeze. Bookmap WS however IS streaming live BBO /
  // trade data for the same symbol. Mid-price from the latest dom
  // snapshot keeps the chart alive in real time.
  if (isNaN(livePx)) {
    const bm = state.bookmap || {};
    const targetSym = (sym || "").toUpperCase();
    const snap = bm.perSymbolSnapshots && (bm.perSymbolSnapshots[targetSym]
                                        || bm.perSymbolSnapshots[bm.lastSymbol]);
    let bmPx = null;
    if (snap) {
      if (snap.last_price != null && !isNaN(+snap.last_price)) {
        bmPx = +snap.last_price;
      } else if (snap.top_bid != null && snap.top_ask != null) {
        bmPx = (+snap.top_bid + +snap.top_ask) / 2;
      } else if (snap.dom && snap.dom.bids && snap.dom.asks &&
                 snap.dom.bids.length && snap.dom.asks.length) {
        bmPx = (+snap.dom.bids[0].p + +snap.dom.asks[0].p) / 2;
      }
    }
    // Last resort: pull a price from the latest raw event for this symbol
    if (bmPx == null && Array.isArray(bm.events)) {
      for (const ev of bm.events) {
        if (!ev || !ev.price) continue;
        if (ev.sym && targetSym && ev.sym.toUpperCase() !== targetSym &&
            ev.sym.toUpperCase() !== (bm.lastSymbol || "").toUpperCase()) continue;
        bmPx = +ev.price;
        break;
      }
    }
    if (bmPx != null && !isNaN(bmPx) && bmPx > 0) pushPriceTick(bmPx);
  }

  // (the chart-headline overlay is hidden by CSS — kept for backwards compat.)
  const o = ctx.o ?? ctx.open  ?? "—";
  const h = ctx.h ?? ctx.high  ?? "—";
  const l = ctx.l ?? ctx.low   ?? "—";
  const c = ctx.c ?? ctx.bid   ?? "—";
  const headline = $("chart-headline");
  if (headline) {
    headline.innerHTML =
      `<span class="ch-sym">${escapeHtml(sym)} · ${escapeHtml(tf)}</span>` +
      `<span class="ch-ohlc">O ${o} H ${h} L ${l} C ${c}</span>`;
  }

  const chartApi = _lazyChart();
  const status   = $("chart-status");
  if (!chartApi) {
    if (status) {
      status.style.display = "block";
      status.innerHTML = window.LightweightCharts
        ? "chart container not ready — try resizing the window"
        : "lightweight-charts vendor file missing.<br/>Reinstall: <code>oblivious-hub/src/renderer/vendor/lightweight-charts.js</code>";
    }
    return;
  }

  // Defensive resize — the lib's autoSize sometimes lags after a window
  // maximise / restore on Electron. Calling resize on every paint guarantees
  // the canvas always matches the host's current dimensions.
  const host = $("price-chart");
  if (host && window.OB_CHART) window.OB_CHART.forceResize(chartApi, host);

  // Hue tick — always cycle so the candle wick & axes track the master clock.
  const hue = window.OB_CHART.readNeonHue();
  chartApi.tickHue(hue);

  // Bars feed: prefer EA-pushed OHLC (ctx.bars / candles / ohlc), else
  // synth from the live price buffer (one mini-bar per tick), else fall
  // back to a synthetic random-walk so the chart frame is never empty.
  const eaBars = (Array.isArray(ctx.bars) && ctx.bars.length && ctx.bars)
              || (Array.isArray(ctx.candles) && ctx.candles.length && ctx.candles)
              || (Array.isArray(ctx.ohlc)    && ctx.ohlc.length    && ctx.ohlc)
              || null;
  if (eaBars || !isNaN(livePx)) _lastEaPushTs = Date.now();

  let bars;
  if (eaBars) {
    bars = eaBars;
  } else if (priceBuffer.length >= 2) {
    // Aggregate raw ticks into proper OHLC bars (per the active TF) so
    // lightweight-charts can actually render candles instead of single
    // points → was the "only lines, no candle" bug.
    bars = aggregateTicksToBars(priceBuffer, tfToSec(tf));
  } else if (Date.now() - _lastEaPushTs > 6000) {
    // EA silent for 6+s → start synthetic feed (clearly marked in status)
    bars = _tickSynth(sym);
    if (status) {
      status.style.display = "block";
      status.style.background = "rgba(0,0,0,0.55)";
      status.style.padding = "3px 8px";
      status.style.fontSize = "10px";
      status.innerHTML = "DEMO MODE — EA not pushing OHLC data";
    }
  } else {
    bars = [];
  }
  if (eaBars || priceBuffer.length >= 2) {
    if (status) status.style.display = "none";
  }
  if (!bars.length) {
    if (status) {
      status.style.display = "block";
      status.innerHTML = "awaiting EA context push…";
    }
    chartApi.setLevels([]);
    return;
  }
  if (status) status.style.display = "none";

  const barsKey = `${bars.length}:${bars[0]?.t}:${bars[bars.length - 1]?.t}`;
  if (barsKey !== _lastBarsKey) {
    chartApi.setBars(bars);
    _lastBarsKey = barsKey;
  } else {
    // Just update the latest bar (real-time tick) — minimal repaint
    const last = bars[bars.length - 1];
    if (last && chartApi.candle) {
      chartApi.candle.update({
        time:  Math.floor(Number(last.t || last.time) / 1000),
        open:  Number(last.o ?? last.open),
        high:  Number(last.h ?? last.high),
        low:   Number(last.l ?? last.low),
        close: Number(last.c ?? last.close),
      });
    }
  }

  // EA TPSL levels — convert hue→rgb hex (lightweight-charts can't parse hsl())
  const _h2r = (hh, ll) => {
    const x = ((hh % 360) + 360) % 360 / 360;
    const s = 1, l = Math.max(0, Math.min(1, ll / 100));
    if (s === 0) { const v = Math.round(l * 255); return `rgb(${v},${v},${v})`; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p; };
    const r = Math.round(f(x + 1/3) * 255);
    const g = Math.round(f(x)       * 255);
    const b = Math.round(f(x - 1/3) * 255);
    return `rgb(${r},${g},${b})`;
  };
  const levels = _eaLevelsFor(ctx, sym).map((lv) => ({
    ...lv,
    color:
      lv.k === "SL"
        ? "#ff3b3b"
        : _h2r(hue, lv.k === "TPMAX" ? 65 : lv.k === "ENTRY" ? 60 : 55),
  }));
  chartApi.setLevels(levels);

  // Native HTML overlay no longer used — labels live on the chart now.
  $("chart-levels").innerHTML = "";
}



// =====================================================================
// ACTIVE POSITIONS
// =====================================================================
function paintPositions() {
  const ctx = state.bridge.lastContext || {};
  const positions = Array.isArray(ctx.positions) ? ctx.positions : [];
  if (!positions.length) {
    $("positions-body").innerHTML =
      `<tr class="empty-row"><td colspan="12">No active positions reported by EA</td></tr>`;
    return;
  }
  $("positions-body").innerHTML = positions.map((p) => {
    const side = (p.side || (p.type === 0 ? "BUY" : "SELL") || "").toUpperCase();
    const pnl  = +p.pnl;
    const stage = String(p.tpsl_stage || p.stage || "ENTRY").toUpperCase().replace(/\s+/g, "");
    return `<tr>
      <td>${escapeHtml(p.ticket)}</td>
      <td>${escapeHtml(p.sym || p.symbol)}</td>
      <td><span class="side-${side}">${side}</span></td>
      <td>${escapeHtml(p.lots ?? p.volume)}</td>
      <td>${fmtNum(p.entry || p.open_price)}</td>
      <td>${fmtNum(p.current || p.price)}</td>
      <td class="${pnl >= 0 ? "pnl-pos" : "pnl-neg"}">${fmtMoney(p.pnl)}</td>
      <td>SL: ${fmtNum(p.sl)} / TP: ${fmtNum(p.tp)}</td>
      <td><span class="tpsl-pill tpsl-${stage}">${stage}</span></td>
      <td>${escapeHtml(p.strategy || "—")}</td>
      <td>${escapeHtml(p.provider || "—")}</td>
      <td><button class="btn-close-row" data-ticket="${p.ticket}" data-sym="${p.sym || p.symbol || ""}" data-magic="${p.magic || 0}">CLOSE</button></td>
    </tr>`;
  }).join("");
}

// =====================================================================
// BOOKMAP / MBO / SMART LOG feeds
// =====================================================================
function eventLabel(ev) {
  // Plain string events (mock & some EA pushes)
  if (typeof ev === "string") return ev;
  if (ev.msg) return ev.msg;
  const sym = ev.sym || ev.symbol || "";
  const px = (v) => {
    if (typeof v !== "number" || !isFinite(v)) return v ?? "?";
    const a = Math.abs(v);
    if (a < 2)      return fmtNum(v, 5);
    if (a < 200)    return fmtNum(v, 3);
    if (a < 10000)  return fmtNum(v, 2);
    return fmtNum(v, 1);
  };
  const qty = (q) => {
    if (q == null || isNaN(+q)) return "?";
    const v = +q;
    if (v >= 1000)  return (v / 1000).toFixed(1) + "k";
    if (v >= 10)    return v.toFixed(0);
    return v.toFixed(2);
  };
  switch (ev.type) {
    // Raw depth: side ▸ qty @ price (cleaner than "ASK depth 7@7681")
    case "depth":      return `${sym} ${(ev.side || "").toUpperCase()} ${qty(ev.qty)} @ ${px(ev.price)}`;
    case "trade":      return `${sym} ${(ev.side === "buy" ? "▲ BUY" : "▼ SELL")} ${qty(ev.qty)} @ ${px(ev.price)}`;
    case "mbo": {
      const act = (ev.action || "upd").toUpperCase();
      return `${sym} ${act} ${(ev.side || "").toUpperCase()} ${qty(ev.qty)} @ ${px(ev.price)}` +
             (ev.order_id ? ` #${String(ev.order_id).slice(-6)}` : "");
    }
    // ── Stream-2 derived "signal" events (the professional view) ──
    case "iceberg":    return `${sym} ICEBERG ${(ev.side || "").toUpperCase()} @ ${px(ev.price)}` +
                              ` ×${ev.refills ?? ev.repetitions ?? "?"}` +
                              (ev.hidden_estimated_size ? ` (hidden≈${qty(ev.hidden_estimated_size)})` : "");
    case "absorption": return `${sym} ABSORPTION ${(ev.side || "").toUpperCase()} ${qty(ev.qty || ev.absorbed_volume)} lots @ ${px(ev.price)}` +
                              (ev.strength != null ? ` · str ${(+ev.strength * 100).toFixed(0)}%` : "");
    case "sweep":      return `${sym} SWEEP ${(ev.direction || ev.side || "").toUpperCase()} ${ev.levels ?? ev.swept_levels ?? "?"}L · ${qty(ev.qty || ev.total_volume)}`;
    case "stop_run":   return `${sym} STOP RUN ${(ev.side || "").toUpperCase()} @ ${px(ev.price)} ×${ev.cluster_size ?? "?"}`;
    case "exhaustion": return `${sym} EXHAUSTION ${(ev.side || "").toUpperCase()}` +
                              (ev.exhaustion_score != null ? ` · ${(+ev.exhaustion_score * 100).toFixed(0)}%` : "");
    case "delta":      return `${sym} Δ ${ev.delta >= 0 ? "+" : ""}${ev.delta ?? "?"}`;
    case "imbalance":  return `${sym} IMBALANCE ${(ev.side || "").toUpperCase()} ${ev.ratio ? `${(+ev.ratio * 100).toFixed(0)}%` : ""} @ ${px(ev.price)}`;
    case "heatmap":    return `${sym} heatmap ${ev.intensity > 0 ? "↑" : "↓"}`;
    case "event":      return ev.text || "(event)";
    default:           return ev.text || ev.type;
  }
}
// Signal events deserve a colored tag so the user spots them at a glance.
function eventTag(ev) {
  if (!ev || typeof ev !== "object") return "";
  switch (ev.type) {
    case "iceberg":    return `<span class="sig-tag sig-iceberg">ICE</span>`;
    case "absorption": return `<span class="sig-tag sig-absorption">ABS</span>`;
    case "sweep":      return `<span class="sig-tag sig-sweep">SWP</span>`;
    case "stop_run":   return `<span class="sig-tag sig-sweep">STP</span>`;
    case "exhaustion": return `<span class="sig-tag sig-exhaustion">EXH</span>`;
    case "trade":      return ev.side === "buy"
                              ? `<span class="sig-tag sig-buy">BUY</span>`
                              : `<span class="sig-tag sig-sell">SELL</span>`;
    case "depth":      return `<span class="sig-tag sig-raw">DOM</span>`;
    case "mbo":        return `<span class="sig-tag sig-raw">MBO</span>`;
    default:           return "";
  }
}
function paintBookmap() {
  const events = state.bookmap.events || [];
  const bm = state.bookmap || {};
  // Prefer signal events at the top, then raw — gives a professional
  // "events of interest" feed even when the tape is busy.
  const SIGNAL = new Set(["iceberg", "absorption", "sweep", "exhaustion", "imbalance"]);
  const signals = events.filter((e) => SIGNAL.has(e.type));
  const raws    = events.filter((e) => !SIGNAL.has(e.type));
  const ordered = [...signals, ...raws].slice(0, 14);

  if (!ordered.length) {
    if (bm.connected) {
      // Bridge connected (heartbeats arriving) but no depth/trade yet.
      // 99% of the time this means Bookmap hasn't enabled MBP/Depth on
      // the chart — surface the actionable hint right in the panel.
      const sym = bm.lastSymbol || bm.symbol || "—";
      const ago = bm.lastUpdateTs ? Math.round((Date.now() - bm.lastUpdateTs) / 1000) : null;
      $("bookmap-body").innerHTML =
        `<tr><td>${fmtTime(bm.lastUpdateTs || Date.now())}</td>` +
        `<td><span class="bias-rgb">● LIVE</span> ${escapeHtml(sym)} — bridge connected, no depth events yet` +
        (ago !== null ? ` (heartbeat ${ago}s ago)` : "") + `</td></tr>` +
        `<tr><td>—</td><td class="dim">hint: in Bookmap right-click chart → enable <b>Show Bookmap (Heatmap)</b> + <b>MBP Depth</b></td></tr>`;
    } else {
      $("bookmap-body").innerHTML = `<tr class="empty-row"><td colspan="2">waiting for Bookmap WS :8081 — load <code>oblivious_bridge.py</code> in Bookmap</td></tr>`;
    }
    return;
  }
  $("bookmap-body").innerHTML = ordered.map((ev) => {
    const tag = eventTag(ev);
    const label = eventLabel(ev);
    return `<tr><td>${fmtTime(ev.ts || ev.t)}</td><td>${tag} ${escapeHtml(label)}</td></tr>`;
  }).join("");
}
// =====================================================================
// OF HEATMAP STRIP — 6 asset chips below the titlebar
// =====================================================================
// All chips share the SAME master RGB hue (no per-asset offset) —
// differentiation is by SYMBOL label, BIAS ARROW (▲▼●) and fill
// intensity scaled on of_confidence. Click is purely cosmetic
// (toggles `is-active`) — it does NOT change the chart symbol or
// send any ZMQ command, per user spec ("solo estetica").
const OF_ASSETS = ["XAUUSD", "EURUSD", "GBPUSD", "US100", "US500", "BTCUSD"];
function paintHeatmap() {
  const bm = state.bookmap || {};
  const decisions = bm.decisions || {};
  const nowMs = Date.now();
  for (const sym of OF_ASSETS) {
    const chip = document.querySelector(`.of-chip[data-sym="${sym}"]`);
    if (!chip) continue;
    const dec = decisions[sym];
    const stale = !dec || (dec.ts && nowMs - dec.ts > 8_000);
    chip.classList.toggle("is-stale", stale);
    const arrowEl = chip.querySelector(".of-arrow");
    const confEl  = chip.querySelector(".of-conf");
    if (!dec) {
      chip.style.setProperty("--of-conf", 0);
      chip.dataset.bias = "neutral";
      if (arrowEl) arrowEl.textContent = "●";
      if (confEl)  confEl.textContent  = "—";
      chip.title = `${sym} — no orderflow data yet`;
      continue;
    }
    chip.style.setProperty("--of-conf", Math.max(0, Math.min(100, +dec.of_confidence || 0)));
    chip.dataset.bias = dec.of_bias || "neutral";
    if (arrowEl) arrowEl.textContent = dec.of_bias === "bullish" ? "▲"
                                     : dec.of_bias === "bearish" ? "▼" : "●";
    if (confEl)  confEl.textContent  = `${dec.of_confidence ?? 0}%`;
    chip.title = `${sym} — ${dec.of_bias?.toUpperCase() || "—"} · conf ${dec.of_confidence ?? 0}% · signal ${dec.of_signal || "—"}`;
  }
}

function paintMbo() {
  const bm = state.bookmap || {};
  const sym = bm.lastSymbol || bm.symbol || ($("symbol-select")?.value || "");
  const snap2 = (bm.perSymbolSnapshots && bm.perSymbolSnapshots[sym]) || null;
  const dec   = (bm.decisions && bm.decisions[sym]) || bm.decision || null;

  let bids = [], asks = [];
  if (snap2 && snap2.dom) {
    bids = (snap2.dom.bids || []).map((l) => ({ price: l.p, qty: l.q }));
    asks = (snap2.dom.asks || []).map((l) => ({ price: l.p, qty: l.q }));
  } else {
    // Fallback to the legacy mboLevels (folded depth)
    const levels = bm.mboLevels || [];
    bids = levels.filter((l) => l.side === "bid")
                 .sort((a, b) => b.price - a.price)
                 .map((l) => ({ price: l.price, qty: l.qty }));
    asks = levels.filter((l) => l.side === "ask")
                 .sort((a, b) => a.price - b.price)
                 .map((l) => ({ price: l.price, qty: l.qty }));
  }

  if (!bids.length && !asks.length) {
    $("mbo-body").innerHTML = `<tr class="empty-row"><td colspan="5">awaiting MBO levels</td></tr>`;
    return;
  }

  // Compute max quantity to draw a relative-volume bar background.
  const maxQ = Math.max(
    1,
    ...bids.map((l) => +l.qty || 0),
    ...asks.map((l) => +l.qty || 0)
  );
  const decFmt = (snap2?.top_ask && Math.abs(snap2.top_ask) > 200) ? 2
              : (snap2?.top_ask && Math.abs(snap2.top_ask) > 2)    ? 3 : 5;
  const bar = (q, klass) => {
    const pct = Math.max(2, Math.min(100, Math.round(((+q || 0) / maxQ) * 100)));
    return `<span class="dom-bar ${klass}" style="width:${pct}%"></span>`;
  };

  const rows = [];
  // Header: per-symbol decision chip — show the FULL reasoning chain so
  // the bias is auditable in real time (bias + confidence + primary
  // signal + raw orderflow scores like absorption / sweep / delta).
  if (dec) {
    const conf = +dec.of_confidence || 0;
    const bias = String(dec.of_bias || "neutral").toUpperCase();
    const sig  = String(dec.of_signal || "—");
    const reasons = [];
    if (dec.of_absorption  != null) reasons.push(`abs ${(+dec.of_absorption  * 100).toFixed(0)}%`);
    if (dec.of_sweep_score != null) reasons.push(`sweep ${(+dec.of_sweep_score * 100).toFixed(0)}%`);
    if (dec.of_delta_norm  != null) reasons.push(`Δ ${(+dec.of_delta_norm  * 100).toFixed(0)}%`);
    if (dec.of_imbalance   != null) reasons.push(`imb ${(+dec.of_imbalance  * 100).toFixed(0)}%`);
    if (dec.of_iceberg_pressure != null) reasons.push(`ice ${(+dec.of_iceberg_pressure * 100).toFixed(0)}%`);
    const reasonsHtml = reasons.length
      ? ` <span class="dim">| ${escapeHtml(reasons.join(" · "))}</span>` : "";
    rows.push(`<tr class="mbo-decision-row"><td colspan="5">
      <span class="dim">DECISION:</span>
      <span class="bias-rgb">${escapeHtml(bias)}</span>
      · CONF <span class="bias-rgb">${conf}%</span>
      · <span class="bias-rgb">${escapeHtml(sig)}</span>${reasonsHtml}
    </td></tr>`);
  }
  rows.push(`<tr class="mbo-head-row">
    <td>L</td><td>BID</td><td>QTY</td><td>ASK</td><td>QTY</td>
  </tr>`);
  // Show up to 15 levels for higher precision (was 12).
  const n = Math.min(15, Math.max(bids.length, asks.length));
  for (let i = 0; i < n; i++) {
    const b = bids[i], a = asks[i];
    rows.push(`<tr>
      <td class="dim">${i === 0 ? "TOB" : `L${i + 1}`}</td>
      <td class="dom-cell dom-bid">${bar(b?.qty, "bar-bid")}<span class="dom-px">${b ? fmtNum(b.price, decFmt) : "—"}</span></td>
      <td class="dom-q">${b ? fmtNum(+b.qty, b.qty < 10 ? 2 : 0) : "—"}</td>
      <td class="dom-cell dom-ask">${bar(a?.qty, "bar-ask")}<span class="dom-px">${a ? fmtNum(a.price, decFmt) : "—"}</span></td>
      <td class="dom-q">${a ? fmtNum(+a.qty, a.qty < 10 ? 2 : 0) : "—"}</td>
    </tr>`);
  }
  $("mbo-body").innerHTML = rows.join("");
}
function paintSmartLog() {
  const logs = state.logs.slice(-30).reverse();
  if (!logs.length) {
    $("smartlog-body").innerHTML = `<tr class="empty-row"><td colspan="3">awaiting hub telemetry</td></tr>`;
    return;
  }
  $("smartlog-body").innerHTML = logs.map((l) => {
    let srcTag = l.source || l.src || "Hub";
    if (/^EA\b/i.test(srcTag)) srcTag = "EA";
    if (/Bookmap/i.test(srcTag)) srcTag = "MBO";
    if (/ZmqBridge|ProviderRouter|DecisionEngine/i.test(srcTag)) srcTag = "AI";
    if (/Telemetry|KeyVault|SecureBoot|VPS/i.test(srcTag)) srcTag = "Hub";
    return `<tr>
      <td>${fmtTime(l.ts || l.t)}</td>
      <td><span class="src-pill src-${srcTag}">[${srcTag}]</span></td>
      <td>${escapeHtml(l.message || l.msg || "")}</td>
    </tr>`;
  }).join("");
}

// =====================================================================
// AI ENGINE STATUS (right column top)
// =====================================================================
function paintEngine() {
  const ctx = state.bridge.lastContext || {};
  const bm  = state.bookmap || {};
  const br  = state.bridge || {};
  const tpslMode = ctx.tpsl_mode || ctx.tpslMode || ctx.TPSLMode || "Native";
  const ex4 = br.repBound && br.pullBound;
  const newsOk = !!(state.news && (state.news.upcoming?.length || state.news.length));
  const pillOn  = `<span class="kv-pill"><span class="dot dot-online"></span><span class="kv-green">CONNECTED</span></span>`;
  const pillOff = `<span class="kv-pill"><span class="dot dot-down"></span><span class="kv-red">DISCONNECTED</span></span>`;
  const rows = [
    { k: "TPSL MODE",    v: `<span class="kv-v ${tpslMode === "AI" ? "kv-green" : ""}">${escapeHtml(tpslMode)}</span>`, raw: true },
    { k: "BOOKMAP FEED", v: bm.connected ? pillOn : pillOff, raw: true },
    { k: "MBO FEED",     v: (bm.connected && (bm.mboLevels || []).length) ? pillOn : pillOff, raw: true },
    { k: "NEWS FEED",    v: newsOk ? pillOn : pillOff, raw: true },
    { k: "EX4 BRIDGE",   v: ex4 ? pillOn : pillOff, raw: true },
    { k: "EX5 BRIDGE",   v: `<span class="kv-pill"><span class="dot dot-down"></span><span class="kv-red">OFFLINE — MT5 SOON</span></span>`, raw: true },
  ];
  $("engine-body").innerHTML = rows.map((r) =>
    `<div class="kv-row"><span class="kv-k">${r.k}</span><span class="kv-v">${r.raw ? r.v : escapeHtml(r.v)}</span></div>`
  ).join("");

  // Header status: ALWAYS just "NEURAL ENGINE" + a coloured dot.
  //   • green pulsating → EA online over ZMQ
  //   • red static      → EA disconnected
  const inDev  = !!state.env?.dev;
  const okBoot = state.secure?.ok || inDev;
  const live   = okBoot && ex4;
  $("neural-dot").className   = live ? "dot dot-online" : "dot dot-down";
  $("neural-label").textContent = "NEURAL ENGINE";
  $("neural-label").style.color = live ? "var(--green)" : "var(--red)";
  $("neural-label").style.textShadow = live
    ? "0 0 4px rgba(32, 224, 112, 0.4)"
    : "0 0 4px rgba(255, 85, 119, 0.4)";
}

// =====================================================================
// AI PROVIDERS
// =====================================================================
function paintProviders() {
  const list = (state.providers.providers || []);
  if (!list.length) {
    $("providers-body").innerHTML = `<tr class="empty-row"><td colspan="6">no providers loaded</td></tr>`;
    return;
  }
  const niceName = NICE_PROVIDER;
  // Format the balance pulled from each adapter's _doBalance() endpoint.
  // Only some vendors expose this publicly (DeepSeek does, OpenAI doesn't
  // anymore on free-tier keys). The rest show an em-dash, NOT an error.
  const fmtBalance = (p) => {
    if (p.balance && typeof p.balance.total === "number") {
      const cur = p.balance.currency || "USD";
      const sym = cur === "USD" ? "$" : (cur === "EUR" ? "€" : "");
      return `<span class="prov-balance ${p.balance.total > 0 ? "kv-green" : "kv-red"}">${sym}${p.balance.total.toFixed(2)}</span>`;
    }
    if (p.balance && p.balance.error)   return `<span class="prov-balance dim" title="${escapeHtml(p.balance.error)}">—</span>`;
    return `<span class="prov-balance dim">—</span>`;
  };
  const lockIcon = (p) => {
    if (!p.hasKey) {
      return `<button class="act-lock open" title="No API key — click EDIT to configure">
        <svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor"
          d="M18 8h-1V6a5 5 0 0 0-9.9-1l1.97.4A3 3 0 0 1 15 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2z"/></svg>
      </button>`;
    }
    if (p.healthy) {
      return `<button class="act-lock has-key" title="API key valid — vault locked">
        <svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor"
          d="M18 8h-1V6a5 5 0 0 0-10 0v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zM9 6a3 3 0 1 1 6 0v2H9V6z"/></svg>
      </button>`;
    }
    const reason = p.lastError ? ` (${p.lastError})` : "";
    return `<button class="act-lock warn" title="Key set but test failed${reason}">
      <svg viewBox="0 0 24 24" width="13" height="13"><path fill="currentColor"
        d="M12 2L1 21h22L12 2zm0 6 7.5 13H4.5L12 8zm-1 4v4h2v-4h-2zm0 5v2h2v-2h-2z"/></svg>
    </button>`;
  };

  $("providers-body").innerHTML = list.map((p) => {
    const status = p.healthy
      ? `<span class="prov-status"><span class="dot dot-online"></span>CONNECTED</span>`
      : (p.hasKey
          ? `<span class="prov-status down"><span class="dot dot-down"></span>DISCONNECTED</span>`
          : `<span class="prov-status idle"><span class="dot"></span>DISCONNECTED</span>`);
    const lat = (p.latencyMs != null) ? `${p.latencyMs} ms` : "—";
    return `<tr data-provider="${escapeHtml(p.name)}">
      <td>${escapeHtml(niceName[p.name] || p.name)}</td>
      <td>${status}</td>
      <td class="prov-lat">${lat}</td>
      <td>${fmtBalance(p)}</td>
      <td>${escapeHtml(p.model || "")}</td>
      <td class="prov-actions">${lockIcon(p)}</td>
    </tr>`;
  }).join("");

  // Click on lock icon opens the EDIT API KEY card pre-populated with that provider
  $("providers-body").querySelectorAll(".act-lock").forEach((btn) => {
    btn.onclick = (e) => {
      const tr = e.target.closest("tr[data-provider]");
      if (!tr) return;
      const provider = tr.dataset.provider;
      const sel = $("key-provider");
      if (sel) {
        sel.value = provider;
        $("key-value")?.focus();
      }
    };
  });
}

// =====================================================================
// Render orchestrator
// =====================================================================
function renderAll() {
  paintAccount();
  paintPerf();
  paintNews();
  paintChart();
  paintPositions();
  paintBookmap();
  paintMbo();
  paintHeatmap();
  paintSmartLog();
  paintEngine();
  paintProviders();
}

// =====================================================================
// CHART ACTION BUTTONS — Indicators / Templates / Alert / Replay
// =====================================================================
// All four open small floating popovers anchored under the button. State
// is held in localStorage so the user's choices survive a restart.
const CHART_PREFS = (() => {
  try { return JSON.parse(localStorage.getItem("oblivious.chartPrefs") || "{}"); }
  catch (_) { return {}; }
})();
function _saveChartPrefs() {
  try { localStorage.setItem("oblivious.chartPrefs", JSON.stringify(CHART_PREFS)); }
  catch (_) {}
}

function _closeAllPopovers() {
  document.querySelectorAll(".chart-popover").forEach((p) => p.remove());
}

function _openPopover(anchor, contentHTML, onMount) {
  _closeAllPopovers();
  const pop = document.createElement("div");
  pop.className = "chart-popover";
  pop.innerHTML = contentHTML;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.top  = `${Math.round(r.bottom + 6)}px`;
  pop.style.left = `${Math.round(Math.max(8, r.right - pop.offsetWidth))}px`;
  // Click outside → close
  setTimeout(() => {
    const closer = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== anchor) {
        pop.remove();
        document.removeEventListener("mousedown", closer);
      }
    };
    document.addEventListener("mousedown", closer);
  }, 0);
  if (onMount) onMount(pop);
  return pop;
}

function initChartActions() {
  const buttons = document.querySelectorAll(".chart-act");
  if (!buttons.length) return;

  // Defaults
  CHART_PREFS.indicators = CHART_PREFS.indicators || { ema20: false, ema50: false, ema200: false, rsi: false, macd: false, vwap: false };
  CHART_PREFS.template   = CHART_PREFS.template   || "Default";
  CHART_PREFS.alerts     = CHART_PREFS.alerts     || [];

  buttons.forEach((btn) => {
    const title = (btn.getAttribute("title") || "").toLowerCase();
    btn.onclick = (e) => {
      e.stopPropagation();
      if (title === "indicators") _popIndicators(btn);
      else if (title === "templates") _popTemplates(btn);
      else if (title === "alert")     _popAlert(btn);
      else if (title === "replay")    _popReplay(btn);
    };
  });
}

function _popIndicators(anchor) {
  const ind = CHART_PREFS.indicators;
  const opts = [
    ["ema20",  "EMA 20"],
    ["ema50",  "EMA 50"],
    ["ema200", "EMA 200"],
    ["vwap",   "VWAP"],
    ["rsi",    "RSI (14)"],
    ["macd",   "MACD"],
  ];
  const html = `
    <div class="pop-h">INDICATORS</div>
    <div class="pop-body">
      ${opts.map(([k, label]) => `
        <label class="pop-row">
          <input type="checkbox" data-ind="${k}" ${ind[k] ? "checked" : ""}/>
          <span>${label}</span>
        </label>`).join("")}
    </div>
    <div class="pop-foot"><button class="btn-cyan-outline" data-act="apply">APPLY</button></div>`;
  _openPopover(anchor, html, (pop) => {
    pop.querySelectorAll("input[data-ind]").forEach((cb) => {
      cb.onchange = () => { ind[cb.dataset.ind] = cb.checked; _saveChartPrefs(); };
    });
    pop.querySelector('[data-act="apply"]').onclick = () => {
      _saveChartPrefs();
      paintChart();
      pop.remove();
    };
  });
}

function _popTemplates(anchor) {
  const TEMPLATES = ["Default", "Scalper", "Swing", "News", "MBO Heatmap"];
  const html = `
    <div class="pop-h">TEMPLATES</div>
    <div class="pop-body">
      ${TEMPLATES.map((t) => `
        <button class="pop-row pop-pick" data-tpl="${t}">
          ${CHART_PREFS.template === t ? "●" : "○"} ${t}
        </button>`).join("")}
    </div>`;
  _openPopover(anchor, html, (pop) => {
    pop.querySelectorAll("[data-tpl]").forEach((b) => {
      b.onclick = () => {
        CHART_PREFS.template = b.dataset.tpl;
        _saveChartPrefs();
        pop.remove();
      };
    });
  });
}

function _popAlert(anchor) {
  const sym = $("symbol-select")?.value || "XAUUSD";
  const html = `
    <div class="pop-h">NEW PRICE ALERT</div>
    <div class="pop-body">
      <label class="pop-row"><span>Symbol</span><input type="text" value="${escapeHtml(sym)}" data-f="sym"/></label>
      <label class="pop-row"><span>When</span>
        <select data-f="op">
          <option value=">">price &gt;</option>
          <option value="<">price &lt;</option>
        </select>
      </label>
      <label class="pop-row"><span>Price</span><input type="number" step="0.00001" placeholder="2400.00" data-f="price"/></label>
    </div>
    <div class="pop-foot">
      <button class="btn-cyan-outline" data-act="add">ADD ALERT</button>
    </div>
    <div class="pop-list" id="alerts-list">
      ${CHART_PREFS.alerts.length === 0 ? '<div class="pop-empty">no alerts</div>' :
        CHART_PREFS.alerts.map((a, i) => `<div class="pop-row pop-alert">${escapeHtml(a.sym)} ${a.op} ${a.price} <span data-rm="${i}" class="pop-rm">×</span></div>`).join("")}
    </div>`;
  _openPopover(anchor, html, (pop) => {
    pop.querySelector('[data-act="add"]').onclick = () => {
      const sym   = pop.querySelector('[data-f="sym"]').value.trim().toUpperCase();
      const op    = pop.querySelector('[data-f="op"]').value;
      const price = parseFloat(pop.querySelector('[data-f="price"]').value);
      if (!sym || !Number.isFinite(price)) return;
      CHART_PREFS.alerts.push({ sym, op, price, t: Date.now() });
      _saveChartPrefs();
      pop.remove();
      _popAlert(anchor); // reopen with refreshed list
    };
    pop.querySelectorAll("[data-rm]").forEach((x) => {
      x.onclick = () => {
        CHART_PREFS.alerts.splice(+x.dataset.rm, 1);
        _saveChartPrefs();
        pop.remove();
        _popAlert(anchor);
      };
    });
  });
}

function _popReplay(anchor) {
  const html = `
    <div class="pop-h">REPLAY MODE</div>
    <div class="pop-body">
      <div class="pop-row pop-info">
        Scrubs the rolling EA context buffer (~last 240 ticks) so you can
        review the most recent price action without disconnecting the live feed.
      </div>
      <label class="pop-row"><span>Speed</span>
        <select data-f="speed">
          <option value="1">1×</option>
          <option value="2">2×</option>
          <option value="5">5×</option>
          <option value="10">10×</option>
        </select>
      </label>
    </div>
    <div class="pop-foot">
      <button class="btn-cyan-outline" data-act="play">▶ PLAY</button>
      <button class="btn-cyan-outline" data-act="stop">■ STOP</button>
    </div>`;
  _openPopover(anchor, html, (pop) => {
    pop.querySelector('[data-act="play"]').onclick = () => {
      const speed = +pop.querySelector('[data-f="speed"]').value || 1;
      _startReplay(speed);
      pop.remove();
    };
    pop.querySelector('[data-act="stop"]').onclick = () => {
      _stopReplay();
      pop.remove();
    };
  });
}

let _replayTimer = null;
function _startReplay(speed) {
  _stopReplay();
  if (priceBuffer.length < 2) return;
  const snapshot = priceBuffer.slice();
  let i = 0;
  priceBuffer.length = 0;
  _replayTimer = setInterval(() => {
    if (i >= snapshot.length) { _stopReplay(); return; }
    priceBuffer.push(snapshot[i++]);
    paintChart();
  }, Math.max(40, 200 / speed));
}
function _stopReplay() {
  if (_replayTimer) { clearInterval(_replayTimer); _replayTimer = null; }
}



// =====================================================================
// IPC wiring + interactions
// =====================================================================
function setKeyStatus(msg, ok) {
  const el = $("key-status");
  el.textContent = msg;
  el.className = `key-status ${ok ? "ok" : "err"}`;
}

async function initInteractions() {
  // Window controls
  $("btn-minimize").onclick = () => window.hub.win.minimize();
  $("btn-maximize").onclick = () => window.hub.win.maximize();
  $("btn-close").onclick    = () => window.hub.win.close();
  $("btn-settings").onclick = () => { /* reserved */ };

  // Timeframe + symbol
  document.querySelectorAll(".tf-btn").forEach((b) => {
    b.onclick = () => {
      // If the user clicks the already-active TF, do nothing: clicking
      // the same TF must NOT toggle, redownload or re-render. It is a
      // pure "switch" not a "trigger".
      if (b.classList.contains("active")) return;
      document.querySelectorAll(".tf-btn").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      window.hub.cmd.changeTimeframe({ tf: b.dataset.tf });
      // Flush both the live tick buffer and the synthetic-bar cache so
      // the chart redraws from scratch on the new timeframe.
      priceBuffer.length = 0;
      _synthBars = null;
      if (_chartApi && _chartApi.candle && typeof _chartApi.candle.setData === "function") {
        try { _chartApi.candle.setData([]); } catch (_) {}
      }
      _lastBarsKey = "";
      paintChart();
    };
  });
  $("symbol-select").onchange = (e) => {
    window.hub.cmd.changeSymbol({ sym: e.target.value });
    priceBuffer.length = 0;
    _synthBars = null;
    if (_chartApi && _chartApi.candle && typeof _chartApi.candle.setData === "function") {
      try { _chartApi.candle.setData([]); } catch (_) {}
    }
    _lastBarsKey = "";
    paintChart();
  };

  // OF HEATMAP — clicking a chip is COSMETIC ONLY (per user spec):
  // toggles a visual "is-active" outline without changing the chart
  // symbol or sending any ZMQ command.
  document.querySelectorAll(".of-chip[data-sym]").forEach((chip) => {
    chip.onclick = () => {
      document.querySelectorAll(".of-chip").forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
    };
  });

  // Chart action buttons — Indicators / Templates / Alert / Replay.
  // Each opens a small floating popover anchored under the button.
  initChartActions();

  // Active positions CLOSE delegation
  $("positions-body").addEventListener("click", async (e) => {
    const btn = e.target.closest(".btn-close-row");
    if (!btn) return;
    btn.disabled = true; btn.textContent = "…";
    const r = await window.hub.cmd.closePosition({
      ticket: +btn.dataset.ticket,
      sym:    btn.dataset.sym,
      magic:  +btn.dataset.magic || 0,
    });
    btn.textContent = r.ok ? "SENT" : "FAIL";
  });

  // EDIT API KEY
  const providers = await window.hub.vault.listProviders();
  // Same display labels used in BOTH the AI Providers table and the
  // EDIT API KEY dropdown so the user always sees consistent naming.
  $("key-provider").innerHTML = providers.map((p) => {
    const label = NICE_PROVIDER[p.toLowerCase()] || (p[0].toUpperCase() + p.slice(1));
    return `<option value="${p}">${label}</option>`;
  }).join("");

  $("key-eye").onclick = () => {
    const inp = $("key-value");
    inp.type = inp.type === "password" ? "text" : "password";
  };
  $("btn-test-key").onclick = async () => {
    const provider = $("key-provider").value;
    const typedKey = $("key-value").value.trim();
    setKeyStatus("Testing…", true);
    // If user typed a key, validate THAT one (without saving). Otherwise
    // fall back to the saved-vault key.
    const r = typedKey
      ? await window.hub.vault.testKey({ provider, key: typedKey })
      : await window.hub.vault.testProvider({ provider });
    if (r.ok) setKeyStatus(`OK · ${r.provider || provider} · ${r.latencyMs ?? r.latency_ms ?? "—"} ms`, true);
    else setKeyStatus(`Failed: ${r.reason || "unknown"}${r.status ? " (" + r.status + ")" : ""}`, false);
  };
  $("btn-save-key").onclick = async () => {
    const provider = $("key-provider").value;
    const key = $("key-value").value.trim();
    if (!key) { setKeyStatus("API key empty", false); return; }
    setKeyStatus("Saving + testing…", true);
    // Pre-validate before persisting so an invalid key never lands in vault
    const t = await window.hub.vault.testKey({ provider, key });
    if (!t.ok) {
      setKeyStatus(`Test failed: ${t.reason || "unknown"} — not saved`, false);
      return;
    }
    const r = await window.hub.vault.setKey({ provider, key });
    if (r.ok) {
      setKeyStatus(`Saved & verified · ${t.latencyMs ?? t.latency_ms ?? "—"} ms`, true);
      $("key-value").value = "";
    } else {
      setKeyStatus(`Save failed: ${r.reason || "unknown"}`, false);
    }
  };
  $("btn-test-all").onclick = async () => {
    setKeyStatus("Testing all providers…", true);
    const r = await window.hub.vault.testAll();
    if (r.ok) setKeyStatus("Done — see provider table", true);
  };
  $("btn-reconnect-all").onclick = async () => {
    await window.hub.vault.reconnectAll();
    setKeyStatus("Reloaded keys from vault", true);
  };

  // VPS Control Center
  $("vps-gen-key").onclick = async () => {
    const r = await window.hub.vps.generateUnlockKey();
    setKeyStatus(r.ok ? `New unlock key fp=${r.fingerprint}` : `VPS: ${r.reason}`, r.ok);
  };
  $("vps-rotate").onclick = async () => {
    const r = await window.hub.vps.rotateUnlockKey();
    setKeyStatus(r.ok ? `Rotated fp=${r.fingerprint}` : `VPS: ${r.reason}`, r.ok);
  };
  $("vps-revoke").onclick = async () => {
    const r = await window.hub.vps.revokeAccess();
    setKeyStatus(r.ok ? "VPS access revoked" : `VPS: ${r.reason}`, r.ok);
  };
  $("vps-bind").onclick = async () => {
    const r = await window.hub.vps.bindFingerprint();
    setKeyStatus(r.ok ? `Bound device ${r.deviceId.slice(0, 12)}…` : `VPS: ${r.reason}`, r.ok);
  };
  $("vps-runtime").onclick = async () => {
    const r = await window.hub.vps.generateRuntime();
    setKeyStatus(r.ok ? `Runtime token ${r.runtimeId}` : `VPS: ${r.reason}`, r.ok);
  };

  // VPS — tab switching (Access Security / SSH Automatic / Mobile Devices)
  document.querySelectorAll(".vps-tab-btn").forEach((btn) => {
    btn.onclick = () => {
      const target = btn.dataset.vpsTab;
      document.querySelectorAll(".vps-tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".vps-tab-pane").forEach((p) => {
        p.classList.toggle("hidden", p.dataset.vpsPane !== target);
      });
    };
  });

  // ═══════════════════════════════════════════════════════════════════
  // SSH AUTOMATIC + DEPLOY — real backend wiring via window.hub.ssh / .deploy
  // ═══════════════════════════════════════════════════════════════════
  const sshLog    = $("ssh-log");
  const deployLog = $("deploy-log");
  const accessLog = $("access-log");
  function logTo(el, msg, level = "info") {
    if (!el) return;
    const t = new Date().toLocaleTimeString();
    const div = document.createElement("div");
    div.className = `log-line log-${level}`;
    div.textContent = `[${t}] ${msg}`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
    while (el.children.length > 200) el.removeChild(el.firstChild);
  }
  function setSshPill(ok) {
    const pill = $("ssh-status-pill");
    if (!pill) return;
    pill.innerHTML = ok
      ? `<span class="dot dot-online"></span><span>CONNECTED</span>`
      : `<span class="dot dot-down"></span><span>DISCONNECTED</span>`;
  }
  function setHubPill(state) {
    const pill = $("dep-hub-pill");
    if (!pill) return;
    pill.innerHTML = state === "live"
      ? `<span class="dot dot-online"></span><span>LIVE</span>`
      : (state === "down"
        ? `<span class="dot dot-down"></span><span>DOWN</span>`
        : `<span class="dot dot-down"></span><span>UNKNOWN</span>`);
  }
  function readFormProfile() {
    return {
      host: ($("ssh-host")?.value || "").trim(),
      port: +($("ssh-port")?.value || 22),
      user: ($("ssh-user")?.value || "").trim(),
      remoteInstallPath: ($("ssh-remote-path")?.value || "").trim(),
      privateKeyPath:    $("ssh-key")?.value || "",
      publicKeyPath:     $("ssh-pubkey")?.value || "",
    };
  }
  async function fillKeyPaths() {
    const s = await window.hub.ssh.status();
    if (!s.ok) return;
    if ($("ssh-key"))    $("ssh-key").value    = s.privateKeyPath || "";
    if ($("ssh-pubkey")) $("ssh-pubkey").value = s.publicKeyPath  || "";
  }
  async function restoreProfile() {
    const r = await window.hub.ssh.loadProfile();
    if (r.ok && r.profile) {
      const p = r.profile;
      if (p.host) $("ssh-host").value = p.host;
      if (p.port) $("ssh-port").value = p.port;
      if (p.user) $("ssh-user").value = p.user;
      if (p.remoteInstallPath) $("ssh-remote-path").value = p.remoteInstallPath;
      if (p.privateKeyPath)    $("ssh-key").value    = p.privateKeyPath;
      if (p.publicKeyPath)     $("ssh-pubkey").value = p.publicKeyPath;
      logTo(sshLog, `Loaded encrypted VPS profile for ${p.user || "?"}@${p.host || "?"}`, "info");
    } else {
      logTo(sshLog, "No saved VPS profile yet — fill the form and click SAVE VPS PROFILE.", "info");
    }
  }

  // ── 1. GENERATE SSH KEYPAIR ─────────────────────────────────────
  const sshGenBtn = $("ssh-gen");
  if (sshGenBtn) sshGenBtn.onclick = async () => {
    logTo(sshLog, "Generating Ed25519 keypair…", "info");
    const r = await window.hub.ssh.generateKeypair({ overwrite: false });
    if (!r.ok && r.reason === "keypair_exists") {
      const yes = confirm("A keypair already exists. Overwrite? The old key will stop working immediately.");
      if (!yes) { logTo(sshLog, "Keep existing keypair", "info"); await fillKeyPaths(); return; }
      const r2 = await window.hub.ssh.generateKeypair({ overwrite: true });
      if (!r2.ok) return logTo(sshLog, `Generate failed: ${r2.reason}`, "error");
      logTo(sshLog, `New keypair generated. Fingerprint: ${r2.fingerprint}`, "info");
    } else if (!r.ok) {
      return logTo(sshLog, `Generate failed: ${r.reason}`, "error");
    } else {
      logTo(sshLog, `Keypair generated. Fingerprint: ${r.fingerprint}`, "info");
    }
    await fillKeyPaths();
  };

  // ── 2. INSTALL KEY ON VPS ─────────────────────────────────────
  const sshInstBtn = $("ssh-install");
  if (sshInstBtn) sshInstBtn.onclick = async () => {
    const prof = readFormProfile();
    const pwd  = ($("ssh-bootstrap-pwd")?.value || "");
    if (!prof.host || !prof.user) return logTo(sshLog, "Host and User required", "error");
    if (!pwd) return logTo(sshLog, "Bootstrap password required (only for first install)", "error");
    logTo(sshLog, `Installing public key on ${prof.user}@${prof.host}:${prof.port}…`, "info");
    const r = await window.hub.ssh.installKey({ ...prof, bootstrapPassword: pwd });
    if (!r.ok) return logTo(sshLog, `Install failed: ${r.reason}`, "error");
    logTo(sshLog, "Public key installed + host fingerprint pinned", "info");
    // Clear the bootstrap password from the UI immediately
    if ($("ssh-bootstrap-pwd")) $("ssh-bootstrap-pwd").value = "";
  };

  // ── 3. TEST CONNECTION ─────────────────────────────────────────
  const sshTestBtn = $("ssh-test");
  if (sshTestBtn) sshTestBtn.onclick = async () => {
    const prof = readFormProfile();
    if (!prof.host || !prof.user) return logTo(sshLog, "Host and User required", "error");
    logTo(sshLog, `Testing key-based SSH to ${prof.user}@${prof.host}:${prof.port}…`, "info");
    const r = await window.hub.ssh.testConnection(prof);
    if (!r.ok) { setSshPill(false); return logTo(sshLog, `Test failed: ${r.reason}`, "error"); }
    setSshPill(true);
    logTo(sshLog, `OK: ${r.uname || "remote uname"}`, "info");
  };

  // ── 4. SAVE VPS PROFILE (encrypted) ───────────────────────────
  const sshSaveBtn = $("ssh-save");
  if (sshSaveBtn) sshSaveBtn.onclick = async () => {
    const prof = readFormProfile();
    const r = await window.hub.ssh.saveProfile(prof);
    if (!r.ok) return logTo(sshLog, `Save failed: ${r.reason}`, "error");
    logTo(sshLog, "VPS profile saved (encrypted with operator vault passphrase)", "info");
  };

  // ── DEPLOY TAB handlers ───────────────────────────────────────
  function bindDeployBtn(id, fn, busyMsg) {
    const el = $(id); if (!el) return;
    el.onclick = async () => {
      el.disabled = true; logTo(deployLog, busyMsg, "info");
      try {
        const r = await fn();
        if (!r.ok) logTo(deployLog, `${id} failed: ${r.reason}`, "error");
        else       logTo(deployLog, `${id} → ${JSON.stringify(r).slice(0, 200)}`, "info");
      } catch (err) {
        logTo(deployLog, `${id} crashed: ${err.message}`, "error");
      } finally { el.disabled = false; }
    };
  }
  bindDeployBtn("dep-bundle",       () => window.hub.deploy.bundle(readFormProfile()),       "Uploading bundle via SFTP…");
  bindDeployBtn("dep-push-config",  () => window.hub.deploy.pushConfig(readFormProfile()),   "Uploading config.enc…");
  bindDeployBtn("dep-push-license", () => window.hub.deploy.pushLicense(readFormProfile()),  "Uploading license.lic + public_key.pem…");
  bindDeployBtn("dep-restart",      () => window.hub.deploy.restartHub(readFormProfile()),   "Restarting remote Hub…");
  bindDeployBtn("dep-stop",         () => window.hub.deploy.stopHub(readFormProfile()),      "Stopping remote Hub…");
  bindDeployBtn("dep-logs",         () => window.hub.deploy.pullLogs(readFormProfile()),     "Downloading remote logs…");
  bindDeployBtn("dep-health",       async () => {
    const r = await window.hub.deploy.healthCheck(readFormProfile());
    if (r.ok) {
      setHubPill(r.hubAlive ? "live" : "down");
      logTo(deployLog,
        `HEALTH → hub=${r.hubAlive ? "LIVE" : "DOWN"} pid=${r.pid} mem=${r.memMB}MB ` +
        `config=${r.configOk ? "OK" : "MISSING"} license=${r.licenseOk ? "OK" : "MISSING"} pubkey=${r.pubKeyOk ? "OK" : "MISSING"}`,
        "info");
    }
    return r;
  }, "Querying remote hub status…");

  // ── Initial fill: paths + saved profile ───────────────────────
  await fillKeyPaths();
  await restoreProfile();

  // Hide VPS panel if not dev
  const st = await window.hub.vps.status();
  function applyDeploymentMode(envInfo) {
     const mode = (envInfo && envInfo.mode) || (envInfo && envInfo.dev ? "dev" : "client");
     document.body.dataset.mode = mode;
     const vpsPanel = $("panel-vps");
     if (vpsPanel) vpsPanel.style.display = (mode === "dev") ? "" : "none";
     if (mode === "vps") {
        document.querySelectorAll("[data-dev-only]").forEach((el) => { el.style.display = "none"; });
     }
  }
  applyDeploymentMode(st.env || { dev: !!st.dev });
  if (window.hub.on) {
     window.hub.on("hub:devModeChanged", (envInfo) => applyDeploymentMode(envInfo));
  }

  // VPS pill + initial state
  async function refreshVpsPill() {
    try {
      const s = await window.hub.vps.status();
      const pill = $("vps-status-pill");
      if (pill) {
        const ok = !!(s && (s.device || s.connected));
        pill.innerHTML = ok
          ? `<span class="dot dot-online"></span><span>CONNECTED</span>`
          : `<span class="dot dot-down"></span><span>DISCONNECTED</span>`;
      }
    } catch (_) { /* noop */ }
  }
  refreshVpsPill();
  setInterval(refreshVpsPill, 5000);
  setSshPill(false);
  setHubPill("unknown");
  window._setSshPill = setSshPill;

  // ═══════════════════════════════════════════════════════════════════
  // MOBILE DEVICES TAB
  // ═══════════════════════════════════════════════════════════════════
  const mobLog = $("mob-log");
  function mlog(msg, level = "info") { logTo(mobLog, msg, level); }
  function setMobPill(running) {
    const p = $("mob-status-pill"); if (!p) return;
    p.innerHTML = running
      ? `<span class="dot dot-online"></span><span>RUNNING</span>`
      : `<span class="dot dot-down"></span><span>STOPPED</span>`;
  }
  function paintDevices(devices) {
    const tb = $("mob-devices-body"); if (!tb) return;
    if (!Array.isArray(devices) || !devices.length) {
      tb.innerHTML = `<tr class="empty-row"><td colspan="6">no devices paired yet</td></tr>`;
      return;
    }
    tb.innerHTML = devices.map((d) => {
      const s   = d.revoked ? "revoked" : (d.status || "offline");
      const cls = `status-${s.replace(/[^a-z]/gi, "")}`;
      const last = d.last_seen ? new Date(d.last_seen).toLocaleString() : "—";
      const act  = d.revoked
        ? `<span class="dim">—</span>`
        : `<button class="btn-revoke" data-revoke="${escapeHtml(d.device_id)}" data-testid="mob-revoke-${escapeHtml(d.device_id)}">REVOKE</button>`;
      return `<tr>
        <td>${escapeHtml(d.device_name || d.device_id)}</td>
        <td>${escapeHtml(d.platform || "—")}</td>
        <td>${escapeHtml(d.role || "viewer").toUpperCase()}</td>
        <td class="${cls}">${escapeHtml(s.toUpperCase())}</td>
        <td>${escapeHtml(last)}</td>
        <td>${act}</td>
      </tr>`;
    }).join("");
    tb.querySelectorAll("button.btn-revoke").forEach((b) => {
      b.onclick = async () => {
        if (!confirm("Revoke this device? It will be disconnected immediately.")) return;
        const r = await window.hub.mobile.revokeDevice({ device_id: b.dataset.revoke });
        mlog(r.ok ? `Device revoked ${b.dataset.revoke}` : `Revoke failed`, r.ok ? "info" : "error");
        await refreshMobile();
      };
    });
  }
  async function refreshMobile() {
    if (!window.hub?.mobile) return;
    const s = await window.hub.mobile.status();
    setMobPill(!!s.running);
    if ($("mob-port") && s.port) $("mob-port").value = s.port;
    if ($("mob-policy-enabled")) $("mob-policy-enabled").checked = !!(s.policy && s.policy.mobile_enabled);
    paintDevices(s.devices || []);
    // Reachable URL hint = first non-loopback IPv4
    try {
      const lan = await window.hub.mobile.lanIps();
      const ip  = (lan.ips || [])[0]?.address || "localhost";
      if ($("mob-url")) $("mob-url").value = s.running ? `https://${ip}:${s.port}/m/` : "(gateway stopped)";
    } catch (_) {}
  }
  if ($("mob-start")) $("mob-start").onclick = async () => {
    const port = +($("mob-port")?.value || 8443);
    mlog(`Starting mobile gateway on port ${port}…`, "info");
    const r = await window.hub.mobile.start({ port });
    mlog(r.ok ? `Gateway started on :${r.port}` : `Start failed: ${r.reason}`, r.ok ? "info" : "error");
    await refreshMobile();
  };
  if ($("mob-stop")) $("mob-stop").onclick = async () => {
    const r = await window.hub.mobile.stop();
    mlog(r.ok ? "Gateway stopped" : `Stop failed: ${r.reason}`, r.ok ? "info" : "error");
    await refreshMobile();
  };
  if ($("mob-refresh")) $("mob-refresh").onclick = refreshMobile;
  if ($("mob-pair")) $("mob-pair").onclick = async () => {
    const role = $("mob-role")?.value || "viewer";
    const r = await window.hub.mobile.createPairingToken({ role });
    if (!r.ok) return mlog(`Pairing failed: ${r.reason}`, "error");
    $("mob-qr-wrap").style.display = "flex";
    if (r.qrDataUrl) $("mob-qr-img").src = r.qrDataUrl;
    else             $("mob-qr-img").style.display = "none";
    $("mob-qr-token").textContent = r.token;
    $("mob-qr-exp").textContent   = new Date(r.expiresAt).toLocaleTimeString();
    $("mob-qr-url").textContent   = r.url;
    mlog(`Pairing QR generated for role=${role} (expires ${$("mob-qr-exp").textContent})`, "info");
  };
  if ($("mob-policy-enabled")) $("mob-policy-enabled").onchange = async (e) => {
    const r = await window.hub.mobile.setPolicy({ mobile_enabled: e.target.checked });
    mlog(r.ok ? `Policy mobile_enabled=${e.target.checked}` : `Policy update failed`, r.ok ? "info" : "error");
  };
  refreshMobile();
  setInterval(refreshMobile, 5000);
}

// =====================================================================
// Boot
// =====================================================================
async function boot() {
  // Render the brand title letter-by-letter so each glyph can wave on its own
  const brand = document.getElementById("brand-title");
  if (brand && !brand.children.length) {
    const txt = "OBLIVIOUS AI";
    brand.innerHTML = [...txt].map((ch, i) =>
      ch === " "
        ? `<span class="wt-space">&nbsp;</span>`
        : `<span class="wt-l" style="--wt-i:${i}">${ch}</span>`
    ).join("");
  }

  if (!window.hub) {
    document.body.innerHTML = '<div style="padding:40px;color:#ff5577;font-family:monospace">preload missing — hub API unavailable</div>';
    return;
  }
  await initInteractions();

  const snap = await window.hub.getSnapshot();
  if (snap) {
    Object.assign(state, snap);
    renderAll();
  }

  // Push subscriptions
  window.hub.on("hub:bridge",    (p) => { state.bridge    = p; renderAll(); });
  window.hub.on("hub:news",      (p) => {
    // Differ from `news_query` ctx (block/impact/next_event):
    // if it's the per-symbol news ctx, ignore for table; only refresh via snapshot poll.
    if (p && Array.isArray(p.upcoming)) { state.news = p; paintNews(); }
  });
  window.hub.on("hub:providers", (p) => { state.providers = p; paintProviders(); paintEngine(); });
  window.hub.on("hub:bookmap",   (p) => { state.bookmap   = p; paintBookmap(); paintMbo(); paintHeatmap(); paintEngine(); paintChart(); });
  window.hub.on("hub:decision",  (p) => { state.decision  = p; paintChart(); });
  window.hub.on("hub:secure",    (p) => { state.secure    = p; paintEngine(); });
  window.hub.on("hub:logs",      (entry) => {
    state.logs.push(entry);
    if (state.logs.length > 200) state.logs.shift();
    paintSmartLog();
  });

  // Periodic refetch of news upcoming list (NewsEngine emits only on flip).
  // Plus a fallback that pulls the FF CSV directly via main process if the
  // backend snapshot is empty or in an unrecognised shape.
  setInterval(async () => {
    const snap = await window.hub.getSnapshot();
    if (snap?.news) { state.news = snap.news; paintNews(); }
  }, 5_000);

  // News fetch fallback — always run at boot in parallel, regardless of
  // whatever NewsEngine pushes. The first non-empty result wins.
  async function fetchNewsViaIpc() {
    try {
      if (!window.hub?.news?.fetchFallback) return null;
      const r = await window.hub.news.fetchFallback();
      if (r?.ok && Array.isArray(r.upcoming) && r.upcoming.length) return r.upcoming;
    } catch (_) {}
    return null;
  }
  async function maybeFetchNewsFallback() {
    const haveNews = (() => {
      const r = state.news;
      if (Array.isArray(r) && r.length) return true;
      for (const k of ["upcoming","events","next","list","items","calendar"]) {
        if (Array.isArray(r?.[k]) && r[k].length) return true;
      }
      return false;
    })();
    if (haveNews) return;
    const fresh = await fetchNewsViaIpc();
    if (fresh) { state.news = { upcoming: fresh }; paintNews(); }
  }
  // 1) Immediately at boot, 2) also after 4s, 3) every 60s
  maybeFetchNewsFallback();
  setTimeout(maybeFetchNewsFallback, 4_000);
  setInterval(maybeFetchNewsFallback, 60_000);

  // Repaint chart canvas on resize
  window.addEventListener("resize", () => paintChart());

  // Keep canvas colours in step with the master RGB clock (20s cycle)
  setInterval(() => paintChart(), 250);

  // 60-second hard watchdog: re-render EVERY panel from the latest
  // snapshot, regardless of whether a push arrived. Guarantees that
  // every visible element (account / news / providers / bookmap /
  // MBO / heatmap / log) refreshes at least once per minute even if
  // a service stops emitting.
  setInterval(async () => {
    try {
      const fresh = await window.hub.getSnapshot();
      if (fresh) Object.assign(state, fresh);
    } catch (_) { /* noop */ }
    renderAll();
  }, 60_000);
}

boot();
