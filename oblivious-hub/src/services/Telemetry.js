// OBLIVIOUS HUB — Telemetry
// ----------------------------------------------------------------
// Tiny in-memory ring buffer + IPC fan-out. Every service in main.js
// receives a `telemetry` reference and calls `.log(level, source, msg)`
// or `.emit(channel, payload)` to push into the renderer.
// ----------------------------------------------------------------

const MAX_LOGS = 500;

class Telemetry {
  constructor({ emit } = {}) {
    this._buf = [];
    this._emit = typeof emit === "function" ? emit : () => {};
  }

  log(level, source, msg) {
    const entry = {
      t:      Date.now(),
      level:  String(level || "info").toLowerCase(),
      src:    String(source || "Hub"),
      msg:    String(msg ?? ""),
    };
    this._buf.push(entry);
    if (this._buf.length > MAX_LOGS) this._buf.shift();
    // Fan out to renderer.
    try { this._emit("hub:logs", entry); } catch (_) {}
    // Mirror to console for `npm start` debugging.
    const line = `[${entry.src}] ${entry.msg}`;
    if (entry.level === "error")      console.error(line);
    else if (entry.level === "warn")  console.warn(line);
    else                              console.log(line);
  }

  emit(channel, payload) {
    try { this._emit(channel, payload); } catch (_) {}
  }

  recent(n) {
    if (!n) return this._buf.slice();
    return this._buf.slice(-n);
  }
}

module.exports = Telemetry;
