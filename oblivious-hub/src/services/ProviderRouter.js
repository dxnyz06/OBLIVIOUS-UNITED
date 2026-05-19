// OBLIVIOUS HUB — ProviderRouter.
//
// Owns the seven configured AI adapters, picks the best one for a
// given query (health × latency × cache hit), and provides a single
// async query() entry point used by ZmqBridge for ai_query handling
// and by DecisionEngine for proactive Predicted reasoning.

const { OpenAIAdapter }     = require("./providers/OpenAIAdapter");
const { AnthropicAdapter }  = require("./providers/AnthropicAdapter");
const { GoogleAdapter }     = require("./providers/GoogleAdapter");
const { XAIAdapter }        = require("./providers/XAIAdapter");
const { DeepSeekAdapter }   = require("./providers/DeepSeekAdapter");
const { QwenAdapter }       = require("./providers/QwenAdapter");
const { PerplexityAdapter } = require("./providers/PerplexityAdapter");
const { BookmapAdapter }    = require("./providers/BookmapAdapter");

const SYSTEM_PROMPT = [
  "You are OBLIVIOUS, a quant trading copilot.",
  "Given the latest market context, reply ONLY with a JSON object:",
  '  {"dir":"BUY"|"SELL"|"HOLD","conf":0..1,"signal":"<short label>"}',
  "Do not add commentary. Confidence < 0.55 means HOLD.",
].join(" ");

const PROVIDER_MODELS = {
  openai:     "GPT-4o",
  anthropic:  "Claude-3.5",
  google:     "Gemini 1.5",
  xai:        "Grok-3",
  deepseek:   "DeepSeek-V3",
  qwen:       "Qwen2.5-72B",
  perplexity: "PPLX-70B",
  bookmap:    "L2 + MBO",
};

class ProviderRouter {
  constructor({ keyVault, cache, telemetry }) {
    this.keyVault  = keyVault;
    this.cache     = cache;
    this.telemetry = telemetry;
    this._adapters = [
      new OpenAIAdapter({     apiKey: keyVault.get("openai")     }),
      new AnthropicAdapter({  apiKey: keyVault.get("anthropic")  }),
      new GoogleAdapter({     apiKey: keyVault.get("google")     }),
      new XAIAdapter({        apiKey: keyVault.get("xai")        }),
      new DeepSeekAdapter({   apiKey: keyVault.get("deepseek")   }),
      new QwenAdapter({       apiKey: keyVault.get("qwen")       }),
      new PerplexityAdapter({ apiKey: keyVault.get("perplexity") }),
      new BookmapAdapter({    apiKey: keyVault.get("bookmap")    }),
    ];
    this._stats = {
      cacheHits: 0,
      cacheMiss: 0,
      tokensSaved: 0,
      lastWinner: null,
    };
  }

  _buildPrompt(ctx) {
    const lines = [
      `symbol=${ctx.sym || "XAUUSD"}`,
      `bid=${ctx.bid ?? "n/a"} ask=${ctx.ask ?? "n/a"} spread=${ctx.spread ?? "n/a"}`,
      `atr=${ctx.atr ?? "n/a"} rsi=${ctx.rsi ?? "n/a"} adx=${ctx.adx ?? "n/a"} trend=${ctx.trend ?? "n/a"}`,
      `news_block=${ctx.news_block ? "yes" : "no"} news_impact=${ctx.news_impact ?? 0}`,
      `tpsl_mode=${ctx.tpsl_mode || "Native"}`,
    ];
    return { system: SYSTEM_PROMPT, user: lines.join("\n") };
  }

  // Stable strategy fingerprint — feeds AiCache._normalizeFingerprint.
  // Tick-level fields (bid/ask/spread) are intentionally excluded so
  // the cache actually hits within a single setup window.
  _cacheKey(ctx) {
    return {
      sym:         ctx.sym || "",
      tf:          ctx.tf || ctx.timeframe || "",
      strategy:    ctx.strategy || ctx.strategyName || "",
      dir:         ctx.dir || ctx.direction || "",
      tpsl_mode:   ctx.tpsl_mode || "",
      setup_score: typeof ctx.setup_score === "number" ? ctx.setup_score : 0,
      news_block:  !!ctx.news_block,
      news_impact: ctx.news_impact || 0,
    };
  }

