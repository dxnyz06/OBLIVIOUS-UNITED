// Common adapter scaffolding.
//
// Each provider extends BaseAdapter, supplies the HTTP details
// (endpoint, headers, body builder, response parser) and inherits
// timeout / retry / latency metrics.

const axios = require("axios").default;

class BaseAdapter {
  constructor({ name, apiKey, timeoutMs = 7000, maxRetries = 2 }) {
    this.name       = name;
    this.apiKey     = apiKey || "";
    this.timeoutMs  = timeoutMs;
    this.maxRetries = maxRetries;
    this.healthy    = !!apiKey;
    this.latencyMs  = null;
    this.lastError  = null;
    this.rateLimited = false;
  }

  async query(prompt) {
    if (!this.apiKey) {
      this.healthy = false;
      this.lastError = "no_api_key";
      return { ok: false, reason: "no_api_key" };
    }
    let attempt = 0;
    let lastErr = null;
    while (attempt <= this.maxRetries) {
      const started = Date.now();
      try {
        const cfg = this._buildRequest(prompt);
        const res = await axios.request({
          method: cfg.method || "POST",
          url:    cfg.url,
          headers: cfg.headers,
          data:   cfg.data,
          timeout: this.timeoutMs,
          validateStatus: () => true,
        });
        this.latencyMs   = Date.now() - started;
        this.rateLimited = res.status === 429;
        if (res.status >= 200 && res.status < 300) {
          const content = this._parseResponse(res.data);
          this.healthy   = true;
          this.lastError = null;
          return { ok: true, provider: this.name, content, latencyMs: this.latencyMs };
        }
        if (res.status === 429 && attempt < this.maxRetries) {
          // rate limited — short backoff
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          attempt++;
          continue;
        }
        lastErr = `status=${res.status}`;
        break;
      } catch (err) {
        this.latencyMs = Date.now() - started;
        lastErr = err.message || "request_failed";
        if (attempt >= this.maxRetries) break;
        attempt++;
        await new Promise((r) => setTimeout(r, 250 * attempt));
      }
    }
    this.healthy   = false;
    this.lastError = lastErr;
    return { ok: false, provider: this.name, reason: lastErr || "unknown" };
  }

  // Subclasses override:
  _buildRequest(_prompt)  { throw new Error("BaseAdapter._buildRequest not implemented"); }
  _parseResponse(_data)   { throw new Error("BaseAdapter._parseResponse not implemented"); }
}

module.exports = BaseAdapter;
