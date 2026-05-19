//+------------------------------------------------------------------+
//|  OBLIVIOUS HUB — Stream-3 ORDERFLOW DECISION subscriber          |
//|  Topic:  "oblivious.decision"                                    |
//|  Bind:   tcp://127.0.0.1:5556   (ZmqBridge SUB ↔ PUB port)        |
//|                                                                  |
//|  Each frame is a compact JSON payload published every ~150 ms by |
//|  the Python Bookmap bridge, per tracked symbol:                  |
//|                                                                  |
//|    {"type":"decision","symbol":"XAUUSD","ts":1739817600000,      |
//|     "of_bias":"bullish","of_confidence":71,"of_signal":"SWEEP_BUY"} |
//|                                                                  |
//|  Drop this file alongside your EA OR copy the relevant sections  |
//|  into your existing EA. Requires libzmq.dll + mql-zmq wrapper    |
//|  (https://github.com/dingmaotu/mql-zmq) — same dependency the    |
//|  Hub already uses on the ZMQ_REQ_PORT channel.                   |
//+------------------------------------------------------------------+
#property strict
#property version   "1.00"
#include <Zmq/Zmq.mqh>

input string  InpZmqHost     = "tcp://127.0.0.1:5556";
input string  InpFilterSym   = "XAUUSD";   // empty string = subscribe ALL symbols
input int     InpStaleMs     = 1500;       // ignore frames older than this
input int     InpMinConfidence = 60;       // only act when of_confidence ≥ this

//─── ZMQ singletons ────────────────────────────────────────────────
Context  *g_ctx = NULL;
Socket   *g_sub = NULL;

//─── Latest decision cache (exposed to the rest of the EA) ─────────
struct OFDecision {
  string  symbol;
  string  bias;          // "bullish" | "bearish" | "neutral"
  int     confidence;    // 0–100
  string  signal;        // e.g. "ICEBERG_BID", "SWEEP_BUY", ...
  datetime ts;           // ms epoch (truncated to seconds)
};
OFDecision g_lastDecision;

//+------------------------------------------------------------------+
int OnInit() {
  g_ctx = new Context("OBLIVIOUS-DEC");
  g_sub = new Socket(g_ctx, ZMQ_SUB);
  if (!g_sub.connect(InpZmqHost)) {
    Print("[OBLIVIOUS] decision SUB connect failed: ", InpZmqHost);
    return INIT_FAILED;
  }
  // ZMQ topic filter — empty bytes = receive everything
  g_sub.subscribe("oblivious.decision");
  PrintFormat("[OBLIVIOUS] subscribed to oblivious.decision @ %s (filter sym=%s)",
              InpZmqHost, InpFilterSym);
  EventSetMillisecondTimer(50);
  return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason) {
  EventKillTimer();
  if (g_sub) { g_sub.disconnect(InpZmqHost); delete g_sub; g_sub = NULL; }
  if (g_ctx) { delete g_ctx; g_ctx = NULL; }
}

//+------------------------------------------------------------------+
//|  Tiny JSON helper — supports the flat decision payload only.     |
//+------------------------------------------------------------------+
string JsonStr(const string &src, const string key) {
  string pat = "\"" + key + "\":\"";
  int i = StringFind(src, pat);
  if (i < 0) return "";
  i += StringLen(pat);
  int j = StringFind(src, "\"", i);
  if (j < 0) return "";
  return StringSubstr(src, i, j - i);
}
double JsonNum(const string &src, const string key) {
  string pat = "\"" + key + "\":";
  int i = StringFind(src, pat);
  if (i < 0) return 0.0;
  i += StringLen(pat);
  int j = i;
  while (j < StringLen(src) && StringFind("0123456789.-", StringSubstr(src, j, 1)) >= 0) j++;
  return StringToDouble(StringSubstr(src, i, j - i));
}

//+------------------------------------------------------------------+
void OnTimer() {
  if (!g_sub) return;
  ZmqMsg topic, body;
  // Non-blocking receive — we poll up to 4 frames per tick to drain bursts
  for (int k = 0; k < 4; k++) {
    if (!g_sub.recv(topic, ZMQ_DONTWAIT)) break;
    if (!g_sub.recv(body,  ZMQ_DONTWAIT)) break;
    string payload = body.getData();
    string sym  = JsonStr(payload, "symbol");
    if (InpFilterSym != "" && sym != InpFilterSym) continue;
    string bias = JsonStr(payload, "of_bias");
    string sig  = JsonStr(payload, "of_signal");
    int conf    = (int)JsonNum(payload, "of_confidence");
    long ts_ms  = (long)JsonNum(payload, "ts");
    // Staleness guard — bridge → MT4 latency on Win is < 50 ms
    if (TimeCurrent() * 1000 - ts_ms > InpStaleMs) continue;

    g_lastDecision.symbol     = sym;
    g_lastDecision.bias       = bias;
    g_lastDecision.confidence = conf;
    g_lastDecision.signal     = sig;
    g_lastDecision.ts         = (datetime)(ts_ms / 1000);

    // ── Wire here whatever logic you want the EA to react with ──
    // Example: only allow new BUYs when bias is bullish + conf ≥ threshold.
    if (conf >= InpMinConfidence) {
      PrintFormat("[OBLIVIOUS] %s  bias=%s  conf=%d  sig=%s",
                  sym, bias, conf, sig);
    }
  }
}

//+------------------------------------------------------------------+
//|  Public helper your main EA can call before opening a trade.     |
//+------------------------------------------------------------------+
bool OF_AllowBuy(string sym = "") {
  if (sym == "") sym = _Symbol;
  if (g_lastDecision.symbol != sym) return true;            // no data → don't block
  if (g_lastDecision.confidence < InpMinConfidence) return true;
  return g_lastDecision.bias == "bullish";
}
bool OF_AllowSell(string sym = "") {
  if (sym == "") sym = _Symbol;
  if (g_lastDecision.symbol != sym) return true;
  if (g_lastDecision.confidence < InpMinConfidence) return true;
  return g_lastDecision.bias == "bearish";
}
