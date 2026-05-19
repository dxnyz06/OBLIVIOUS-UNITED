// OBLIVIOUS HUB — NewsEngine
// ----------------------------------------------------------------
// Fetches the ForexFactory weekly CSV calendar, parses it into a
// canonical event list, dedupes, and emits an "update" event each
// time the freshest 10 rows change.
//
// Public shape:
//   const ne = new NewsEngine({ url, refreshMinutes, telemetry });
//   await ne.start();           // initial fetch + interval
//   ne.snapshot();              // -> { upcoming: [...], lastFetch: ts, source: "forexfactory" }
//   ne.on("update", (snap) => ...);
//   ne.stop();                  // clears interval + listeners
//
// Each event: { time: number(ms), country, title, impact, forecast, previous, url }
// "upcoming" = the freshest 10 entries, sorted soonest-first when
// any future events exist, otherwise newest-past first.
// ----------------------------------------------------------------

const https = require("https");
const http  = require("http");
const { EventEmitter } = require("events");
const { URL } = require("url");

const DEFAULT_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.csv";
const FALLBACK_MIRRORS = [
  "https://nfs.faireconomy.media/ff_calendar_thisweek.csv",
];
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

class NewsEngine extends EventEmitter {
  constructor({ url, refreshMinutes, telemetry } = {}) {
    super();
    this.url = url || DEFAULT_URL;
    this.refreshMinutes = Math.max(1, Number(refreshMinutes) || 5);
    this.telemetry = telemetry || { log: () => {}, emit: () => {} };
    this._timer = null;
    this._stopped = false;
    this._events = [];      // all parsed events
    this._upcoming = [];    // top-10 surfaced to the renderer
    this._lastFetch = 0;
    this._lastError = null;
    this._lastSnapshotKey = "";
  }

  // ─────────── public ───────────

