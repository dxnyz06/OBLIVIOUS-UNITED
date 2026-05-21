//+------------------------------------------------------------------+
//|  OBLIVIOUS HUB — Stream-3 ORDERFLOW DECISION subscriber (V2)     |
//|  Topic:  "oblivious.decision"                                    |
//|  Bind:   tcp://127.0.0.1:5556   (ZmqBridge SUB ↔ PUB port)        |
//|                                                                  |
//|  V2 adds:                                                        |
//|    • A full on-chart status panel (8 rows) updated every tick    |
//|    • Trigger annotations (vertical line + arrow + tag) on every  |
//|      decision whose confidence ≥ InpMinConfidence                |
//|    • OF_AllowBuy/Sell helpers callable from any other EA         |
//|    • Connection heartbeat — turns the status pill RED if the     |
//|      hub stops publishing for more than InpStaleMs ms            |
//|                                                                  |
//|  Each frame is a compact JSON payload published every ~150 ms by |
//|  the Python Bookmap bridge, per tracked symbol:                  |
//|                                                                  |
//|    {"type":"decision","symbol":"XAUUSD","ts":1779817600000,      |
//|     "of_bias":"bullish","of_confidence":71,                       |
//|     "of_signal":"ABSORPTION_BID",                                 |
//|     "of_imbalance":0.42,"of_delta_norm":0.55,                     |
//|     "of_absorption":0.71,"of_iceberg_pressure":0.40,              |
//|     "of_exhaustion":0.18,"of_agreement":0.78}                     |
//|                                                                  |
//|  Drop this EA on the chart you want the orderflow bias rendered  |
//|  on. The chart symbol is automatically used as filter (unless    |
//|  InpFilterSym is overridden).                                    |
//|                                                                  |
//|  Requires libzmq.dll + the mql-zmq wrapper:                      |
//|     https://github.com/dingmaotu/mql-zmq                         |
//|  (same dependency the Hub already uses on the ZMQ_REQ_PORT chan) |
//+------------------------------------------------------------------+
#property strict
#property version   "2.00"
#property description "OBLIVIOUS HUB Orderflow Decision Subscriber"
#include <Zmq/Zmq.mqh>

input string  InpZmqHost       = "tcp://127.0.0.1:5556";
input string  InpFilterSym     = "";            // empty = use _Symbol
input int     InpStaleMs       = 1500;          // ignore frames older than this
input int     InpMinConfidence = 60;            // act when of_confidence ≥ this
input bool    InpDrawTriggers  = true;          // arrow + vline on every strong signal
input int     InpMaxTriggers   = 50;            // ring-buffer cap for annotations
input bool    InpVerboseLog    = true;          // also log raw payloads to Experts tab

//─── ZMQ singletons ─────────────────────────────────────────────────
Context  *g_ctx = NULL;
Socket   *g_sub = NULL;

//─── Latest decision (callable from your main EA) ───────────────────
struct OFDecision {
   string  symbol;
   string  bias;               // "bullish" | "bearish" | "neutral"
   int     confidence;         // 0–100
   string  signal;             // "ABSORPTION_BID", "SWEEP_UP", …
   datetime ts;                // seconds (truncated from ms)
   double  delta_norm;
   double  imbalance;
   double  absorption;
   double  iceberg_pressure;
   double  exhaustion;
   double  agreement;
};
OFDecision g_lastDecision;
datetime   g_lastFrameTime = 0;          // wall-time of last received frame
int        g_frameCount    = 0;          // total frames seen this session
int        g_triggerSeq    = 0;          // monotone id for chart annotations

//─── On-chart panel object names (so OnDeinit can clean up) ─────────
#define OF_PFX  "OF_PANEL_"
string     g_panelNames[];

//+------------------------------------------------------------------+
int OnInit() {
   g_ctx = new Context("OBLIVIOUS-DEC");
   g_sub = new Socket(g_ctx, ZMQ_SUB);
   if (!g_sub.connect(InpZmqHost)) {
      Print("[OBLIVIOUS] decision SUB connect failed: ", InpZmqHost);
      return INIT_FAILED;
   }
   g_sub.subscribe("oblivious.decision");
   string filter = (InpFilterSym == "") ? _Symbol : InpFilterSym;
   PrintFormat("[OBLIVIOUS] V2 subscribed to oblivious.decision @ %s (filter sym=%s)",
               InpZmqHost, filter);

   PanelCreate();
   EventSetMillisecondTimer(50);
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason) {
   EventKillTimer();
   if (g_sub) { g_sub.disconnect(InpZmqHost); delete g_sub; g_sub = NULL; }
   if (g_ctx) { delete g_ctx; g_ctx = NULL; }
   PanelDestroy();
   AnnotationsClearAll();
   ChartRedraw();
}

