// Qwen (Alibaba DashScope OpenAI-compatible endpoint).
const { BaseAdapter, httpsRequest } = require("./_BaseAdapter");

class QwenAdapter extends BaseAdapter {
  constructor({ apiKey }) { super({ apiKey, name: "qwen" }); }

  async _doQuery({ system, user }) {
    return httpsRequest({
      url:    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: {
        model: "qwen-turbo",
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

  // DashScope compat-mode exposes the standard OpenAI GET /v1/models route.
  // Zero tokens consumed — works even on free-tier keys without quota.
  async _doTest() {
    return httpsRequest({
      url:    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
      method: "GET",
      headers: { "Authorization": `Bearer ${this.apiKey}` },
      timeoutMs: 8_000,
    });
  }
}

module.exports = { QwenAdapter };
