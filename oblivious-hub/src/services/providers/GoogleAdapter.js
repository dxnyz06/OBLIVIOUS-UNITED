// Google Gemini adapter (generativelanguage.googleapis.com / v1beta).
const { BaseAdapter, httpsRequest } = require("./_BaseAdapter");

class GoogleAdapter extends BaseAdapter {
  constructor({ apiKey }) { super({ apiKey, name: "google" }); }

  async _doQuery({ system, user }) {
    const body = {
      contents: [{ role: "user", parts: [{ text: `${system || ""}\n\n${user || "ping"}` }] }],
      generationConfig: { maxOutputTokens: 40, temperature: 0 },
    };
    return httpsRequest({
      url:    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(this.apiKey)}`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      timeoutMs: 10_000,
    });
  }
  _extractContent(json) {
    return json?.candidates?.[0]?.content?.parts?.[0]?.text
        || JSON.stringify(json || {}).slice(0, 600);
  }

  // Cheap validation via GET /v1beta/models (no tokens consumed).
  async _doTest() {
    return httpsRequest({
      url:    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(this.apiKey)}`,
      method: "GET",
      headers: {},
      timeoutMs: 8_000,
    });
  }
}

module.exports = { GoogleAdapter };
