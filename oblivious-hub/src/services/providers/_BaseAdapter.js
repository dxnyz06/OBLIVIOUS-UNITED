// Shared HTTPS request helper for all provider adapters (no extra deps).
const https = require("https");
const http  = require("http");

function httpsRequest({ url, method = "POST", headers = {}, body, timeoutMs = 12000 }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;
    const opts = {
      method,
      hostname: u.hostname,
      port:     u.port || (isHttps ? 443 : 80),
      path:     u.pathname + u.search,
      headers,
      timeout:  timeoutMs,
    };
    const req = lib.request(opts, (res) => {
      let chunks = "";
      res.on("data", (c) => { chunks += c.toString("utf8"); });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(chunks); } catch (_) {}
        resolve({ status: res.statusCode || 0, text: chunks, json });
      });
    });
    req.on("error",   (e) => resolve({ status: 0, text: "", json: null, err: String(e.message || e) }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, text: "", json: null, err: "timeout" }); });
    if (body) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

class BaseAdapter {
  constructor({ apiKey, name }) {
    this.name        = name;
    this.apiKey      = apiKey || "";
    this.healthy     = !!apiKey;
    this.latencyMs   = null;
    this.rateLimited = false;
    this.lastError   = apiKey ? null : "no_api_key";
  }

  // Subclasses override _doQuery(prompt) -> { status, json, text }
  async _doQuery() { throw new Error("not implemented"); }

  // Subclasses MAY override _doTest() to provide a cheaper validation
  // path (e.g. GET /v1/models on OpenAI). Default falls back to query().
  async _doTest() { return null; }

  // Subclasses MAY override _doBalance() to expose remaining credits.
  // Returns { total: number, currency: string } or null if unsupported.
  async _doBalance() { return null; }

  /** Refresh the cached balance. Non-fatal: stores error message instead. */
  async refreshBalance() {
    if (!this.apiKey) { this.balance = null; return null; }
    try {
      const r = await this._doBalance();
      this.balance = r;  // null = vendor doesn't expose, object = balance data
      return r;
    } catch (e) {
      this.balance = { error: e.message || String(e) };
      return this.balance;
    }
  }

  /**
   * Light-weight key validation used by the EDIT API KEY "Test Connection"
   * button. Prefers the adapter's cheap `_doTest()` endpoint (no token
   * consumption, no TPM cost). Falls back to a real `query()` only when
   * no _doTest is defined.
   */
  async validateKey() {
    if (!this.apiKey) return { ok: false, reason: "no_api_key" };
    const t0 = Date.now();
    let res;
    try { res = await this._doTest(); }
    catch (e) { res = { status: 0, err: String(e.message || e) }; }
    if (!res) {
      // Adapter doesn't expose a test endpoint — fall back to a 1-token query.
      return this.query({ system: "", user: "ping" });
    }
    this.latencyMs = Date.now() - t0;
    if (res.status === 200 || res.status === 201) {
      this.healthy = true; this.lastError = null; this.rateLimited = false;
      return { ok: true, provider: this.name, latencyMs: this.latencyMs, latency_ms: this.latencyMs };
    }
    if (res.status === 402) {
      // Key is valid, but the account has no balance. Treat as "ok with
      // warning" so the user sees a green-tinted check + a notice.
      this.healthy = true; this.lastError = "no_credits";
      return { ok: true, provider: this.name, latencyMs: this.latencyMs, warning: "no_credits" };
    }
    if (res.status === 401 || res.status === 403) {
      this.healthy = false; this.lastError = "invalid_key";
      return { ok: false, reason: "invalid_key", status: res.status };
    }
    if (res.status === 429) {
      this.rateLimited = true; this.lastError = "rate_limited";
      return { ok: false, reason: "rate_limited", status: res.status };
    }
    if (res.status === 0) {
      this.healthy = false; this.lastError = res.err || "network";
      return { ok: false, reason: "network", detail: res.err };
    }
    this.healthy = false; this.lastError = `http_${res.status}`;
    return { ok: false, reason: this.lastError, body: res.text };
  }

  async query(prompt) {
    if (!this.apiKey) {
      this.healthy = false;
      this.lastError = "no_api_key";
      return { ok: false, reason: "no_api_key" };
    }
    const t0 = Date.now();
    let res;
    try { res = await this._doQuery(prompt); }
    catch (e) { res = { status: 0, err: String(e.message || e) }; }
    this.latencyMs = Date.now() - t0;

    if (res.status === 401 || res.status === 403) {
      this.healthy = false;
      this.lastError = "invalid_key";
      return { ok: false, reason: "invalid_key", status: res.status };
    }
    if (res.status === 429) {
      this.rateLimited = true;
      this.lastError   = "rate_limited";
      return { ok: false, reason: "rate_limited", status: res.status };
    }
    if (res.status === 0) {
      this.healthy = false;
      this.lastError = res.err || "network";
      return { ok: false, reason: "network", detail: res.err };
    }
    if (res.status >= 200 && res.status < 300) {
      this.healthy = true;
      this.lastError = null;
      this.rateLimited = false;
      const content = this._extractContent(res.json);
      return {
        ok: true,
        content,
        provider:   this.name,
        latency_ms: this.latencyMs,
        latencyMs:  this.latencyMs,   // camelCase alias for renderer
      };
    }
    this.healthy = false;
    this.lastError = `http_${res.status}`;
    return { ok: false, reason: this.lastError, body: res.text };
  }
  _extractContent(json) { return JSON.stringify(json || {}).slice(0, 600); }
}

module.exports = { BaseAdapter, httpsRequest };
