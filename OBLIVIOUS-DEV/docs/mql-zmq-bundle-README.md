# OBLIVIOUS — MQL-ZMQ Bundle

Pre-packaged dependencies that the MetaTrader 4 side of OBLIVIOUS
needs in order to talk to the Electron hub via ZeroMQ.

## What's in here

```
mql-zmq-bundle/
  Library/
    libzmq.dll        (x86, 328 KB)
    libsodium.dll     (x86, 472 KB)
  Include/
    Zmq/
      Zmq.mqh
      Socket.mqh
      Context.mqh
      ...
    Mql/
      Lang/
        Mql.mqh
        Native.mqh
        Error.mqh
        ...
  Install-Into-MT4.ps1
```

Sources:
* `libzmq.dll` and `libsodium.dll` come from the official
  [`dingmaotu/mql-zmq`](https://github.com/dingmaotu/mql-zmq)
  repository (`Library/MT4/`).
* All `.mqh` headers come from the same repository
  (`Include/Mql/Lang/*` and `Include/Zmq/*`).

## Install

From an elevated PowerShell:

```pwsh
cd "c:\Users\dxnyz\Desktop\OBLIVIOUS UNITED\mql-zmq-bundle"
# Replace with YOUR terminal path. The easiest way to find it is:
#   open MT4, then File -> Open Data Folder.
.\Install-Into-MT4.ps1 -MT4Path "$env:APPDATA\MetaQuotes\Terminal\<your-hash>"
```

Or, if MetaTrader is installed under "Program Files":

```pwsh
.\Install-Into-MT4.ps1 -MT4Path "C:\Program Files (x86)\MetaTrader 4"
```

The script copies:

| Source                                | Destination                           |
| ------------------------------------- | ------------------------------------- |
| `Library\libzmq.dll`                  | `<MT4>\MQL4\Libraries\libzmq.dll`     |
| `Library\libsodium.dll`               | `<MT4>\MQL4\Libraries\libsodium.dll`  |
| `Include\Zmq\*.mqh`                   | `<MT4>\MQL4\Include\Zmq\`             |
| `Include\Mql\Lang\*.mqh`              | `<MT4>\MQL4\Include\Mql\Lang\`        |

## After install

1. In MetaTrader 4: **Tools → Options → Expert Advisors → Allow DLL imports**.
2. Open `OBLIVIOUS_COMPLETE.mq4` in MetaEditor, press **F7**.
3. Expected: zero errors / zero warnings.

## How the EA uses it

The EA's header has:

```mq4
#include <Zmq/Zmq.mqh>
```

…and globally:

```mq4
Context g_zmq_ctx;
Socket  g_zmq_req(g_zmq_ctx, ZMQ_REQ);
Socket  g_zmq_sub(g_zmq_ctx, ZMQ_SUB);
Socket  g_zmq_push(g_zmq_ctx, ZMQ_PUSH);
```

Endpoints (defined in the EA, must match `oblivious-hub`'s
`.env`):

| Direction      | Socket | Endpoint                  |
| -------------- | ------ | ------------------------- |
| EA ↔ hub sync  | REQ    | `tcp://127.0.0.1:5555`    |
| Hub → EA       | SUB    | `tcp://127.0.0.1:5556`    |
| EA → hub burst | PUSH   | `tcp://127.0.0.1:5557`    |

If `libzmq.dll` is missing, the EA detects the load failure in
`AIBridge_Connect`, sets `g_ai_connected = false` and continues
in pure-Native mode (R2 fallback).
