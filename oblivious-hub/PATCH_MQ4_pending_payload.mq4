// ============================================================
// OBLIVIOUS_COMPLETE.mq4 — patch pending-orders JSON payload
// ------------------------------------------------------------
// What this changes:
//   Adds a sibling helper to Oblivious_BuildPositionsJson() that emits
//   the array of currently-working PENDING orders (BUY LIMIT, SELL LIMIT,
//   BUY STOP, SELL STOP, BUY STOP LIMIT, SELL STOP LIMIT). The Hub →
//   MobileGateway → Mobile PWA pipeline reads `pending[]` out of every
//   `context_push` frame and renders it under the PENDING ORDERS card
//   of the mobile dashboard. The Mobile "CANCEL ORDER" button (data-
//   testid `m-cancel-<ticket>`) publishes `op:"CANCEL_PENDING"` over ZMQ
//   topic `oblivious.command` — the EA must be able to recognise that
//   op and call `OrderDelete(ticket)` on its own side.
//
// How to apply:
//   1. Open OBLIVIOUS_COMPLETE.mq4 in MetaEditor.
//   2. Paste Oblivious_BuildPendingJson() below the existing
//      Oblivious_BuildPositionsJson() helper.
//   3. In the routine that assembles the `context_push` JSON, after the
//      "positions":<...> field, inject:
//
//         + ",\"pending\":" + Oblivious_BuildPendingJson()
//
//      (See INTEGRATION SNIPPET at the bottom of this file.)
//   4. In your existing ZMQ command dispatcher, add a CANCEL_PENDING case:
//
//         else if(op == "CANCEL_PENDING")
//           {
//            int ticket = (int)JsonGetInt(payload, "ticket");
//            if(OrderSelect(ticket, SELECT_BY_TICKET))
//              {
//               if(OrderType() > OP_SELL)            // pending only
//                 OrderDelete(ticket);
//              }
//           }
//
//   5. Recompile (F7). Restart MT4 to make the new payload effective.
//
// JSON shape produced (one element of "pending": [...]):
//   {
//     "ticket":    12345601,
//     "sym":       "EURUSD",
//     "type":      2,                 // raw OP_* constant (2..5)
//     "type_name": "BUYLIMIT",        // human-readable label
//     "lots":      0.05,
//     "price":     1.0850,            // pending entry price
//     "sl":        1.0820,
//     "tp":        1.0920,
//     "expiry":    "2026.02.28 18:00",// "" if no expiration
//     "magic":     100700,
//     "comment":   "GRID_LONG_B"
//   }
//
// All numeric fields are normalised to the symbol Digits.
// ============================================================

string Oblivious_PendingTypeName(int t)
  {
   if(t == OP_BUYLIMIT)  return("BUYLIMIT");
   if(t == OP_SELLLIMIT) return("SELLLIMIT");
   if(t == OP_BUYSTOP)   return("BUYSTOP");
   if(t == OP_SELLSTOP)  return("SELLSTOP");
   return("PENDING");
  }

string Oblivious_BuildPendingJson()
  {
   string out   = "[";
   bool   first = true;

   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES)) continue;
      int t = OrderType();
      // OP_BUY=0, OP_SELL=1 are market positions — skip them.
      // Pending entries are OP_BUYLIMIT(2), OP_SELLLIMIT(3),
      // OP_BUYSTOP(4), OP_SELLSTOP(5).
      if(t < OP_BUYLIMIT || t > OP_SELLSTOP) continue;

      int    ticket = OrderTicket();
      string sym    = OrderSymbol();
      double lots   = OrderLots();
      double price  = OrderOpenPrice();
      double sl     = OrderStopLoss();
      double tp     = OrderTakeProfit();
      int    digits = (int)MarketInfo(sym, MODE_DIGITS);
      datetime exp  = OrderExpiration();
      string expStr = (exp > 0) ? TimeToString(exp, TIME_DATE | TIME_MINUTES) : "";

      if(!first) out = out + ",";
      first = false;

      out = out + "{"
            + "\"ticket\":"     + IntegerToString(ticket)
            + ",\"sym\":\""     + sym + "\""
            + ",\"type\":"      + IntegerToString(t)
            + ",\"type_name\":\""+ Oblivious_PendingTypeName(t) + "\""
            + ",\"lots\":"      + DoubleToString(lots, 2)
            + ",\"price\":"     + DoubleToString(price, digits)
            + ",\"sl\":"        + DoubleToString(sl,    digits)
            + ",\"tp\":"        + DoubleToString(tp,    digits)
            + ",\"expiry\":\""  + expStr + "\""
            + ",\"magic\":"     + IntegerToString(OrderMagicNumber())
            + ",\"comment\":\"" + OrderComment() + "\""
            + "}";
     }

   out = out + "]";
   return(out);
  }

// ============================================================
// INTEGRATION SNIPPET — context_push JSON assembly
// ------------------------------------------------------------
// Locate (or create) the function that builds the `context_push`
// JSON sent over ZMQ PUSH (port 5557). It typically looks like:
//
//   string Oblivious_BuildContextPush()
//     {
//      string j = "{\"op\":\"context_push\",\"context\":{";
//      j += "\"sym\":\""     + Symbol() + "\"";
//      j += ",\"balance\":"  + DoubleToString(AccountBalance(), 2);
//      j += ",\"equity\":"   + DoubleToString(AccountEquity(),  2);
//      j += ",\"margin\":"   + DoubleToString(AccountMargin(),  2);
//      j += ",\"spread\":"   + IntegerToString((int)MarketInfo(Symbol(), MODE_SPREAD));
//      j += ",\"tpsl_mode\":\"" + g_oblivious_tpsl_mode + "\"";
//      j += ",\"positions\":"+ Oblivious_BuildPositionsJson();
//   /* ── ADD THIS LINE ───────────────────────────────── */
//      j += ",\"pending\":"  + Oblivious_BuildPendingJson();
//   /* ────────────────────────────────────────────────── */
//      j += "}}";
//      return(j);
//     }
//
// The MobileGateway snapshotProvider() already passes `ctx.pending`
// through unchanged, and the PWA dashboard card "PENDING ORDERS"
// hydrates from it automatically. No additional client-side work
// is required once the EA starts emitting the field.
// ============================================================
