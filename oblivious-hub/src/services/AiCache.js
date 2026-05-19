// OBLIVIOUS HUB — AiCache
// ----------------------------------------------------------------
// Tiny TTL cache. ProviderRouter uses it to memoise prompt→answer
// pairs for `ttlMs` so identical AI calls don't re-bill.
// ----------------------------------------------------------------

class AiCache {
  constructor({ ttlMs, telemetry } = {}) {
    this.ttlMs = Number(ttlMs) || 60_000;
    this.telemetry = telemetry || { log: () => {} };
    this._map = new Map(); // key -> { v, exp }
  }

  get(key) {
    const e = this._map.get(key);
    if (!e) return null;
    if (e.exp < Date.now()) {
      this._map.delete(key);
      return null;
    }
    return e.v;
  }

  set(key, v, ttlMs) {
    const ttl = Number(ttlMs) || this.ttlMs;
    this._map.set(key, { v, exp: Date.now() + ttl });
    // Cheap eviction: clear expired on every 50 sets.
    if (this._map.size % 50 === 0) this._sweep();
  }

  has(key) { return this.get(key) != null; }

  delete(key) { return this._map.delete(key); }

  clear() { this._map.clear(); }

  size() { return this._map.size; }

  _sweep() {
    const now = Date.now();
    for (const [k, v] of this._map) {
      if (v.exp < now) this._map.delete(k);
    }
  }
}

module.exports = AiCache;
