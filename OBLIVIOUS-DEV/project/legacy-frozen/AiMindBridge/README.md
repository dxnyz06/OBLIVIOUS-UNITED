# AiMindBridge

AI Bridge system for OBLIVIOUS EA (MT4).

## Architecture

```
MT4 EA (OBLIVIOUS_COMPLETE.mq4)
    │
    │ Named Pipe  \\.\pipe\OBLIVIOUS_AIPC
    │
    ▼
AiMindBridge.DLL (optional C++ wrapper for MT4 #import)
    │
    │ Named Pipe (same)
    │
    ▼
AiMindBridge.Server.exe  (C# .NET 8 Windows service)
    │
    ├── OpenAI Adapter      (env: OPENAI_API_KEY)
    ├── Anthropic Adapter   (env: ANTHROPIC_API_KEY)
    ├── Google Adapter      (env: GOOGLE_API_KEY)
    ├── xAI/Grok Adapter    (env: XAI_API_KEY)
    ├── DeepSeek Adapter    (env: DEEPSEEK_API_KEY)
    └── Qwen Adapter        (env: QWEN_API_KEY)
```

## Setup

### 1. Set API Keys (environment variables — NEVER hardcode)

```powershell
$env:OPENAI_API_KEY    = "sk-..."
$env:ANTHROPIC_API_KEY = "sk-ant-..."
$env:GOOGLE_API_KEY    = "AIza..."
$env:XAI_API_KEY       = "xai-..."
$env:DEEPSEEK_API_KEY  = "..."
$env:QWEN_API_KEY      = "..."
```

### 2. Build the EXE

```powershell
cd AiMindBridge.Server
dotnet build -c Release
dotnet run  # or publish as single-file EXE
```

### 3. Build the DLL (optional, for MT4 #import)

Open `AiMindBridge.DLL.vcxproj` in Visual Studio 2022.
Build for Release|Win32.
Copy `AiMindBridge.dll` to your MT4 `Libraries/` folder.

### 4. Start the Bridge

```powershell
.\AiMindBridge.exe
```

The bridge will wait for EA connections on the named pipe.

## Request/Response Schema

### BridgeRequest (EA → Bridge)
```json
{
  "Symbol": "EURUSD",
  "Timeframe": 60,
  "Direction": 1,
  "EntryPrice": 1.08500,
  "StrategyName": "FVG",
  "TPSLMode": "AI",
  "SetupScore": 78,
  "VolatilityContext": 1.2,
  "SessionContext": "London",
  "IndicatorBiasSupport": 45.0,
  "IndicatorConfidence": 65.0,
  "FilterQualityScore": 72.0,
  "FilterPenaltyScore": 12.0,
  "PatternDirectionSupport": 1,
  "PatternConfidence": 68.0,
  "PatternTriggerQuality": 0.82
}
```

### BridgeResponse (Bridge → EA)
```json
{
  "ProviderUsed": "openai",
  "Confidence": 74,
  "PricePlan": true,
  "SLInitial": 1.08250,
  "TP1": 1.08850,
  "TP2": 1.09200,
  "TP3": 1.09600,
  "TPMax": 1.10000,
  "TrailingMode": "ATR",
  "SLStepMode": "TP1BE",
  "InvalidateIf": "Price closes below 1.082 on H1",
  "Notes": "Strong FVG + London session confluence",
  "Success": true,
  "Error": ""
}
```

## Provider Priority & Fallback

Configured in `appsettings.json`:
```json
"ProviderPriority": ["openai", "anthropic", "google", "xai", "deepseek", "qwen"]
```

The bridge tries providers in this order. On timeout or failure, it falls back to the next.

## Status — Decommissioned

> **This .NET hub has been replaced by the Electron hub at `oblivious-hub/`.**
>
> The named-pipe transport (`\\.\pipe\OBLIVIOUS_AIPC`) and the
> `Deepcharts` integration are gone. The active stack is:
>
> * `oblivious-hub/` — Electron app, ZeroMQ transport on
>   `tcp://127.0.0.1:5555/5556/5557`, 7-provider AI router,
>   ForexFactory news engine, KeyVault, AiCache, Bookmap WS client
>   on `ws://127.0.0.1:8081`.
> * `bookmap-plugin/` — Java add-on that streams MBO / iceberg /
>   imbalance to the Electron hub.
> * `OBLIVIOUS_COMPLETE.mq4` — EA wired to ZeroMQ via `mql-zmq`.
>
> Keep this folder for reference / rollback only; new development
> happens in the two folders above.

## Notes

- The bridge NEVER opens, modifies, or closes MT4 orders
- The EA always remains the trade owner
- API keys are NEVER stored in code or DLL
- All SL/TP management is performed by the EA after receiving the plan
