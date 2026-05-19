// Anthropic Claude adapter (Messages API).
const { BaseAdapter, httpsRequest } = require("./_BaseAdapter");

class AnthropicAdapter extends BaseAdapter {
  constructor({ apiKey }) { super({ apiKey, name: "anthropic" }); }

  async _doQuery({ system, user }) {
    return httpsRequest({
      url:    "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model:      "claude-3-5-sonnet-latest",
        max_tokens: 40,
        system:     system || "",
        messages:   [{ role: "user", content: user || "ping" }],
      },
      timeoutMs: 10_000,
    });
  }
  _extractContent(json) {
    return json?.content?.[0]?.text || JSON.stringify(json || {}).slice(0, 600);
  }

  // Cheapest validation: 1-token messages call. Anthropic doesn't expose
  // a free `/models` endpoint, so the smallest possible message is used.
  async _doTest() {
    return httpsRequest({
      url:    "https://api.anthropic.com/v1/messages",
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model:      "claude-3-5-haiku-latest",
        max_tokens: 1,
        messages:   [{ role: "user", content: "." }],
      },
      timeoutMs: 8_000,
    });
  }
}

module.exports = { AnthropicAdapter };
