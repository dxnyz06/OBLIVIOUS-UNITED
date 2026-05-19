package com.oblivious.bookmap;

import velox.api.layer1.Layer1ApiAdminAdapter;
import velox.api.layer1.Layer1ApiFinishable;
import velox.api.layer1.Layer1ApiProvider;
import velox.api.layer1.Layer1CustomPanelsGetter;
import velox.api.layer1.annotations.Layer1Attachable;
import velox.api.layer1.annotations.Layer1StrategyName;
import velox.api.layer1.common.Log;
import velox.api.layer1.data.InstrumentInfo;
import velox.api.layer1.data.OrderInfoUpdate;
import velox.api.layer1.data.TradeInfo;
import velox.api.layer1.layers.Layer1ApiInjectorRelay;
import velox.gui.StrategyPanel;

import javax.swing.JLabel;
import java.awt.BorderLayout;
import java.util.HashMap;
import java.util.Map;

/**
 * OBLIVIOUS Bookmap Bridge.
 *
 * Bookmap loads this class through the L1 API Attachable contract.
 * On every instrument we subscribe to MBO / trade callbacks, derive
 * imbalance + iceberg + stop-run heuristics, and forward them as
 * compact JSON messages to the Electron Hub via OrderflowWebSocket
 * (which binds 0.0.0.0:8081 by default).
 */
@Layer1Attachable
@Layer1StrategyName("OBLIVIOUS Bridge")
public class BookmapBridge extends Layer1ApiInjectorRelay
        implements Layer1ApiAdminAdapter, Layer1ApiFinishable, Layer1CustomPanelsGetter {

    private static final int WS_PORT = 8081;

    private final OrderflowWebSocket ws;
    private final Map<String, InstrumentInfo> instruments = new HashMap<>();
    private final Map<String, OrderflowState> state = new HashMap<>();
    private JLabel statusLabel;

    public BookmapBridge(Layer1ApiProvider provider) {
        super(provider);
        this.ws = new OrderflowWebSocket(WS_PORT);
        this.ws.start();
        Log.info("[OBLIVIOUS] WebSocket server starting on 0.0.0.0:" + WS_PORT);
    }

    @Override
    public void finish() {
        try {
            ws.stop();
            Log.info("[OBLIVIOUS] WebSocket server stopped");
        } catch (Exception ex) {
            Log.warn("[OBLIVIOUS] WS shutdown failed: " + ex.getMessage());
        }
    }

    // Callback safety: every L1 API entry point is wrapped so a JSON /
    // serialization / state-machine exception in our code can never bubble
    // up into Bookmap and crash the host application.

    // ----- L1 admin events -------------------------------------------------
    @Override
    public void onInstrumentAdded(String alias, InstrumentInfo info) {
        super.onInstrumentAdded(alias, info);
        try {
            instruments.put(alias, info);
            state.put(alias, new OrderflowState(alias));
            ws.broadcast(JsonMsg.instrumentAdded(alias, info));
        } catch (Throwable t) {
            Log.warn("[OBLIVIOUS] onInstrumentAdded failed alias=" + alias + " err=" + t.getMessage());
        }
    }

    @Override
    public void onInstrumentRemoved(String alias) {
        super.onInstrumentRemoved(alias);
        try {
            instruments.remove(alias);
            state.remove(alias);
            ws.broadcast(JsonMsg.instrumentRemoved(alias));
        } catch (Throwable t) {
            Log.warn("[OBLIVIOUS] onInstrumentRemoved failed alias=" + alias + " err=" + t.getMessage());
        }
    }

    // ----- MBO / trade pass-through ---------------------------------------
    @Override
    public void onTrade(String alias, double price, int size, TradeInfo info) {
        super.onTrade(alias, price, size, info);
        try {
            OrderflowState s = state.get(alias);
            if (s != null) {
                s.recordTrade(price, size, info);
                ws.broadcast(JsonMsg.trade(alias, price, size, info));
                ws.broadcast(JsonMsg.snapshot(alias, s));
            }
        } catch (Throwable t) {
            Log.warn("[OBLIVIOUS] onTrade failed alias=" + alias + " err=" + t.getMessage());
        }
    }

    @Override
    public void onOrderUpdated(OrderInfoUpdate info) {
        super.onOrderUpdated(info);
        try {
            OrderflowState s = state.get(info.instrumentAlias);
            if (s != null) {
                s.observeOrder(info);
                if (s.popLastFinding() != null) {
                    ws.broadcast(JsonMsg.snapshot(info.instrumentAlias, s));
                }
            }
        } catch (Throwable t) {
            Log.warn("[OBLIVIOUS] onOrderUpdated failed alias=" + info.instrumentAlias
                    + " err=" + t.getMessage());
        }
    }

    @Override
    public StrategyPanel[] getCustomGuiFor(String alias, String indicatorName) {
        try {
            statusLabel = new JLabel(" OBLIVIOUS bridge — clients=" + ws.clientCount());
            StrategyPanel panel = new StrategyPanel("OBLIVIOUS Bridge", new BorderLayout());
            panel.add(statusLabel, BorderLayout.CENTER);
            return new StrategyPanel[] { panel };
        } catch (Throwable t) {
            Log.warn("[OBLIVIOUS] getCustomGuiFor failed alias=" + alias + " err=" + t.getMessage());
            return new StrategyPanel[0];
        }
    }
}
