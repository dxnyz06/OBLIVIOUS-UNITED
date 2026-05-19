# OBLIVIOUS — Architecture (current state)

## Components and live transports

```
┌─────────────────────────┐
│  MetaTrader 4 + EA      │  OBLIVIOUS_COMPLETE.mq4 (≈ 35 kLOC, MQL4)
│  — 7 strategies         │
│  — Risk_Preflight       │
│  — NewsPolicy gate      │
└──────────┬──────────────┘
           │  ZeroMQ (only live transport)
           │  REQ/REP   tcp://127.0.0.1:5555  ai_query / news_query / heartbeat
           │  PUB/SUB   tcp://127.0.0.1:5556  oblivious.command / heartbeat
           │  PUSH/PULL tcp://127.0.0.1:5557  context_push (high-freq, non-blocking)
           ▼
┌─────────────────────────┐
│  Oblivious Hub          │  Electron / Node 22, src under oblivious-hub/src/
│  — SecureBoot           │     ├ DeviceId / Licensing / KeyVault
│  — DecisionEngine       │     ├ context fusion (EA + Bookmap + News + AI)
│  — NewsEngine           │     ├ ForexFactory CSV (ETag, 5 min throttle)
│  — ProviderRouter       │     ├ 7 AI providers, AiCache (sha256, multi-TTL)
│  — ZmqBridge            │     ├ command lifecycle (R7)
│  — BookmapClient        │     └ WS client to ws://127.0.0.1:8081
└──────────┬──────────────┘
           │ WebSocket
           │ ws://127.0.0.1:8081 — JSON, batch 50ms, reconnect ε-back-off
           ▼
┌─────────────────────────┐
│  Bookmap Add-on (Java)  │  BookmapBridge / OrderflowState / OrderflowWebSocket
│  — L1 callbacks         │
│  — Iceberg / MBO        │
│  — try-catch every cb   │
└─────────────────────────┘
```

## Boot sequence (VPS)

```
start.bat
  │
  ├─ set OBLIVIOUS_CONFIG_DIR    → OBLIVIOUS-VPS/config
  ├─ set OBLIVIOUS_LICENSES_DIR  → OBLIVIOUS-VPS/licenses
  └─ set OBLIVIOUS_LICENSE_REQUIRED = true
       │
       ▼
Oblivious Hub.exe
  │
  ├─ SecureBoot.run()
  │     ├─ password (modal prompt or KEYVAULT_PASSPHRASE env)
  │     ├─ DeviceId.compute()   sha256(BIOS UUID | MAC | MachineGuid)
  │     ├─ Licensing.verify()   RSA-PSS over canonical JSON, dates, device
  │     └─ KeyVault.load()      AES-256-GCM, scrypt N=2^15
  │
  ├─ services boot
  │     ├─ ZmqBridge   bind 5555/5556/5557
  │     ├─ NewsEngine  fetch nfs.faireconomy.media (ETag)
  │     ├─ ProviderRouter
  │     ├─ BookmapClient  connect ws://127.0.0.1:8081 (back-off if absent)
  │     └─ DecisionEngine
  │
  └─ EA on MT4 connects to ZMQ → trades flow
```

## Hard rules verified

| Rule | What it enforces                                                  |
|------|-------------------------------------------------------------------|
| R1   | Predicted hub-driven; other strategies use AI only if TPSLMode=AI |
| R2   | Hub-down → Predicted blocks new opens; others can run Native      |
| R3   | ZeroMQ is the only live transport (no .txt, no named pipes)       |
| R4   | g_ai_* state updated from real REQ/REP + heartbeat + topics       |
| R5   | Risk_Preflight unified, MaxRiskTradePercent applied even for ManualLot |
| R6   | NewsPolicy is the single local gate; hub feeds it                 |
| R7   | EXECUTE_ORDER lifecycle: owner / magic / comment / TP1-TP2-TP3-TPMAX / OCO / registry |
| R8   | Watchlist of 6 symbols, no hard-block — symbol routing            |

## Files NOT shipped to the VPS

* `.env`, `.env.example`
* `oblivious-hub/src/` and `node_modules/` (bundled into `app.asar`)
* `bookmap-plugin/src/` and `pom.xml` (bundled into the shaded jar)
* `bookmap-plugin/lib/bm-l1api.jar` and `bm-simplified-api-wrapper.jar`
  (proprietary, per-machine licensed)
* `private_key.pem` (lives only in `OBLIVIOUS-PRIVATE/`)
* `license-generator/` (lives only in `OBLIVIOUS-PRIVATE/`)
* Legacy `.NET` / named-pipe code — archived under `OBLIVIOUS-DEV/project/legacy-frozen/` only
