// DeepSeek adapter (OpenAI-compatible chat completions).
const { BaseAdapter, httpsRequest } = require("./_BaseAdapter");

class DeepSeekAdapter extends BaseAdapter {
  constructor({ apiKey }) { super({ apiKey, name: "deepseek" }); }

  async _doQuery({ system, user }) {
    return httpsRequest({
      url:    "https://api.deepseek.com/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: {
        model: "deepseek-chat",
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

  // GET /v1/models is free regardless of balance — even with 0 credits the
  // endpoint returns 200, so this won't trip on "Insufficient Balance" (402).
  async _doTest() {
    return httpsRequest({
      url:    "https://api.deepseek.com/v1/models",
      method: "GET",
      headers: { "Authorization": `Bearer ${this.apiKey}` },
      timeoutMs: 8_000,
    });
  }

  // DeepSeek publishes a user balance endpoint: returns USD balance + topped
  // up + granted credits. Refreshed every 60s by ProviderRouter.
  async _doBalance() {
    const res = await httpsRequest({
      url:    "https://api.deepseek.com/user/balance",
      method: "GET",
      headers: { "Authorization": `Bearer ${this.apiKey}` },
      timeoutMs: 8_000,
    });
    if (res.status !== 200) return null;
    const info = res.json?.balance_infos?.[0];
    if (!info) return null;
    return {
      total:    parseFloat(info.total_balance || "0"),
      currency: info.currency || "USD",
    };
  }
}

module.exports = { DeepSeekAdapter };
