// OBLIVIOUS HUB — TelegramNotifier.
//
// Subscribes to DecisionEngine "execute" events and posts a Telegram
// message when an EXECUTE_ORDER is emitted with conf >= TELEGRAM_MIN_CONF
// (default 0.8). Silent no-op if TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID
// are missing — operator can leave them blank in .env.
//
// Optional Discord mirror: set DISCORD_WEBHOOK_URL to receive the same
// alert there (POST as a JSON {content} payload).
//
// Rate limited to 1 message / 3s / sym to avoid spam during burst
// trading windows.

const axios = require("axios").default;

const DEFAULT_MIN_CONF = 0.8;
const COOLDOWN_MS      = 3000;

class TelegramNotifier {
  constructor({ telemetry } = {}) {
    this.telemetry  = telemetry;
    this.botToken   = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
    this.chatId     = (process.env.TELEGRAM_CHAT_ID   || "").trim();
    this.discordUrl = (process.env.DISCORD_WEBHOOK_URL || "").trim();
    this.minConf    = +process.env.TELEGRAM_MIN_CONF || DEFAULT_MIN_CONF;
    this._lastBySym = new Map();
    this._enabled   = !!(this.botToken && this.chatId) || !!this.discordUrl;
  }

  enabled() { return this._enabled; }

  bind(decisionEngine) {
    if (!decisionEngine || typeof decisionEngine.on !== "function") return;
    decisionEngine.on("execute", (payload) => this._onExecute(payload));
    if (this.telemetry) {
      const ch = [
        this.botToken && this.chatId ? "telegram" : null,
        this.discordUrl ? "discord" : null,
      ].filter(Boolean).join("+");
      this.telemetry.log("info", "Notifier",
        this._enabled
          ? `subscribed (channels=${ch}, minConf=${this.minConf})`
          : "no credentials in .env — alerts disabled");
    }
  }

  async _onExecute(payload) {
    if (!this._enabled || !payload) return;
    const conf = +payload.conf;
    if (!isFinite(conf) || conf < this.minConf) return;

    const sym = payload.sym || "?";
    const now = Date.now();
    const last = this._lastBySym.get(sym) || 0;
    if (now - last < COOLDOWN_MS) return;
    this._lastBySym.set(sym, now);

    const text = this._format(payload);
    await Promise.allSettled([
      this._sendTelegram(text),
      this._sendDiscord(text),
    ]);
  }

  _format(p) {
    const lines = [
      "🤖 *OBLIVIOUS EXECUTE*",
      `Symbol: \`${p.sym}\``,
      `Side: *${p.dir || "?"}*  Conf: *${(+p.conf).toFixed(2)}*`,
    ];
    if (p.signal) lines.push(`Signal: ${p.signal}`);
    if (p.provider) lines.push(`Provider: ${p.provider}`);
    if (p.entry) lines.push(`Entry: \`${p.entry}\``);
    if (p.sl)    lines.push(`SL: \`${p.sl}\``);
    if (p.tp1)   lines.push(`TP1: \`${p.tp1}\``);
    if (p.corr)  lines.push(`corr: \`${p.corr.slice(0, 8)}\``);
    return lines.join("\n");
  }

  async _sendTelegram(text) {
    if (!this.botToken || !this.chatId) return;
    try {
      await axios.post(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        { chat_id: this.chatId, text, parse_mode: "Markdown", disable_web_page_preview: true },
        { timeout: 5000, validateStatus: () => true }
      );
    } catch (err) {
      if (this.telemetry) {
        this.telemetry.log("warn", "Notifier", `telegram send failed: ${err.message}`);
      }
    }
  }

  async _sendDiscord(text) {
    if (!this.discordUrl) return;
    try {
      // Discord doesn't render Telegram Markdown 1:1, but `*bold*` and
      // `\`code\`` map close enough; we strip the leading "🤖 *…*" stars
      // by sending content as-is.
      await axios.post(
        this.discordUrl,
        { content: text },
        { timeout: 5000, validateStatus: () => true }
      );
    } catch (err) {
      if (this.telemetry) {
        this.telemetry.log("warn", "Notifier", `discord send failed: ${err.message}`);
      }
    }
  }
}

module.exports = TelegramNotifier;
