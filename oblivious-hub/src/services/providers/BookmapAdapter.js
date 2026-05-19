// OBLIVIOUS HUB — BookmapAdapter
// ----------------------------------------------------------------
// Validates the user's Bookmap subscription / addon key by:
//   1. Probing the local Bookmap Python-API WebSocket (default
//      ws://127.0.0.1:8081) — succeeds when Bookmap is running with
//      the addon enabled.
//   2. Optionally storing the cloud subscription key for the L2 / MBO
//      feeds (used by BookmapClient.start()).
//
// Unlike the AI adapters this does NOT call any remote LLM — the
// "test" is a 2-second WebSocket handshake against the user's
// localhost Bookmap instance.
// ----------------------------------------------------------------

const { BaseAdapter } = require("./_BaseAdapter");

let WebSocketLib = null;
try { WebSocketLib = require("ws"); } catch (_) {}

class BookmapAdapter extends BaseAdapter {
  constructor({ apiKey, url } = {}) {
    super({ apiKey, name: "bookmap" });
    this.url = url || "ws://127.0.0.1:8081";
  }

  async _doQuery() {
    // Adapter has no LLM path — query() is unused but BaseAdapter
    // requires a definition. We just probe the WS handshake.
    return this._probe();
  }

  async _doTest() {
    return this._probe();
  }

  _probe() {
    return new Promise((resolve) => {
      if (!WebSocketLib) {
        resolve({ status: 0, err: "ws_module_missing" });
        return;
      }
      let done = false;
      let ws;
      try {
        const headers = this.apiKey
          ? { "X-Bookmap-Key": this.apiKey, "Authorization": `Bearer ${this.apiKey}` }
          : {};
        ws = new WebSocketLib(this.url, { headers, handshakeTimeout: 4000 });
      } catch (e) {
        resolve({ status: 0, err: e.message });
        return;
      }
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        try { ws.terminate(); } catch (_) {}
        resolve({ status: 0, err: "timeout" });
      }, 4000);

      ws.once("open", () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { ws.close(); } catch (_) {}
        resolve({ status: 200, text: "connected", json: { ok: true, url: this.url } });
      });
      ws.once("error", (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ status: 0, err: e.message || "ws_error" });
      });
      ws.once("close", () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ status: 0, err: "closed_before_open" });
      });
    });
  }
}

module.exports = { BookmapAdapter };
