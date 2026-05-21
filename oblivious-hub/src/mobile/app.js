// OBLIVIOUS — MOBILE PWA controller.
// Flow:
//   1. /m/?t=TOKEN  → pre-fill pair form, POST /m/pair to register the device
//                      (returns device_id + long-lived secret stored in
//                       localStorage)
//   2. /m/auth      → exchange (id, secret) for a session string
//   3. /m/ws        → bi-di WSS stream (snapshot from server every 1s,
//                      commands from client: close_position / cancel_pending /
//                      hold)
// Storage keys:
//   ob_mob.id      — device_id
//   ob_mob.secret  — long-lived per-device secret (NOT a session)
//   ob_mob.name    — friendly device name
(function () {
  const $ = (id) => document.getElementById(id);
  const LS = { id: "ob_mob.id", sec: "ob_mob.secret", name: "ob_mob.name" };

  const state = {
    sessionStr: null,
    ws:         null,
    snapshot:   null,
    role:       "viewer",
  };

  function setMsg(text, kind = "") {
    const el = $("pair-msg"); if (!el) return;
    el.textContent = text || "";
    el.className   = "msg " + (kind || "");
  }
  function showDash(on) {
    $("screen-pair").hidden = !!on;
    $("screen-dash").hidden = !on;
    $("screen-settings").hidden = true;
    $("logout-btn").hidden  = !on;
    $("settings-btn").hidden = !on || state.role !== "admin";
  }
  function showSettings() {
    $("screen-pair").hidden = true;
    $("screen-dash").hidden = true;
    $("screen-settings").hidden = false;
  }
  function setWsState(label, online) {
    $("ws-label").textContent = label;
    $("ws-dot").classList.toggle("online", !!online);
  }
  function fmtMoney(v) {
    if (v == null || isNaN(+v)) return "—";
    const n = +v;
    return `${n >= 0 ? "" : "-"}$${Math.abs(n).toFixed(2)}`;
  }

  async function api(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const j = await r.json().catch(() => ({ ok: false, reason: "bad_json" }));
    if (!r.ok && !j.reason) j.reason = `http_${r.status}`;
    return j;
  }

  async function doPair(token, name) {
    setMsg("Pairing…");
    const platform = (navigator.userAgentData?.platform) || navigator.platform || "web";
    const r = await api("/m/pair", { token, device_name: name || "Mobile", platform });
    if (!r.ok) { setMsg(`Pairing failed: ${r.reason}`, "err"); return false; }
    localStorage.setItem(LS.id,   r.device_id);
    localStorage.setItem(LS.sec,  r.secret);
    localStorage.setItem(LS.name, name || "Mobile");
    setMsg("Paired ✓ — signing in…", "ok");
    return doAuthAndConnect(r.device_id, r.secret);
  }

  async function doAuthAndConnect(id, secret) {
    const r = await api("/m/auth", { device_id: id, secret });
    if (!r.ok) { setMsg(`Sign-in failed: ${r.reason}`, "err"); return false; }
    state.sessionStr = r.session;
    state.role       = r.role || "viewer";
    showDash(true);
    openWs();
    return true;
  }

  function openWs() {
    if (state.ws) { try { state.ws.close(); } catch (_) {} }
    const proto = (location.protocol === "https:") ? "wss" : "ws";
    const url   = `${proto}://${location.host}/m/ws?session=${encodeURIComponent(state.sessionStr)}`;
    setWsState("connecting…", false);
    const ws = new WebSocket(url);
    state.ws = ws;
    ws.onopen    = () => { setWsState("online", true); log("WS opened"); };
    ws.onclose   = (ev) => {
      setWsState(`closed (${ev.code})`, false);
      log(`WS closed ${ev.code} ${ev.reason || ""}`);
      // Auto-reconnect if not unauthorised
      if (ev.code !== 4401 && state.sessionStr) {
        setTimeout(() => openWs(), 2500);
      }
    };
    ws.onerror   = () => log("WS error", "err");
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "snapshot") { state.snapshot = msg; paintAll(msg); }
      else if (msg.type === "kick") {
        log(`KICKED: ${msg.reason}`, "err");
        signOut();
      } else if (msg.type === "ack") {
        log(`ACK ${msg.op}: ${JSON.stringify(msg).slice(0, 140)}`);
      } else if (msg.type === "error") {
        log(`ERR ${msg.op}: ${msg.reason}`, "err");
      }
    };
  }

  function sendOp(op, extra) {
    if (!state.ws || state.ws.readyState !== 1) { log("WS not ready", "err"); return; }
    state.ws.send(JSON.stringify({ op, ...(extra || {}) }));
  }

  // Promise-based ack matcher: resolves on the next ack/error frame
  // matching `op`. Used by the Settings drawer flows so we can show
  // inline status (success / `reason`) instead of relying on the LOG card.
  function awaitOp(op, extra, timeoutMs = 4000) {
    return new Promise((resolve) => {
      if (!state.ws || state.ws.readyState !== 1) {
        return resolve({ ok: false, reason: "ws_not_ready" });
      }
      const onMsg = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if ((m.type === "ack" || m.type === "error") && m.op === op) {
          state.ws.removeEventListener("message", onMsg);
          clearTimeout(to);
          resolve(m.type === "ack" ? { ok: m.ok !== false, ...m } : { ok: false, reason: m.reason });
        }
      };
      const to = setTimeout(() => {
        state.ws.removeEventListener("message", onMsg);
        resolve({ ok: false, reason: "timeout" });
      }, timeoutMs);
      state.ws.addEventListener("message", onMsg);
      state.ws.send(JSON.stringify({ op, ...(extra || {}) }));
    });
  }

  function paintAll(s) {
    // Account
    const a = s.account || {};
    $("acc-balance").textContent = fmtMoney(a.balance);
    $("acc-equity").textContent  = fmtMoney(a.equity);
    $("acc-symbol").textContent  = a.symbol || "—";
    $("acc-spread").textContent  = a.spread != null ? String(a.spread) : "—";

    // Refresh own TOTP state from snapshot.devices (server is authoritative)
    if (Array.isArray(s.devices)) {
      const myId = localStorage.getItem(LS.id);
      const me   = s.devices.find((d) => d.device_id === myId);
      paintTotpState(!!(me && me.totp_active));
    }

    // Decision
    const d = (s.decision && (s.decision.last || s.decision)) || {};
    const bias = (d.of_bias || d.bias || "—").toUpperCase();
    $("dec-bias").textContent = bias;
    $("dec-conf").textContent = d.of_confidence != null ? `${d.of_confidence}%` : "—";
    $("dec-sig").textContent  = d.of_signal || d.signal || "—";

    // Positions
    const positions = Array.isArray(s.positions) ? s.positions : [];
    $("pos-count").textContent = positions.length;
    paintList("positions-list", positions, "no active positions", (p) => {
      const side = (p.side || (p.type === 0 ? "BUY" : "SELL") || "").toUpperCase();
      const pnl  = +p.profit || +p.pnl || 0;
      return `<div class="row">
        <div class="row-h">
          <span class="ticket">#${escapeHtml(p.ticket)}</span>
          <span class="side-${side}">${side} ${escapeHtml(p.sym || p.symbol || "")} · ${escapeHtml(p.lots ?? p.volume)}</span>
        </div>
        <div class="meta">
          <span>Entry ${escapeHtml(p.entry || p.open_price)}</span>
          <span>SL ${escapeHtml(p.sl)} / TP ${escapeHtml(p.tp)}</span>
          <span class="${pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmtMoney(pnl)}</span>
        </div>
        <button class="btn-danger" data-close="${escapeHtml(p.ticket)}" data-testid="m-close-${escapeHtml(p.ticket)}">CLOSE POSITION</button>
      </div>`;
    });

    // Pending
    const pending = Array.isArray(s.pending) ? s.pending : [];
    $("pen-count").textContent = pending.length;
    paintList("pending-list", pending, "no pending orders", (p) => {
      const t = (p.type_name || p.kind || "PENDING").toUpperCase();
      return `<div class="row">
        <div class="row-h">
          <span class="ticket">#${escapeHtml(p.ticket)}</span>
          <span>${t} ${escapeHtml(p.sym || p.symbol)} · ${escapeHtml(p.lots ?? p.volume)}</span>
        </div>
        <div class="meta">
          <span>Price ${escapeHtml(p.price)}</span>
          <span>SL ${escapeHtml(p.sl)} / TP ${escapeHtml(p.tp)}</span>
        </div>
        <button class="btn-warn" data-cancel="${escapeHtml(p.ticket)}" data-testid="m-cancel-${escapeHtml(p.ticket)}">CANCEL ORDER</button>
      </div>`;
    });

    // News next
    const next = (s.news?.upcoming || s.news?.next || [])[0] || null;
    if (next) {
      const eta = next.time ? Math.max(0, Math.round((next.time - Date.now()) / 60000)) : "?";
      $("news-next").innerHTML = `<b>${escapeHtml(next.country || next.cur || "")}</b> ${escapeHtml(next.title || next.event || "")} <span style="color:var(--muted)">in ${eta}m · ${escapeHtml(String(next.impact || "").toUpperCase())}</span>`;
    } else $("news-next").textContent = "no upcoming event";

    // Recent log lines
    if (Array.isArray(s.logs)) {
      const wrap = $("log-stream");
      wrap.innerHTML = s.logs.slice(-15).map((l) => {
        const lvl = (l.level || "info").toLowerCase();
        return `<div class="line ${lvl === "error" ? "err" : ""}">[${escapeHtml((l.source || "").slice(0,4))}] ${escapeHtml(l.message || "")}</div>`;
      }).join("");
    }
  }

  function paintList(elId, items, emptyText, rowFn) {
    const el = $(elId);
    if (!items.length) { el.innerHTML = `<div class="empty">${emptyText}</div>`; return; }
    el.innerHTML = items.map(rowFn).join("");
    el.querySelectorAll("button[data-close]").forEach((b) => {
      b.onclick = () => {
        if (!confirm(`Close position #${b.dataset.close}?`)) return;
        sendOp("close_position", { ticket: +b.dataset.close });
      };
    });
    el.querySelectorAll("button[data-cancel]").forEach((b) => {
      b.onclick = () => {
        if (!confirm(`Cancel pending #${b.dataset.cancel}?`)) return;
        sendOp("cancel_pending", { ticket: +b.dataset.cancel });
      };
    });
  }

  function log(msg, kind = "") {
    const el = $("log-stream"); if (!el) return;
    const t = new Date().toLocaleTimeString();
    const line = document.createElement("div");
    line.className = "line " + (kind === "err" ? "err" : "");
    line.textContent = `[${t}] ${msg}`;
    el.appendChild(line);
    while (el.children.length > 50) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s ?? "—").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function signOut() {
    state.sessionStr = null;
    try { state.ws?.close(); } catch (_) {}
    state.ws = null;
    showDash(false);
    setWsState("offline", false);
  }

  // ── TOTP + API key (admin settings) ───────────────────────────────
  function paintTotpState(active) {
    const b = $("totp-state"); if (!b) return;
    b.textContent = active ? "ACTIVE" : "OFF";
    b.className   = "badge " + (active ? "on" : "off");
    $("totp-disable-btn").hidden = !active;
    // Hide setup block once active; user must DISABLE to re-enroll.
    if (active) $("totp-setup-wrap").hidden = true;
  }
  function setMsgOn(elId, text, kind = "") {
    const el = $(elId); if (!el) return;
    el.textContent = text || "";
    el.className   = "msg " + (kind || "");
  }
  async function enrollTotp() {
    setMsgOn("totp-msg", "Generating new secret…");
    const r = await awaitOp("totp_enroll");
    if (!r.ok) return setMsgOn("totp-msg", `Enroll failed: ${r.reason}`, "err");
    $("totp-setup-wrap").hidden = false;
    if (r.qrDataUrl) {
      $("totp-qr-img").src = r.qrDataUrl;
      $("totp-qr-img").style.display = "";
    } else {
      $("totp-qr-img").style.display = "none";
    }
    $("totp-secret").textContent = r.secret;
    setMsgOn("totp-msg",
      "Scan the QR (or paste the secret) in your authenticator app, then enter the current code.",
      "ok");
  }
  async function confirmTotp() {
    const code = $("totp-confirm-code").value.trim();
    if (!/^\d{6}$/.test(code)) return setMsgOn("totp-msg", "6-digit code required", "err");
    setMsgOn("totp-msg", "Confirming…");
    const r = await awaitOp("totp_confirm", { code });
    if (!r.ok) return setMsgOn("totp-msg", `Failed: ${r.reason}`, "err");
    $("totp-confirm-code").value = "";
    paintTotpState(true);
    setMsgOn("totp-msg", "TOTP enrolled ✓", "ok");
  }
  async function disableTotp() {
    const code = prompt("Enter current TOTP code to disable step-up:");
    if (!code) return;
    setMsgOn("totp-msg", "Disabling…");
    const r = await awaitOp("totp_disable", { code: code.trim() });
    if (!r.ok) return setMsgOn("totp-msg", `Disable failed: ${r.reason}`, "err");
    paintTotpState(false);
    setMsgOn("totp-msg", "TOTP disabled", "ok");
  }
  async function submitApiKey(ev) {
    ev.preventDefault();
    const provider = $("key-provider").value;
    const key      = $("key-value").value.trim();
    const stepUp   = $("key-stepup").value.trim();
    if (!provider || !key) return setMsgOn("key-msg", "Provider and key required", "err");
    if (!/^\d{6}$/.test(stepUp)) return setMsgOn("key-msg", "6-digit TOTP required", "err");
    setMsgOn("key-msg", "Sending…");
    const r = await awaitOp("update_api_key", { provider, key, stepUp });
    if (!r.ok) return setMsgOn("key-msg", `Failed: ${r.reason}`, "err");
    $("key-value").value = "";
    $("key-stepup").value = "";
    setMsgOn("key-msg", `API key updated for ${provider} ✓`, "ok");
  }

  // ── Boot ──────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", async () => {
    setWsState("offline", false);
    // Hold buttons
    document.querySelectorAll("button[data-op='hold']").forEach((b) => {
      b.onclick = () => sendOp("hold", { symbol: state.snapshot?.account?.symbol, enable: b.dataset.enable === "1" });
    });
    // Logout
    $("logout-btn").onclick = () => {
      if (!confirm("Sign out of this session? (Device stays paired.)")) return;
      signOut();
    };
    // Settings drawer (admin only)
    $("settings-btn").onclick = showSettings;
    $("settings-back").onclick = () => {
      $("screen-settings").hidden = true;
      $("screen-dash").hidden = false;
    };
    $("totp-enroll-btn").onclick  = enrollTotp;
    $("totp-confirm-btn").onclick = confirmTotp;
    $("totp-disable-btn").onclick = disableTotp;
    $("key-form").addEventListener("submit", submitApiKey);
    // Pair form
    $("pair-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const tok  = $("pair-token").value.trim();
      const name = $("pair-name").value.trim();
      if (!tok) return setMsg("Token required", "err");
      doPair(tok, name);
    });
    // Sign-in (returning device)
    $("signin-form").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const id  = $("si-id").value.trim();
      const sec = $("si-secret").value.trim();
      if (!id || !sec) return setMsg("Device ID + secret required", "err");
      doAuthAndConnect(id, sec).then((ok) => {
        if (!ok) return;
        localStorage.setItem(LS.id,  id);
        localStorage.setItem(LS.sec, sec);
      });
    });

    // Pre-fill token from URL (?t=...)
    const params = new URLSearchParams(location.search);
    const t = params.get("t") || params.get("token");
    if (t) {
      $("pair-token").value = t;
      $("pair-name").value  = localStorage.getItem(LS.name) || "";
    }

    // Auto-resume if we already have credentials
    const savedId  = localStorage.getItem(LS.id);
    const savedSec = localStorage.getItem(LS.sec);
    if (savedId && savedSec && !t) {
      const ok = await doAuthAndConnect(savedId, savedSec);
      if (!ok) { /* stay on pairing screen */ }
    }
  });
})();
