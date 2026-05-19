// ============================================================
// OBLIVIOUS_COMPLETE.mq4 — patch positions JSON payload
// ------------------------------------------------------------
// What this changes:
//   The hub renderer (renderer.js > paintChart() > eaLevels) reads explicit
//   per-stage TP fields from each position object:
//
//       tp1, tp2, tp3, tpmax, tp1_hit, tp2_hit, tp3_hit
//
//   If they're missing the renderer falls back to splitting the
//   (entry → tp) span at 33% / 66% / 90% / 100%, which is a guess —
//   it does NOT reflect the real EA-managed TPs.
//
// How to apply:
//   1. Open OBLIVIOUS_COMPLETE.mq4 in MetaEditor.
//   2. Locate the helper Oblivious_BuildPositionsJson() (declared in PRD
//      Section 19 "TP-SL / trailing / breakeven / profit guards / overlays").
//   3. Replace its body with the version below, OR merge the highlighted
//      changes into your existing implementation.
//   4. Verify g_tpsl_tracks[] / g_tpsl_trackCount are visible in scope
//      (they're the global TPSLTrackInfo array defined in Section 05).
//   5. Recompile (F7). The .ex4 should land at the same path; restart MT4
//      to make the new bridge build effective.
//
// Key fields read from TPSLTrackInfo (already defined in MQ4):
//     int    ticket;
//     double entryPrice;
//     double initialSL;
//     double tp1, tp2, tp3, tpmax;
//     bool   tp1Hit, tp2Hit, tp3Hit;
//     int    orderType;     // OP_BUY or OP_SELL
//     int    magic;
//     string strategy;
//
// JSON shape produced (one element of "positions": [...]):
//   {
//     "ticket": 12345678,
//     "sym":    "XAUUSD",
//     "side":   "BUY",
//     "lots":   0.10,
//     "entry":  2384.55,
//     "current": 2391.20,
//     "pnl":    66.50,
//     "sl":     2378.00,
//     "tp":     2410.00,           // legacy field (= tpmax) for older clients
//     "tp1":    2392.95,
//     "tp2":    2401.35,
//     "tp3":    2407.45,
//     "tpmax":  2410.00,
//     "tp1_hit": false,
//     "tp2_hit": false,
//     "tp3_hit": false,
//     "tpsl_stage": "TP1",         // string label of current advance
//     "strategy":   "FVG",
//     "magic":      100700,
//     "comment":    "FVG_BURST_42_0"
//   }
//
// All numeric fields are normalised to the symbol Digits.
// ============================================================

string Oblivious_BuildPositionsJson()
  {
   // Find the TPSLTrackInfo entry for a given ticket (linear search — N is small).
   // Returns -1 if not tracked yet (e.g. position opened by a non-managed source).
   string out = "[";
   bool   first = true;

   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
      int t = OrderType();
      if(t != OP_BUY && t != OP_SELL) continue;     // ignore pending

      int    ticket = OrderTicket();
      string sym    = OrderSymbol();
      double lots   = OrderLots();
      double entry  = OrderOpenPrice();
      double sl     = OrderStopLoss();
      double tp     = OrderTakeProfit();
      double cur    = (t == OP_BUY) ? MarketInfo(sym, MODE_BID) : MarketInfo(sym, MODE_ASK);
      double pnl    = OrderProfit() + OrderSwap() + OrderCommission();
      int    digits = (int)MarketInfo(sym, MODE_DIGITS);
      string side   = (t == OP_BUY) ? "BUY" : "SELL";
      int    magic  = OrderMagicNumber();

      // Pull explicit per-stage TP/SL values from the TPSLTrackInfo registry.
      // If the trade is not (yet) tracked we still emit the position, just
      // without tp1/tp2/tp3 — the renderer will fall back to the % split.
      double tp1     = 0, tp2 = 0, tp3 = 0, tpmax = 0;
      bool   tp1Hit = false, tp2Hit = false, tp3Hit = false;
      bool   tracked = false;
      string strategy = "";
      for(int k = 0; k < g_tpsl_trackCount; k++)
        {
         if(g_tpsl_tracks[k].ticket != ticket) continue;
         tp1     = g_tpsl_tracks[k].tp1;
         tp2     = g_tpsl_tracks[k].tp2;
         tp3     = g_tpsl_tracks[k].tp3;
         tpmax   = g_tpsl_tracks[k].tpmax;
         tp1Hit  = g_tpsl_tracks[k].tp1Hit;
         tp2Hit  = g_tpsl_tracks[k].tp2Hit;
         tp3Hit  = g_tpsl_tracks[k].tp3Hit;
         strategy= g_tpsl_tracks[k].strategy;
         tracked = true;
         break;
        }

      // Derive the human-readable TPSL stage label so the hub UI can paint
      // it in the ACTIVE POSITIONS table without recomputing the logic.
      string stage = "ENTRY";
      if(tracked)
        {
         if(tp3Hit)      stage = "TPMAX";
         else if(tp2Hit) stage = "TP3";
         else if(tp1Hit) stage = "TP2";
         else            stage = "TP1";
        }

      if(!first) out = out + ",";
      first = false;

      out = out + "{"
            + "\"ticket\":"  + IntegerToString(ticket)
            + ",\"sym\":\""  + sym + "\""
            + ",\"side\":\"" + side + "\""
            + ",\"lots\":"   + DoubleToString(lots, 2)
            + ",\"entry\":"  + DoubleToString(entry, digits)
            + ",\"current\":"+ DoubleToString(cur,   digits)
            + ",\"pnl\":"    + DoubleToString(pnl,   2)
            + ",\"sl\":"     + DoubleToString(sl,    digits)
            + ",\"tp\":"     + DoubleToString((tracked && tpmax > 0) ? tpmax : tp, digits);

      if(tracked)
        {
         out = out
               + ",\"tp1\":"    + DoubleToString(tp1,   digits)
               + ",\"tp2\":"    + DoubleToString(tp2,   digits)
               + ",\"tp3\":"    + DoubleToString(tp3,   digits)
               + ",\"tpmax\":"  + DoubleToString(tpmax, digits)
               + ",\"tp1_hit\":" + (tp1Hit ? "true" : "false")
               + ",\"tp2_hit\":" + (tp2Hit ? "true" : "false")
               + ",\"tp3_hit\":" + (tp3Hit ? "true" : "false");
        }

      out = out
            + ",\"tpsl_stage\":\"" + stage + "\""
            + ",\"strategy\":\""   + strategy + "\""
            + ",\"magic\":"        + IntegerToString(magic)
            + ",\"comment\":\""    + OrderComment() + "\""
            + "}";
     }

   out = out + "]";
   return(out);
  }
