// Thin wrapper around hub AI adapters — same HTTP probe as production router.

const path = require("path");

const SYSTEM_PROMPT = [
  "You are OBLIVIOUS, a quant trading copilot.",
  "Given the latest market context, reply ONLY with a JSON object:",
  '  {"dir":"BUY"|"SELL"|"HOLD","conf":0..1,"signal":"<short label>"}',
  "Do not add commentary. Confidence < 0.55 means HOLD.",
].join(" ");

const TEST_PROMPT = {
  system: SYSTEM_PROMPT,
  user:
    "symbol=EURUSD bid=1.0850 ask=1.0852 atr=0.0012 rsi=55 adx=22 trend=UP news_block=no news_impact=0 tpsl_mode=Native",
};

function loadAdapter(hubSvc, providerId, apiKey) {
  const pDir = path.join(hubSvc, "providers");
  switch (providerId) {
    case "openai": {
      const { OpenAIAdapter } = require(path.join(pDir, "OpenAIAdapter.js"));
      return new OpenAIAdapter({ apiKey });
    }
    case "anthropic": {
      const { AnthropicAdapter } = require(path.join(pDir, "AnthropicAdapter.js"));
      return new AnthropicAdapter({ apiKey });
    }
    case "google": {
      const { GoogleAdapter } = require(path.join(pDir, "GoogleAdapter.js"));
      return new GoogleAdapter({ apiKey });
    }
    case "xai": {
      const { XAIAdapter } = require(path.join(pDir, "XAIAdapter.js"));
      return new XAIAdapter({ apiKey });
    }
    case "deepseek": {
      const { DeepSeekAdapter } = require(path.join(pDir, "DeepSeekAdapter.js"));
      return new DeepSeekAdapter({ apiKey });
    }
    case "qwen": {
      const { QwenAdapter } = require(path.join(pDir, "QwenAdapter.js"));
      return new QwenAdapter({ apiKey });
    }
    case "perplexity": {
      const { PerplexityAdapter } = require(path.join(pDir, "PerplexityAdapter.js"));
      return new PerplexityAdapter({ apiKey });
    }
    default:
      throw new Error("unknown_provider");
  }
}

/**
 * @returns {Promise<{ ok: boolean, reason?: string, latencyMs?: number }>}
 */
async function testProviderKey(hubSvc, providerId, apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) return { ok: false, reason: "no_api_key" };
  try {
    const adapter = loadAdapter(hubSvc, providerId, key);
    const r = await adapter.query(TEST_PROMPT);
    if (r.ok) return { ok: true, latencyMs: r.latencyMs };
    return { ok: false, reason: String(r.reason || "request_failed") };
  } catch (e) {
    return { ok: false, reason: e.message || "exception" };
  }
}

module.exports = { testProviderKey, TEST_PROMPT };
