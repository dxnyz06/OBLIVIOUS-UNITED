# OBLIVIOUS HUB - Bookmap Python Bridge

This folder contains ONE file you load into Bookmap:

    oblivious_bridge.py   <-- THIS is the Bookmap addon. Load only this.

DO NOT load any other .py file in Bookmap. They are NOT Bookmap addons
and will crash with "FailedToStartServerException: Socket closed".

## How to load

1. Open Bookmap -> Settings -> Configure API plugins -> Add ->
   browse to `oblivious_bridge.py` -> OK.
2. Enable it on your instrument's chart (checkbox in the Strategies panel).
3. The bridge will start a local WebSocket server on
   `ws://127.0.0.1:8081` that the Oblivious Hub Electron app connects to.

## Sanity check

After enabling the addon, look at Bookmap's "Strategy log" (View -> Logs).
You should see:
    [oblivious-bridge] subscribed: <ALIAS> (-> <NORMALIZED_SYMBOL>)
    [oblivious-bridge] WS listening on ws://127.0.0.1:8081
    [oblivious-bridge] subscribe_to_depth OK for <ALIAS>
    [oblivious-bridge] subscribe_to_trades OK for <ALIAS>
    [oblivious-bridge] events recv: depth=N trades=N mbo=N   (every 15s)

If the `events recv:` line keeps showing depth=0 trades=0:
  - In Bookmap, right-click the chart and enable "Show Bookmap (Heatmap)"
    AND make sure your data feed actually publishes L2 depth (some
    brokers only stream Best Bid / Offer).

## Offline regression test (do NOT load this in Bookmap)

The offline test lives OUTSIDE this folder, in `oblivious-hub/dev-tools/`,
so you can never accidentally load it as an addon.

    python3 ../dev-tools/test_orderflow_offline.py

It stubs the `bookmap` module and exercises the orderflow math
(absorption / exhaustion / iceberg / sweep) without needing Bookmap at all.
