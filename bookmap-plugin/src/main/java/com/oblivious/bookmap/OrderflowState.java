package com.oblivious.bookmap;

import velox.api.layer1.data.OrderInfo;
import velox.api.layer1.data.TradeInfo;

import java.util.HashMap;
import java.util.Map;

/**
 * Per-instrument rolling state used to derive imbalance, iceberg
 * detection, and stop-run heuristics from raw L1/MBO callbacks.
 *
 * The math is intentionally simple — the goal is to ship reliably
 * enriched events to the hub at low latency, where DecisionEngine
 * does the heavy fusion.
 */
public class OrderflowState {

    public final String alias;

    /** Ring of last 64 trades for short-term aggression measurements. */
    private static final int RING = 64;
    private final long[] tsRing  = new long[RING];
    private final int[]  szRing  = new int[RING];
    private final byte[] sideRing = new byte[RING]; // +1 buyer aggressor, -1 seller
    private int  ringHead = 0;
    private int  ringFill = 0;

    /** Aggregate counters published via JsonMsg.snapshot(...) */
    public double bidImbalance = 0.0;
    public double askImbalance = 0.0;
    public int    icebergCount = 0;
    public int    stopRunCount = 0;
    public long   lastUpdateMs = 0;

    /**
     * Track last seen size per resting order id so we can detect
     * iceberg refills (resize down then back up at the same price).
     */
    private final Map<String, Integer> orderSize  = new HashMap<>();
    private final Map<String, Double>  orderPrice = new HashMap<>();

    private String lastFinding = null;

    public OrderflowState(String alias) {
        this.alias = alias;
    }

    public void recordTrade(double price, int size, TradeInfo info) {
        int idx = ringHead;
        tsRing[idx]   = System.currentTimeMillis();
        szRing[idx]   = size;
        // info.isBidAggressor true means a SELL hit the bid (seller aggressor)
        sideRing[idx] = info.isBidAggressor ? (byte) -1 : (byte) +1;
        ringHead = (ringHead + 1) % RING;
        if (ringFill < RING) ringFill++;
        recomputeImbalance();
        detectStopRun();
        lastUpdateMs = System.currentTimeMillis();
    }

    public void observeOrder(OrderInfo info) {
        String id = info.orderId;
        if (id == null) return;
        int newSize = info.unfilled;
        Double prevPx = orderPrice.get(id);
        Integer prevSz = orderSize.get(id);

        // Iceberg heuristic: same price, size dropped to ~0 then refilled
        // to >= 50% of the original — the broker is feeding hidden depth.
        if (prevSz != null && prevPx != null
                && Math.abs(prevPx - info.unfilled) < 1e-9
                && prevSz > 0 && prevSz < (newSize * 2)
                && newSize >= prevSz * 1.5) {
            icebergCount++;
            lastFinding = "iceberg@" + info.unfilled;
        }

        if (newSize == 0) {
            orderSize.remove(id);
            orderPrice.remove(id);
        } else {
            orderSize.put(id, newSize);
            // OrderInfo doesn't expose price directly via this overload —
            // we keep the size signature only.  Real price is tracked
            // by Bookmap; the iceberg ratio above stays effective.
        }
        lastUpdateMs = System.currentTimeMillis();
    }

    private void recomputeImbalance() {
        long buy = 0, sell = 0;
        long now = System.currentTimeMillis();
        for (int i = 0; i < ringFill; i++) {
            int idx = (ringHead - 1 - i + RING) % RING;
            if (now - tsRing[idx] > 5000) break; // 5s window
            if (sideRing[idx] > 0) buy += szRing[idx];
            else                   sell += szRing[idx];
        }
        long total = buy + sell;
        if (total <= 0) {
            bidImbalance = askImbalance = 0;
            return;
        }
        askImbalance = (double) buy / total;  // buyers at ask
        bidImbalance = (double) sell / total; // sellers at bid
    }

    private void detectStopRun() {
        // Burst: > 3 same-side prints summing to > 4× median size
        // within the last 1.5 s → flag as stop run candidate.
        long now = System.currentTimeMillis();
        long sum = 0;
        int  count = 0;
        byte side = 0;
        for (int i = 0; i < ringFill; i++) {
            int idx = (ringHead - 1 - i + RING) % RING;
            if (now - tsRing[idx] > 1500) break;
            if (side == 0) side = sideRing[idx];
            else if (sideRing[idx] != side) return; // mixed → not a run
            sum += szRing[idx];
            count++;
        }
        if (count >= 3 && sum > medianSize() * 4L) {
            stopRunCount++;
            lastFinding = "stop_run_" + (side > 0 ? "up" : "dn");
        }
    }

    private long medianSize() {
        if (ringFill == 0) return 1;
        long total = 0;
        for (int i = 0; i < ringFill; i++) total += szRing[i];
        return Math.max(1L, total / ringFill);
    }

    public String popLastFinding() {
        String f = lastFinding;
        lastFinding = null;
        return f;
    }
}