//+------------------------------------------------------------------+
//|  Tiny JSON helpers — flat one-level payload only                 |
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
   if (g_sub == NULL) return;
   ZmqMsg topic, body;
   for (int k = 0; k < 4; k++) {
      if (!g_sub.recv(topic, ZMQ_DONTWAIT)) break;
      if (!g_sub.recv(body,  ZMQ_DONTWAIT)) break;
      string payload = body.getData();
      string sym     = JsonStr(payload, "symbol");
      string filter  = (InpFilterSym == "") ? _Symbol : InpFilterSym;
      if (sym != filter) continue;

      long ts_ms = (long)JsonNum(payload, "ts");
      // Staleness guard — bridge → MT4 latency on Win is < 50 ms
      if (TimeCurrent() * 1000 - ts_ms > InpStaleMs) continue;

      g_lastDecision.symbol           = sym;
      g_lastDecision.bias             = JsonStr(payload, "of_bias");
      g_lastDecision.confidence       = (int)JsonNum(payload, "of_confidence");
      g_lastDecision.signal           = JsonStr(payload, "of_signal");
      g_lastDecision.ts               = (datetime)(ts_ms / 1000);
      g_lastDecision.delta_norm       = JsonNum(payload, "of_delta_norm");
      g_lastDecision.imbalance        = JsonNum(payload, "of_imbalance");
      g_lastDecision.absorption       = JsonNum(payload, "of_absorption");
      g_lastDecision.iceberg_pressure = JsonNum(payload, "of_iceberg_pressure");
      g_lastDecision.exhaustion       = JsonNum(payload, "of_exhaustion");
      g_lastDecision.agreement        = JsonNum(payload, "of_agreement");
      g_lastFrameTime                 = TimeCurrent();
      g_frameCount++;

      if (InpVerboseLog && (g_frameCount % 20 == 0 || g_lastDecision.confidence >= InpMinConfidence)) {
         PrintFormat("[OBLIVIOUS] %s bias=%s conf=%d sig=%s agr=%.2f abs=%.2f imb=%.2f Δ=%.2f",
                     sym, g_lastDecision.bias, g_lastDecision.confidence,
                     g_lastDecision.signal, g_lastDecision.agreement,
                     g_lastDecision.absorption, g_lastDecision.imbalance,
                     g_lastDecision.delta_norm);
      }

      if (InpDrawTriggers && g_lastDecision.confidence >= InpMinConfidence) {
         AnnotationDraw();
      }
   }
   PanelUpdate();
}

//+------------------------------------------------------------------+
//|  Public helpers — call from your main EA before opening trades    |
//+------------------------------------------------------------------+
bool OF_AllowBuy(string sym = "") {
   if (sym == "") sym = _Symbol;
   if (g_lastDecision.symbol != sym)                  return true;
   if (TimeCurrent() - g_lastDecision.ts > InpStaleMs / 1000) return true;
   if (g_lastDecision.confidence < InpMinConfidence)  return true;
   return g_lastDecision.bias == "bullish";
}
bool OF_AllowSell(string sym = "") {
   if (sym == "") sym = _Symbol;
   if (g_lastDecision.symbol != sym)                  return true;
   if (TimeCurrent() - g_lastDecision.ts > InpStaleMs / 1000) return true;
   if (g_lastDecision.confidence < InpMinConfidence)  return true;
   return g_lastDecision.bias == "bearish";
}
int    OF_Confidence()  { return g_lastDecision.confidence; }
string OF_Bias()        { return g_lastDecision.bias; }
string OF_Signal()      { return g_lastDecision.signal; }
double OF_Agreement()   { return g_lastDecision.agreement; }

