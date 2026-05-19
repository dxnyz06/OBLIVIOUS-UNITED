package com.oblivious.bookmap;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;
import velox.api.layer1.common.Log;

import java.net.InetSocketAddress;
import java.util.Collections;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.ArrayList;
import java.util.List;

/**
 * Local WebSocket server bound to 0.0.0.0:&lt;port&gt; so the Electron
 * Hub (running on the same VPS) can connect via 127.0.0.1.
 *
 * Outgoing messages are batched every 50 ms — protects the Electron
 * IPC pipe from sub-millisecond bursts during fast tape.
 */
public class OrderflowWebSocket extends WebSocketServer {

    private static final int   BATCH_INTERVAL_MS = 50;
    private static final int   QUEUE_CAPACITY    = 8192;

    private final Set<WebSocket> clients = Collections.newSetFromMap(new ConcurrentHashMap<>());
    private final LinkedBlockingQueue<String> outQueue = new LinkedBlockingQueue<>(QUEUE_CAPACITY);
    private final ScheduledExecutorService flusher = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "oblivious-ws-flush");
        t.setDaemon(true);
        return t;
    });

    public OrderflowWebSocket(int port) {
        super(new InetSocketAddress("0.0.0.0", port));
        setReuseAddr(true);
        setTcpNoDelay(true);
    }

    @Override
    public void start() {
        super.start();
        flusher.scheduleAtFixedRate(this::flush, BATCH_INTERVAL_MS, BATCH_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    @Override
    public void stop() throws InterruptedException {
        flusher.shutdownNow();
        super.stop();
    }

    public int clientCount() { return clients.size(); }

    /** Enqueue a JSON message; non-blocking; drops oldest on overflow. */
    public void broadcast(String json) {
        if (json == null) return;
        if (!outQueue.offer(json)) {
            outQueue.poll();
            outQueue.offer(json);
        }
    }

    private void flush() {
        if (clients.isEmpty()) {
            outQueue.clear();
            return;
        }
        List<String> batch = new ArrayList<>(64);
        outQueue.drainTo(batch, 64);
        if (batch.isEmpty()) return;
        for (WebSocket ws : clients) {
            if (!ws.isOpen()) continue;
            try {
                for (String m : batch) ws.send(m);
            } catch (Exception ex) {
                Log.warn("[OBLIVIOUS] ws send failed: " + ex.getMessage());
            }
        }
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {
        clients.add(conn);
        Log.info("[OBLIVIOUS] hub connected from " + conn.getRemoteSocketAddress());
    }

    @Override
    public void onClose(WebSocket conn, int code, String reason, boolean remote) {
        clients.remove(conn);
        Log.info("[OBLIVIOUS] hub disconnected (" + reason + ")");
    }

    @Override
    public void onMessage(WebSocket conn, String message) {
        // Hub → Bookmap channel is intentionally not used yet.
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {
        Log.warn("[OBLIVIOUS] ws error: " + ex.getMessage());
    }

    @Override
    public void onStart() {
        Log.info("[OBLIVIOUS] WS server listening on " + getAddress());
    }
}
