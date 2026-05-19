const BaseAdapter = require("./BaseAdapter");
const { parseTradeDecision } = require("./OpenAIAdapter");

class DeepSeekAdapter extends BaseAdapter {
  constructor(opts) { super({ name: "deepseek", ...opts }); }

  _buildRequest(prompt) {
    return {
      url: "https://api.deepseek.com/chat/completions",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      data: {
        model: "deepseek-chat",
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

module.exports = { DeepSeekAdapter };
