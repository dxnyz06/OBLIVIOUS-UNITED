// OpenAI chat-completions adapter.
const { BaseAdapter, httpsRequest } = require("./_BaseAdapter");

class OpenAIAdapter extends BaseAdapter {
  constructor({ apiKey }) { super({ apiKey, name: "openai" }); }

  async _doQuery({ system, user }) {
    return httpsRequest({
      url:    "https://api.openai.com/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: {
        model: "gpt-4o-mini",
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

  // Validation path — uses the cheap GET /v1/models endpoint.
  // - Returns 200 for any valid key (even free-tier / out-of-credits).
  // - 401 = invalid key, 429 only triggers if the user hammers it.
  // No tokens consumed, no per-minute TPM cost.
  async _doTest() {
    return httpsRequest({
      url:    "https://api.openai.com/v1/models",
      method: "GET",
      headers: { "Authorization": `Bearer ${this.apiKey}` },
      timeoutMs: 8_000,
    });
  }
}

module.exports = { OpenAIAdapter };