  async start() {
    this._stopped = false;
    await this._refresh();
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => {
      this._refresh().catch((err) =>
        this.telemetry.log("warn", "NewsEngine", `refresh failed: ${err.message}`)
      );
    }, this.refreshMinutes * 60 * 1000);
    // Don't keep the event loop alive just for the timer.
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    this._stopped = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this.removeAllListeners();
  }

  snapshot() {
    return {
      upcoming:  this._upcoming.slice(),
      lastFetch: this._lastFetch,
      lastError: this._lastError,
      source:    "forexfactory",
      total:     this._events.length,
    };
  }

  // ─────────── internal ───────────

  async _refresh() {
    if (this._stopped) return;
    try {
      const candidates = this.url === DEFAULT_URL ? FALLBACK_MIRRORS : [this.url];
      let body = null;
      let lastErr = null;
      for (const u of candidates) {
        try {
          body = await this._fetch(u);
          if (body) break;
        } catch (e) { lastErr = e; }
      }
      if (!body) throw lastErr || new Error("all_mirrors_failed");

      const events = this._parseCsv(body);
      this._events = this._dedupe(events).sort((a, b) => a.time - b.time);
      this._upcoming = this._pickFreshest(this._events, 10);
      this._lastFetch = Date.now();
      this._lastError = null;

      const key = this._upcoming.map((e) => `${e.time}|${e.title}`).join("~");
      if (key !== this._lastSnapshotKey) {
        this._lastSnapshotKey = key;
        this.emit("update", this.snapshot());
        this.telemetry.log(
          "info", "NewsEngine",
          `refreshed ${this._events.length} events (top10 surfaced)`
        );
      }
    } catch (err) {
      this._lastError = err.message || String(err);
      this.telemetry.log("warn", "NewsEngine", `fetch failed: ${this._lastError}`);
      // Re-emit current snapshot so the renderer at least has something.
      if (this._upcoming.length) this.emit("update", this.snapshot());
    }
  }

  _fetch(rawUrl) {
    return new Promise((resolve, reject) => {
      const u = new URL(rawUrl);
      const lib = u.protocol === "http:" ? http : https;
      const req = lib.request({
        host:    u.hostname,
        port:    u.port || (u.protocol === "http:" ? 80 : 443),
        path:    u.pathname + u.search,
        method:  "GET",
        headers: {
          "User-Agent":      UA,
          "Accept":          "text/csv,*/*;q=0.9",
          "Accept-Language": "en-US,en;q=0.9",
        },
        timeout: 12_000,
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`status=${res.statusCode}`));
          return;
        }
        let chunks = "";
        res.on("data", (c) => { chunks += c.toString("utf8"); });
        res.on("end",  () => resolve(chunks));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
      req.end();
    });
  }

  _parseCsv(text) {
    // FF CSV columns: Title,Country,Date,Time,Impact,Forecast,Previous,URL
    const lines = String(text).split(/\r?\n/).filter(Boolean);
    if (!lines.length) return [];
    lines.shift(); // header
    const out = [];
    for (const ln of lines) {
      // Handle quoted commas inside title.
      const cols = this._splitCsvLine(ln);
      if (cols.length < 5) continue;
      const [title, country, date, time, impact, forecast, previous, url] = cols;
      const ts = this._parseDateTime(date, time);
      if (!Number.isFinite(ts)) continue;
      out.push({
        time:     ts,
        country:  (country  || "").trim(),
        title:    (title    || "").trim().replace(/^"|"$/g, ""),
        impact:   (impact   || "Low").trim().toUpperCase(),
        forecast: (forecast || "").trim(),
        previous: (previous || "").trim(),
        url:      (url      || "").trim(),
      });
    }
    return out;
  }

  _splitCsvLine(line) {
    // Minimal CSV splitter that respects double-quoted fields.
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (ch === "," && !inQ) { out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    out.push(cur);
    return out;
  }

  _parseDateTime(date, time) {
    try {
      // FF uses MM-DD-YYYY. Convert to ISO YYYY-MM-DD so JS parses
      // it consistently across locales.
      const [mm, dd, yyyy] = String(date || "").split("-");
      if (!yyyy || !mm || !dd) return NaN;
      const isoDate = `${yyyy}-${mm.padStart(2,"0")}-${dd.padStart(2,"0")}`;
      const t = String(time || "").trim();
      if (!t || /All Day|Tentative/i.test(t)) {
        return new Date(`${isoDate}T12:00:00Z`).getTime();
      }
      const ampm = /pm/i.test(t);
      const [h, mPart] = t.replace(/[ap]m/i, "").split(":");
      let hr = (Number(h) || 0) % 12;
      if (ampm) hr += 12;
      const hh = String(hr).padStart(2, "0");
      const mn = String(mPart || "00").padStart(2, "0");
      // FF publishes in EST (no DST handling here — close enough for UI).
      return new Date(`${isoDate}T${hh}:${mn}:00-05:00`).getTime();
    } catch (_) {
      return NaN;
    }
  }

  _dedupe(events) {
    const seen = new Set();
    return events.filter((e) => {
      const k = `${e.time}|${e.title}|${e.country}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /**
   * Pick the freshest 10 events:
   *   1. Prefer upcoming (sorted soonest-first at the top).
   *   2. If there aren't 10 upcoming, top-up with the most-recent
   *      past events (most recent first) so the panel always shows
   *      10 rows mid-week / on weekends.
   */
  _pickFreshest(events, limit) {
    const now = Date.now();
    const upcoming = events
      .filter((e) => e.time >= now - 60_000)
      .sort((a, b) => a.time - b.time);
    if (upcoming.length >= limit) return upcoming.slice(0, limit);

    const past = events
      .filter((e) => e.time < now - 60_000)
      .sort((a, b) => b.time - a.time);
    return upcoming.concat(past.slice(0, limit - upcoming.length));
  }
}

module.exports = NewsEngine;
