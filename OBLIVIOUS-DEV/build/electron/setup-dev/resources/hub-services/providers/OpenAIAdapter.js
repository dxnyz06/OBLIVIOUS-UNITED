const BaseAdapter = require("./BaseAdapter");

class OpenAIAdapter extends BaseAdapter {
  constructor(opts) { super({ name: "openai", ...opts }); }

  _buildRequest(prompt) {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      data: {
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: prompt.system },
          { role: "user",   content: prompt.user   },
        ],
        temperature: 0.2,
        max_tokens: 200,
      },
    };
  }

  _parseResponse(data) {
    const text = data?.choices?.[0]?.message?.content || "";
    return parseTradeDecision(text);
  }
}

function parseTradeDecision(text) {
  // Expects JSON-ish output: {"dir":"BUY","conf":0.78,"signal":"impulse"}
  // Falls back to keyword search if the model is chatty.
  try {
    const m = text.match(/\{[\s\S]*?\}/);
    if (m) {
      const j = JSON.parse(m[0]);
      const dir = String(j.dir || "HOLD").toUpperCase();
      return {
        dir,
        conf:   Math.max(0, Math.min(1, +j.conf || 0)),
        signal: j.signal || "",
        raw:    text,
      };
    }
  } catch (_) { /* fall through */ }
  const upper = text.toUpperCase();
  let dir = "HOLD";
  if (upper.includes("BUY"))  dir = "BUY";
  else if (upper.includes("SELL")) dir = "SELL";
  return { dir, conf: 0.5, signal: "freeform", raw: text };
}

module.exports = { OpenAIAdapter, parseTradeDecision };
