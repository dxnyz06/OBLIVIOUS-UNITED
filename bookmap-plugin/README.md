# OBLIVIOUS Bookmap Bridge

Bookmap Global+ Add-on that streams MBO / iceberg / stop-run / imbalance
events to the OBLIVIOUS Electron Hub over a local WebSocket on
`ws://127.0.0.1:8081`.

## Build

The Bookmap SDK is provided locally by your Bookmap installation. The
`pom.xml` references it via Maven `system` scope so we don't need to
publish anything to a private registry. There are three equally valid
ways to point the build at the SDK jars (`bm-l1api.jar` and
`bm-simplified-api.jar`):

1. **Drop them into `bookmap-plugin/lib/`** (default, no env var needed).
2. **Set the `BOOKMAP_HOME` environment variable** to your Bookmap root.
3. **Pass `-DbookmapHome=...` on the Maven cmd line** (highest priority).

The jars usually live in `<Bookmap install>\lib\` (Windows) or
`/Applications/Bookmap.app/Contents/Resources/lib/` (macOS).

```pwsh
# option A — drop jars into bookmap-plugin/lib/ then:
cd bookmap-plugin
mvn package

# option B — env var
$env:BOOKMAP_HOME = "C:\Bookmap\v7.6.0"
cd bookmap-plugin
mvn package

# option C — cmd line override
cd bookmap-plugin
mvn -DbookmapHome="C:/Bookmap/v7.6.0" package
```

The shaded jar lands in `target/oblivious-bookmap-bridge-1.0.0.jar`.

## Install

Copy the shaded jar into Bookmap's add-ons folder
(usually `%USERPROFILE%\AppData\Roaming\Bookmap\Bookmap\addons\`),
then enable **OBLIVIOUS Bridge** in the Bookmap Add-ons panel.

## Runtime

* Listens on `0.0.0.0:8081` (Java-WebSocket).
* Batches outgoing messages every 50 ms.
* Handles client disconnect/reconnect transparently — the Electron
  hub's `BookmapClient` reconnects with exponential backoff.
* Logs visible in Bookmap's `View → Show log`.

## Message contract

```json
{ "type": "snapshot", "symbol": "XAUUSD",
  "bidImbalance": 0.62, "askImbalance": 0.38,
  "icebergCount": 12, "stopRunCount": 3,
  "ts": 1715337600000 }
```

```json
{ "type": "trade", "symbol": "XAUUSD",
  "price": 2354.21, "size": 5, "aggressor": "buy",
  "ts": 1715337600000 }
```

The hub's `src/services/BookmapClient.js` accepts any `{ type, symbol, ... }`
shape and merges it into a rolling snapshot for the renderer and
`DecisionEngine`.
