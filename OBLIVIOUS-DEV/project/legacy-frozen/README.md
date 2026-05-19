# Legacy frozen stack (obsolete)

These directories preserve the **pre–Electron / pre–ZeroMQ** bridge:

- **`AiMindBridge/`** — .NET 8 server + pipe `OBLIVIOUS_AIPC` + optional DLL wrapper
- **`AiMindBridge.Server/`** — alternate / older server layout
- **`ObliviousBridge.DLL/`** — legacy MT4 DLL named-pipe bridge

The **live** stack uses:

- EA ↔ **ZeroMQ** ↔ `oblivious-hub/` (Electron)
- Bookmap ↔ **WebSocket :8081** ↔ `oblivious-hub/`

Nothing here is required to run or build the current software. Keep this
folder only for historical reference or forensic comparison.
