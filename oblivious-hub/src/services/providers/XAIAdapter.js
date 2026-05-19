// xAI / Grok adapter — uses OpenAI-compatible API at api.x.ai.
const { BaseAdapter, httpsRequest } = require("./_BaseAdapter");

class XAIAdapter extends BaseAdapter {
  constructor({ apiKey }) { super({ apiKey, name: "xai" }); }

  async _doQuery({ system, user }) {
    return httpsRequest({
      url:    "https://api.x.ai/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: {
        model: "grok-2-latest",
        messages: [
          { role: "system", content: system || "" },
          { role: "user",   content: user   || "ping" },
        ],
        max_tokens:  40,
        temperature: 0,
      },
      timeoutMs: 10_000,
    });
  }
  _extractContent(json) {
    return json?.choices?.[0]?.message?.content || JSON.stringify(json || {}).slice(0, 600);
  }

  // Cheap validation: GET /v1/models (OpenAI-compatible, no tokens).
  async _doTest() {
    return httpsRequest({
      url:    "https://api.x.ai/v1/models",
      method: "GET",
      headers: { "Authorization": `Bearer ${this.apiKey}` },
      timeoutMs: 8_000,
    });
  }
}

module.exports = { XAIAdapter };