//+------------------------------------------------------------------+
//|  ─── On-chart panel ─────────────────────────────────────────────  |
//+------------------------------------------------------------------+
void PanelCreate() {
   ArrayResize(g_panelNames, 0);
   PanelAddLabel("hdr",   "OBLIVIOUS · ORDERFLOW",  10, clrWhite,    "Consolas", true);
   PanelAddLabel("hr",    "————————————————",       28, clrDimGray);
   PanelAddLabel("sym",   "SYMBOL  : —",            42, clrSilver);
   PanelAddLabel("bias",  "BIAS    : —",            56, clrYellow);
   PanelAddLabel("conf",  "CONF    : —%",           70, clrYellow);
   PanelAddLabel("sig",   "SIGNAL  : —",            84, clrAqua);
   PanelAddLabel("agr",   "AGREE   : —",            98, clrSilver);
   PanelAddLabel("abs",   "ABS     : —",           112, clrSilver);
   PanelAddLabel("delta", "DELTA   : —",           126, clrSilver);
   PanelAddLabel("imb",   "IMB     : —",           140, clrSilver);
   PanelAddLabel("exh",   "EXH     : —",           154, clrSilver);
   PanelAddLabel("link",  "LINK    : waiting…",    172, clrOrange);
   PanelAddLabel("ts",    "LAST    : —",           186, clrSilver);
}
void PanelAddLabel(string sfx, string text, int y, color c, string font = "Consolas", bool bold = false) {
   string n = OF_PFX + sfx;
   ObjectCreate(0, n, OBJ_LABEL, 0, 0, 0);
   ObjectSetInteger(0, n, OBJPROP_CORNER,     CORNER_LEFT_UPPER);
   ObjectSetInteger(0, n, OBJPROP_XDISTANCE,  14);
   ObjectSetInteger(0, n, OBJPROP_YDISTANCE,  y);
   ObjectSetInteger(0, n, OBJPROP_COLOR,      c);
   ObjectSetInteger(0, n, OBJPROP_FONTSIZE,   bold ? 11 : 9);
   ObjectSetString (0, n, OBJPROP_FONT,       font);
   ObjectSetString (0, n, OBJPROP_TEXT,       text);
   ObjectSetInteger(0, n, OBJPROP_HIDDEN,     true);
   ObjectSetInteger(0, n, OBJPROP_SELECTABLE, false);
   int sz = ArraySize(g_panelNames);
   ArrayResize(g_panelNames, sz + 1);
   g_panelNames[sz] = n;
}
void PanelDestroy() {
   for (int i = 0; i < ArraySize(g_panelNames); i++) ObjectDelete(0, g_panelNames[i]);
   ArrayResize(g_panelNames, 0);
}
color BiasColor() {
   if (g_lastDecision.bias == "bullish") return clrLime;
   if (g_lastDecision.bias == "bearish") return clrRed;
   return clrYellow;
}
color LinkColor(bool live) { return live ? clrLime : clrRed; }
void PanelUpdate() {
   bool live = (TimeCurrent() - g_lastFrameTime <= 3);  // 3s heartbeat budget
   string filter = (InpFilterSym == "") ? _Symbol : InpFilterSym;
   ObjectSetString (0, OF_PFX+"sym",   OBJPROP_TEXT, "SYMBOL  : " + filter);
   ObjectSetString (0, OF_PFX+"bias",  OBJPROP_TEXT, "BIAS    : " + (g_lastDecision.bias == "" ? "—" : Of_Upper(g_lastDecision.bias)));
   ObjectSetInteger(0, OF_PFX+"bias",  OBJPROP_COLOR, BiasColor());
   ObjectSetString (0, OF_PFX+"conf",  OBJPROP_TEXT, StringFormat("CONF    : %d%%", g_lastDecision.confidence));
   ObjectSetInteger(0, OF_PFX+"conf",  OBJPROP_COLOR,
                    g_lastDecision.confidence >= InpMinConfidence ? clrLime :
                    (g_lastDecision.confidence >= 40 ? clrYellow : clrSilver));
   ObjectSetString (0, OF_PFX+"sig",   OBJPROP_TEXT, "SIGNAL  : " + (g_lastDecision.signal == "" ? "—" : g_lastDecision.signal));
   ObjectSetString (0, OF_PFX+"agr",   OBJPROP_TEXT, StringFormat("AGREE   : %.0f%%", g_lastDecision.agreement * 100.0));
   ObjectSetString (0, OF_PFX+"abs",   OBJPROP_TEXT, StringFormat("ABS     : %.2f", g_lastDecision.absorption));
   ObjectSetString (0, OF_PFX+"delta", OBJPROP_TEXT, StringFormat("DELTA   : %+.2f", g_lastDecision.delta_norm));
   ObjectSetString (0, OF_PFX+"imb",   OBJPROP_TEXT, StringFormat("IMB     : %+.2f", g_lastDecision.imbalance));
   ObjectSetString (0, OF_PFX+"exh",   OBJPROP_TEXT, StringFormat("EXH     : %.2f", g_lastDecision.exhaustion));
   ObjectSetString (0, OF_PFX+"link",  OBJPROP_TEXT, live ? StringFormat("LINK    : LIVE · %d frames", g_frameCount) : "LINK    : OFFLINE");
   ObjectSetInteger(0, OF_PFX+"link",  OBJPROP_COLOR, LinkColor(live));
   ObjectSetString (0, OF_PFX+"ts",    OBJPROP_TEXT, "LAST    : " + (g_lastFrameTime > 0 ? TimeToString(g_lastFrameTime, TIME_SECONDS) : "—"));
   ChartRedraw();
}

