// Perplexity adapter (OpenAI-compatible chat completions).
const { BaseAdapter, httpsRequest } = require("./_BaseAdapter");

class PerplexityAdapter extends BaseAdapter {
  constructor({ apiKey }) { super({ apiKey, name: "perplexity" }); }

  async _doQuery({ system, user }) {
    return httpsRequest({
      url:    "https://api.perplexity.ai/chat/completions",
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: {
        model: "sonar-pro",
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

  // Perplexity has no public /models endpoint, so we send the smallest
  // possible chat completion (1 token, cheapest model). Their `sonar`
  // tier costs ≈ $0.0001/test so the validation is effectively free.
  async _doTest() {
    return httpsRequest({
      url:    "https://api.perplexity.ai/chat/completions",
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: {
        model: "sonar",
        messages: [{ role: "user", content: "." }],
        max_tokens:  1,
        temperature: 0,
      },
      timeoutMs: 8_000,
    });
  }
}

module.exports = { PerplexityAdapter };