  // Pick a TTL profile for cache writes based on the live regime.
  _ttlLevel(ctx) {
    if (ctx.news_block || (ctx.news_impact || 0) >= 3) return "aggressive";
    if (ctx.strategy === "Predicted")                  return "moderate";
    return "conservative";
  }

  _pickOrder() {
    return this._adapters
      .filter((a) => a.apiKey)
      .sort((a, b) => {
        if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
        const al = a.latencyMs || 9999;
        const bl = b.latencyMs || 9999;
        return al - bl;
      });
  }

  async query(ctx) {
    if (!ctx) ctx = {};
    const key = this._cacheKey(ctx);
    if (this.cache) {
      const hit = this.cache.get(key);
      if (hit) {
        this._stats.cacheHits++;
        this._stats.tokensSaved += 200;
        return { ok: true, content: hit, provider: "cache" };
      }
      this._stats.cacheMiss++;
    }
    const prompt = this._buildPrompt(ctx);
    const order  = this._pickOrder();
    if (!order.length) return { ok: false, reason: "no_provider_available" };
    let lastErr = null;
    for (const adapter of order) {
      const r = await adapter.query(prompt);
      if (r.ok) {
        this._stats.lastWinner = adapter.name;
        if (this.cache) this.cache.set(key, r.content, this._ttlLevel(ctx));
        return r;
      }
      lastErr = r.reason;
      if (this.telemetry) {
        this.telemetry.log("warn", "ProviderRouter",
          `${adapter.name} failed: ${r.reason}`);
      }
    }
    return { ok: false, reason: lastErr || "all_failed" };
  }

  async testProvider(name) {
    const a = this._adapters.find((x) => x.name === name);
    if (!a) return { ok: false, reason: "unknown_provider" };
    if (!a.apiKey) return { ok: false, reason: "no_api_key" };
    const r = await a.query({
      system: SYSTEM_PROMPT,
      user:   "symbol=XAUUSD\nbid=2400 ask=2400.10\nnews_block=no\nrespond JSON only",
    });
    return r;
  }

  // Test a candidate key WITHOUT persisting it to the vault. Used by the
  // "TEST CONNECTION" button so the user can validate a freshly-typed key
  // before saving (otherwise the test would always run against the old key).
  async testProviderKey(name, candidateKey) {
    const a = this._adapters.find((x) => x.name === name);
    if (!a) return { ok: false, reason: "unknown_provider" };
    if (!candidateKey) return { ok: false, reason: "empty_key" };
    const original = a.apiKey;
    a.apiKey = String(candidateKey);
    try {
      // Use the cheap validation endpoint (e.g. GET /v1/models for OpenAI).
      // Falls back to a 1-token query if the adapter doesn't expose one.
      const r = await a.validateKey();
      return r;
    } finally {
      a.apiKey = original;
    }
  }

  async testAll() {
    const out = {};
    for (const a of this._adapters) {
      if (!a.apiKey) { out[a.name] = { ok: false, reason: "no_api_key" }; continue; }
      out[a.name] = await this.testProvider(a.name);
    }
    return out;
  }

  reloadKeys() {
    for (const a of this._adapters) {
      const k = this.keyVault.get(a.name);
      a.apiKey  = k || "";
      a.healthy = !!k;
      if (!k) a.lastError = "no_api_key";
    }
  }

  snapshot() {
    return {
      providers: this._adapters.map((a) => ({
        name:        a.name,
        model:       PROVIDER_MODELS[a.name] || a.name,
        healthy:     a.healthy,
        latencyMs:   a.latencyMs,
        rateLimited: a.rateLimited,
        lastError:   a.lastError,
        hasKey:      !!a.apiKey,
        balance:     a.balance || null,
      })),
      routing: {
        strategy:     "health-then-latency",
        lastWinner:   this._stats.lastWinner,
        cacheHitPct:
          this._stats.cacheHits + this._stats.cacheMiss === 0
            ? 0
            : (100 * this._stats.cacheHits) /
              (this._stats.cacheHits + this._stats.cacheMiss),
        tokensSaved: this._stats.tokensSaved,
      },
    };
  }

  /** Refresh balances on every adapter that exposes _doBalance(). */
  async refreshBalances() {
    await Promise.all(this._adapters.map((a) =>
      a.refreshBalance ? a.refreshBalance() : Promise.resolve()
    ));
  }
}

module.exports = ProviderRouter;
