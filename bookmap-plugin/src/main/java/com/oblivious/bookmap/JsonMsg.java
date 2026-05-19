package com.oblivious.bookmap;

import com.google.gson.Gson;
import velox.api.layer1.data.InstrumentInfo;
import velox.api.layer1.data.TradeInfo;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Compact JSON serializer for messages flowing
 * Bookmap → WebSocket → Electron Hub.
 *
 * Schema is intentionally flat; the hub-side BookmapClient is happy
 * with any { type, symbol, ... } shape and merges it into a rolling
 * snapshot.
 */
final class JsonMsg {

    private static final Gson GSON = new Gson();

    private JsonMsg() {}

    static String instrumentAdded(String alias, InstrumentInfo info) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "instrument_added");
        m.put("symbol", alias);
        m.put("pips", info.pips);
        m.put("multiplier", info.multiplier);
        return GSON.toJson(m);
    }

    static String instrumentRemoved(String alias) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "instrument_removed");
        m.put("symbol", alias);
        return GSON.toJson(m);
    }

    static String trade(String alias, double price, int size, TradeInfo info) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "trade");
        m.put("symbol", alias);
        m.put("price", price);
        m.put("size", size);
        m.put("aggressor", info.isBidAggressor ? "sell" : "buy");
        m.put("ts", System.currentTimeMillis());
        return GSON.toJson(m);
    }

    /**
     * Aggregated rolling snapshot — sent at most every 50 ms by
     * OrderflowWebSocket's flusher thread (the bridge enqueues; the
     * server batches).  Field names match the contract expected by
     * the Electron BookmapClient.
     */
    static String snapshot(String alias, OrderflowState s) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "snapshot");
        m.put("symbol", alias);
        m.put("bidImbalance", s.bidImbalance);
        m.put("askImbalance", s.askImbalance);
        m.put("icebergCount", s.icebergCount);
        m.put("stopRunCount", s.stopRunCount);
        m.put("ts", s.lastUpdateMs);
        return GSON.toJson(m);
    }
}
