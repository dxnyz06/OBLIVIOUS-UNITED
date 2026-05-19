# OBLIVIOUS UNITED — Electron Hub

The local trading brain for the **OBLIVIOUS_COMPLETE** MetaTrader 4 EA.

This is a self-contained Electron application that runs on the same VPS
as MetaTrader 4 and orchestrates everything around the EA:

* ZeroMQ bridge to the EA (REQ/REP, PUB/SUB, PUSH/PULL, all on
  `127.0.0.1`).
* WebSocket client to the Bookmap Global+ add-on at
  `ws://127.0.0.1:8081` for orderflow / iceberg / MBO data.
* News engine that pulls ForexFactory CSV
  (`https://nfs.faireconomy.media/ff_calendar_thisweek.csv`) with
  `If-None-Match` ETag throttling.
* Seven-provider AI router (OpenAI, Anthropic, Google, xAI, DeepSeek,
  Qwen, Perplexity) with per-provider health, latency, retries and a
  SHA-256 keyed LRU response cache.
* `DecisionEngine` that fuses EA context + Bookmap + News + AI and
  publishes commands back to the EA on the SUB topic
  `oblivious.command`, while always preserving EA trade ownership
  (rule **R7**).
* Encrypted `KeyVault` (AES-256-GCM + scrypt KDF) so API keys never
  hit disk in plaintext.
* Renderer process with seven panels: System, Providers, News,
  Strategies, Orderflow, AI Routing, Decision Trace.

There is **no** named-pipe transport, **no** Deepcharts, **no** parallel
.NET hub. The legacy `.NET` stack is archived only under
`OBLIVIOUS-DEV/project/legacy-frozen/` (reference — do not deploy).

## Quick start

### Vault file (`config.enc`)

Align with production: create **`config.enc`** using **`OBLIVIOUS-DEV/tools/operator/oblivious-config.js`** (paths in [`README_DEV.md`](../OBLIVIOUS-DEV/README_DEV.md)). Recommended local-only vault: **`OBLIVIOUS-DEV/secure-config/dev-local/config.enc`** (resolved before `OBLIVIOUS-VPS/config/` when running Electron from source).

When **`config.enc`** exists, **`npm start` shows the unlock modal** (DEV and VPS); **`KEYVAULT_PASSPHRASE` in `.env` does not bypass** that dialog.

If **no** `config.enc` is found in any search directory, `KeyVault` falls back to `*_API_KEY` entries in `.env` **without** a passphrase prompt (dev convenience only — do not rely on this for VPS deployments).

```pwsh
cd oblivious-hub
copy .env.example .env
# Optional: *_API_KEY in .env only when NOT using config.enc
npm install
npm start
```

Legacy note: some smoke scripts still reference **`keyvault.dat`** as a filename — that is separate from the canonical **`config.enc`** layout used by SecureBoot in `main.js`.

## Wiring

```
+-----------------+   ZMQ REQ/REP :5555    +------------------+
|                 | <--------------------> |                  |
|  MT4 EA         |   ZMQ SUB    :5556     |  Electron Hub    |
|  (mql-zmq)      | <-----------           |  (this app)      |
|                 |   ZMQ PUSH   :5557     |                  |
|                 | -----------> | PULL    |                  |
+-----------------+                        +--------+---------+
                                                    |
                                                    | WS :8081
                                                    v
                                           +------------------+
                                           |  Bookmap add-on  |
                                           |  (Java SDK)      |
                                           +------------------+
```

| Channel              | Direction      | Purpose                              |
| -------------------- | -------------- | ------------------------------------ |
| `tcp://*:5555`       | EA → Hub (REQ) | `ai_query`, `news_query`, `heartbeat` |
| `tcp://*:5556`       | Hub → EA (PUB) | `oblivious.heartbeat`, `oblivious.command`, `oblivious.news`, `oblivious.bookmap` |
| `tcp://*:5557`       | EA → Hub (PUSH)| High-frequency `context_push` (non-blocking) |
| `ws://127.0.0.1:8081`| Bookmap → Hub  | snapshots, trades, MBO, icebergs     |

## Build for production

```pwsh
cd oblivious-hub
npm install
npm run build        # electron-builder, win/x64
```

The packaged app lands in `dist/`. The `zeromq` native module is
already declared in `electron-builder.json` `asarUnpack`, so no
additional postinstall is required.

## Configuration

Environment variables (see `.env.example`):

| Variable                  | Purpose                                |
| ------------------------- | -------------------------------------- |
| `OPENAI_API_KEY`          | OpenAI provider key                    |
| `ANTHROPIC_API_KEY`       | Anthropic provider key                 |
| `GOOGLE_API_KEY`          | Google Gemini key                      |
| `XAI_API_KEY`             | xAI / Grok key                         |
| `DEEPSEEK_API_KEY`        | DeepSeek key                           |
| `QWEN_API_KEY`            | Qwen key                               |
| `PERPLEXITY_API_KEY`      | Perplexity key                         |
| `KEYVAULT_PASSPHRASE`     | scrypt passphrase for `keyvault.dat`   |
| `ZMQ_REP_ENDPOINT`        | default `tcp://*:5555`                 |
| `ZMQ_PUB_ENDPOINT`        | default `tcp://*:5556`                 |
| `ZMQ_PULL_ENDPOINT`       | default `tcp://*:5557`                 |
| `BOOKMAP_WS_URL`          | default `ws://127.0.0.1:8081`          |
| `NEWS_URL`                | default ForexFactory weekly CSV        |

The hub never logs API keys, never writes them to plaintext files and
strips them from telemetry frames.

## Architectural rules enforced

* **R1** — `Predicted` is always AI-and-news-aware (decision engine
  refuses to send `execute` for `Predicted` without a fresh AI vote
  and a passing news gate).
* **R6** — Centralized news policy: high-impact ⇒ only `Predicted`
  may trade.
* **R7** — Hub never owns trades. Every command published carries a
  `requestId` echoed by the EA; the EA stays the sole owner.
* **R8** — Zero `Deepcharts` references; orderflow is Bookmap-only.

See the in-tree comments in `src/services/DecisionEngine.js` for the
exact gating logic.
