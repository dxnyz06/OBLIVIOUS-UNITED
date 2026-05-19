const BaseAdapter = require("./BaseAdapter");
const { parseTradeDecision } = require("./OpenAIAdapter");

class XAIAdapter extends BaseAdapter {
  constructor(opts) { super({ name: "xai", ...opts }); }

  _buildRequest(prompt) {
    return {
      url: "https://api.x.ai/v1/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      data: {
        model: "grok-2-latest",
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

module.exports = { XAIAdapter };