//+------------------------------------------------------------------+
//|  Trigger annotation — vertical line + arrow + tag                 |
//+------------------------------------------------------------------+
void AnnotationDraw() {
   g_triggerSeq++;
   string idTrig = StringFormat("OF_TRIG_%d", g_triggerSeq);
   datetime t = TimeCurrent();
   double px  = (g_lastDecision.bias == "bearish") ? Ask : Bid;

   // vertical line at current bar
   string vln = idTrig + "_v";
   ObjectCreate(0, vln, OBJ_VLINE, 0, t, 0);
   ObjectSetInteger(0, vln, OBJPROP_COLOR, BiasColor());
   ObjectSetInteger(0, vln, OBJPROP_STYLE, STYLE_DOT);
   ObjectSetInteger(0, vln, OBJPROP_WIDTH, 1);
   ObjectSetInteger(0, vln, OBJPROP_BACK,  true);
   ObjectSetInteger(0, vln, OBJPROP_HIDDEN, true);

   // arrow on the side that matches the bias
   string arr = idTrig + "_a";
   int code = (g_lastDecision.bias == "bullish") ? 233 : (g_lastDecision.bias == "bearish" ? 234 : 159);
   ObjectCreate(0, arr, OBJ_ARROW, 0, t, px);
   ObjectSetInteger(0, arr, OBJPROP_ARROWCODE, code);
   ObjectSetInteger(0, arr, OBJPROP_COLOR,     BiasColor());
   ObjectSetInteger(0, arr, OBJPROP_WIDTH,     2);
   ObjectSetInteger(0, arr, OBJPROP_BACK,      false);

   // signal tag
   string tag = idTrig + "_t";
   ObjectCreate(0, tag, OBJ_TEXT, 0, t, px);
   ObjectSetString (0, tag, OBJPROP_TEXT, StringFormat("%s %d%%", g_lastDecision.signal, g_lastDecision.confidence));
   ObjectSetInteger(0, tag, OBJPROP_COLOR, BiasColor());
   ObjectSetInteger(0, tag, OBJPROP_FONTSIZE, 8);
   ObjectSetString (0, tag, OBJPROP_FONT, "Consolas");
   ObjectSetInteger(0, tag, OBJPROP_ANCHOR, (g_lastDecision.bias == "bearish") ? ANCHOR_LOWER : ANCHOR_UPPER);

   // Ring-buffer: delete the oldest set so the chart never accumulates >N triggers.
   int del = g_triggerSeq - InpMaxTriggers;
   if (del > 0) {
      string old = StringFormat("OF_TRIG_%d", del);
      ObjectDelete(0, old + "_v");
      ObjectDelete(0, old + "_a");
      ObjectDelete(0, old + "_t");
   }
}
void AnnotationsClearAll() {
   for (int i = 1; i <= g_triggerSeq; i++) {
      string idTrig = StringFormat("OF_TRIG_%d", i);
      ObjectDelete(0, idTrig + "_v");
      ObjectDelete(0, idTrig + "_a");
      ObjectDelete(0, idTrig + "_t");
   }
}

//+------------------------------------------------------------------+
//|  Convenience uppercase wrapper — MQL4 StringToUpper modifies in   |
//|  place and returns a bool; we want a returns-a-string variant.    |
//+------------------------------------------------------------------+
string Of_Upper(string s) {
   string out = s;
   StringToUpper(out);
   return out;
}
