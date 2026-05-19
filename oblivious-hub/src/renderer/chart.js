// OBLIVIOUS HUB — chart.js
// ----------------------------------------------------------------
// Wraps the TradingView Lightweight-Charts library (vendored in
// /vendor/lightweight-charts.js) into a tiny API tailored for the
// EA telemetry feed:
//   • setBars([{t,o,h,l,c}, …])   ← from bridge.lastContext.bars
//   • setLevels([...])             ← TP/SL/Entry from positions[]
//   • setSymbol(sym)               ← currently informational (no remote feed)
//   • tickHue(hue)                 ← repaint level colours on RGB-clock tick
//
// Volumes are NOT rendered (no histogram series added). Header/legend
// chrome is fully hidden via the layout options below — only the
// candles + price scale + time scale are visible.
// ----------------------------------------------------------------
(function () {
  if (!window.LightweightCharts) {
    window.OB_CHART = null;
    return;
  }

  // lightweight-charts only accepts rgb()/rgba()/hex colours — NOT hsl().
  // We convert hue (°) + saturation (%) + lightness (%) to rgb manually.
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    s = Math.max(0, Math.min(1, s / 100));
    l = Math.max(0, Math.min(1, l / 100));
    if (s === 0) {
      const v = Math.round(l * 255);
      return [v, v, v];
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2rgb = (t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [
      Math.round(hue2rgb(h + 1 / 3) * 255),
      Math.round(hue2rgb(h)         * 255),
      Math.round(hue2rgb(h - 1 / 3) * 255),
    ];
  }

  function rgbAt(hue, l = 60, a = 1) {
    const [r, g, b] = hslToRgb(hue, 100, l);
    return a === 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
  }

  function readNeonHue() {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue("--neon-h").trim();
    return parseFloat(raw) || 0;
  }

  function createChart(host) {
    const hue = readNeonHue();
    const chart = LightweightCharts.createChart(host, {
      autoSize: true,
      localization: { locale: "en-US" },
      layout: {
        background:    { type: "solid", color: "transparent" },
        textColor:     "#9aa0ad",
        fontFamily:    "monospace",
        fontSize:      11,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.04)" },
        horzLines: { color: "rgba(255,255,255,0.04)" },
      },
      rightPriceScale: {
        borderColor: rgbAt(hue, 60, 0.18),
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor:  rgbAt(hue, 60, 0.18),
        timeVisible:  true,
        secondsVisible: false,
      },
      crosshair: {
        mode: 1,
        vertLine: { color: rgbAt(hue, 60, 0.4), width: 1, style: 0, labelBackgroundColor: rgbAt(hue, 60) },
        horzLine: { color: rgbAt(hue, 60, 0.4), width: 1, style: 0, labelBackgroundColor: rgbAt(hue, 60) },
      },
    });

    const candle = chart.addCandlestickSeries({
      upColor:        rgbAt(hue, 65),
      downColor:      "#ff3b3b",
      borderUpColor:  rgbAt(hue, 65),
      borderDownColor:"#ff3b3b",
      wickUpColor:    rgbAt(hue, 65),
      wickDownColor:  "#ff3b3b",
      priceLineColor: rgbAt(hue, 60, 0.6),
      priceLineStyle: 2,
    });

    /** Map<lineKey, IPriceLine> — re-used across redraws so we don't flicker */
    const lines = new Map();

    function setBars(bars) {
      if (!Array.isArray(bars) || !bars.length) return;
      // Lightweight-charts wants {time, open, high, low, close} with `time`
      // as a UNIX seconds number (or BusinessDay). We pass seconds and
      // dedupe — the lib refuses duplicate timestamps.
      const byTime = new Map();
      for (const b of bars) {
        const t = Math.floor(Number(b.t || b.time) / 1000);
        const o = Number(b.o ?? b.open);
        const h = Number(b.h ?? b.high);
        const l = Number(b.l ?? b.low);
        const c = Number(b.c ?? b.close);
        if (!Number.isFinite(t) || !Number.isFinite(c)) continue;
        // Last write wins → most-recent value at that second is kept
        byTime.set(t, { time: t, open: o, high: h, low: l, close: c });
      }
      const data = [...byTime.values()].sort((a, b) => a.time - b.time);
      if (!data.length) return;
      candle.setData(data);
    }

    /**
     * @param {{key,k,price,color,title,ticket,hit?}[]} levels
     */
    function setLevels(levels) {
      const seen = new Set();
      levels.forEach((l) => {
        const key = `${l.ticket}:${l.k}:${l.price.toFixed(5)}`;
        seen.add(key);
        const opts = {
          price:       l.price,
          color:       l.color,
          lineWidth:   l.k === "ENTRY" || l.k === "TPMAX" || l.k === "SL" ? 2 : 1,
          lineStyle:   l.hit ? 1 /* dotted */ : 0 /* solid */,
          axisLabelVisible: true,
          title:       `${l.title}  ${l.lots ?? ""}  ${l.usdLabel ?? ""}`,
        };
        if (lines.has(key)) {
          lines.get(key).applyOptions(opts);
        } else {
          lines.set(key, candle.createPriceLine(opts));
        }
      });
      // Drop lines that disappeared (e.g. trade closed)
      for (const [key, line] of lines) {
        if (!seen.has(key)) {
          candle.removePriceLine(line);
          lines.delete(key);
        }
      }
    }

    function tickHue(hue) {
      const up = rgbAt(hue, 65);
      candle.applyOptions({
        upColor: up, borderUpColor: up, wickUpColor: up,
        priceLineColor: rgbAt(hue, 60, 0.6),
      });
      chart.applyOptions({
        rightPriceScale: { borderColor: rgbAt(hue, 60, 0.18) },
        timeScale:       { borderColor: rgbAt(hue, 60, 0.18) },
        crosshair: {
          vertLine: { color: rgbAt(hue, 60, 0.4), labelBackgroundColor: rgbAt(hue, 60) },
          horzLine: { color: rgbAt(hue, 60, 0.4), labelBackgroundColor: rgbAt(hue, 60) },
        },
      });
    }

    return { chart, candle, setBars, setLevels, tickHue, lines };
  }

  // Force-resize the chart to fit its host (a workaround for environments
  // where ResizeObserver doesn't fire reliably on first mount).
  function forceResize(api, host) {
    if (!api || !host) return;
    const w = host.clientWidth, h = host.clientHeight;
    if (w > 0 && h > 0) api.chart.resize(w, h);
  }
  window.OB_CHART = { create: createChart, readNeonHue, forceResize };
})();
