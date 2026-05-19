const BaseAdapter = require("./BaseAdapter");
const { parseTradeDecision } = require("./OpenAIAdapter");

class GoogleAdapter extends BaseAdapter {
  constructor(opts) { super({ name: "google", ...opts }); }

  _buildRequest(prompt) {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${this.apiKey}`,
      headers: { "content-type": "application/json" },
      data: {
        contents: [
          { role: "user", parts: [{ text: `${prompt.system}\n\n${prompt.user}` }] },
        ],
        generationConfig: { temperature: 0.2, maxOutputTokens: 200 },
      },
    };
  }

  _parseResponse(data) {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text  = parts.map((p) => p.text || "").join("");
    return parseTradeDecision(text);
  }
}

module.exports = { GoogleAdapter };
