const BaseAdapter = require("./BaseAdapter");
const { parseTradeDecision } = require("./OpenAIAdapter");

class AnthropicAdapter extends BaseAdapter {
  constructor(opts) { super({ name: "anthropic", ...opts }); }

  _buildRequest(prompt) {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-api-key":     this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      data: {
        model: "claude-3-5-sonnet-latest",
        max_tokens: 200,
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
      },
    };
  }

  _parseResponse(data) {
    const text = data?.content?.[0]?.text || "";
    return parseTradeDecision(text);
  }
}

module.exports = { AnthropicAdapter };
