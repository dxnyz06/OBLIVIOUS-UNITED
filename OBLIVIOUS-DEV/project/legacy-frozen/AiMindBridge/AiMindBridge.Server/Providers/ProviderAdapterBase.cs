using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using AiMindBridge.Config;
using AiMindBridge.Models;
using Microsoft.Extensions.Logging;

namespace AiMindBridge.Providers;

/// <summary>
/// Base class providing common HTTP infrastructure, prompt building, and response parsing.
/// All providers share the same prompt schema — the AI must return a JSON object.
/// </summary>
public abstract class ProviderAdapterBase : IProviderAdapter
{
    protected readonly ILogger Logger;
    protected readonly ProviderSettings Settings;
    protected readonly HttpClient Http;
    private bool _healthy = true;

    public abstract string Name { get; }
    public bool IsEnabled  => Settings.Enabled && !string.IsNullOrEmpty(Settings.GetApiKey());
    public bool IsHealthy  => _healthy;

    protected ProviderAdapterBase(ProviderSettings settings, ILogger logger)
    {
        Settings = settings;
        Logger   = logger;
        Http     = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
    }

    public async Task<BridgeResponse> QueryAsync(BridgeRequest req, CancellationToken ct)
    {
        try
        {
            var prompt  = BuildPrompt(req);
            var payload = BuildHttpPayload(prompt, Settings.GetApiKey()!);
            var result  = await SendHttpAsync(payload, ct);
            var parsed  = ParseResponse(result, req);
            _healthy    = true;
            return parsed;
        }
        catch (Exception ex)
        {
            _healthy = false;
            Logger.LogWarning("[{Provider}] Query failed: {Msg}", Name, ex.Message);
            return new BridgeResponse { Success = false, Error = ex.Message };
        }
    }

    public async Task<bool> HealthCheckAsync(CancellationToken ct)
    {
        try
        {
            var req = new BridgeRequest
            {
                Symbol        = "EURUSD",
                Direction     = 1,
                EntryPrice    = 1.1000,
                StrategyName  = "Breakout",
                SetupScore    = 70,
                SessionContext = "London"
            };
            var response = await QueryAsync(req, ct);
            _healthy = response.Success;
            return _healthy;
        }
        catch
        {
            _healthy = false;
            return false;
        }
    }

    protected virtual string BuildPrompt(BridgeRequest r)
    {
        var orderflow = r.OrderflowSource != null
            ? $"\nOrderflow ({r.OrderflowSource}):\n" +
              $"  Delta shift: {r.DeltaShift:F2}\n" +
              $"  Cumulative delta: {r.CumulativeDelta:F2}\n" +
              $"  Volume imbalance: {r.VolumeImbalance:F2}\n" +
              $"  Absorption: {r.AbsorptionSeen}\n" +
              $"  Exhaustion: {r.ExhaustionFlag}\n"
            : "";

        const string jsonFormat =
            "{\n" +
            "  \"confidence\": <integer 0-100>,\n" +
            "  \"sl_initial\": <price>,\n" +
            "  \"tp1\": <price>,\n" +
            "  \"tp2\": <price>,\n" +
            "  \"tp3\": <price>,\n" +
            "  \"tpmax\": <price>,\n" +
            "  \"trailing_mode\": \"<ATR|Fixed|Parabolic>\",\n" +
            "  \"sl_step_mode\": \"<TP1BE|TP2TP1|TP3TP2>\",\n" +
            "  \"invalidate_if\": \"<condition string>\",\n" +
            "  \"notes\": \"<optional short note>\"\n" +
            "}";

        return
            "You are a professional forex trade planner AI.\n" +
            "Analyze the following trade setup and respond ONLY with a valid JSON object.\n" +
            "Do not add any explanation outside the JSON.\n\n" +
            "TRADE SETUP:\n" +
            $"  Symbol: {r.Symbol}\n" +
            $"  Timeframe (MT4 PERIOD): {r.Timeframe}\n" +
            $"  Direction: {(r.Direction == 1 ? "BUY" : "SELL")}\n" +
            $"  Entry Price: {r.EntryPrice}\n" +
            $"  Strategy: {r.StrategyName}\n" +
            $"  Setup Score: {r.SetupScore}/100\n" +
            $"  Session: {r.SessionContext}\n" +
            $"  Volatility Context (ATR ratio): {r.VolatilityContext:F2}\n" +
            $"  Indicator Bias: {r.IndicatorBiasSupport:F1} (range -100 to +100)\n" +
            $"  Indicator Confidence: {r.IndicatorConfidence:F1}%\n" +
            $"  Filter Quality: {r.FilterQualityScore:F1}% | Filter Penalty: {r.FilterPenaltyScore:F1}%\n" +
            $"  Pattern Direction Support: {r.PatternDirectionSupport}\n" +
            $"  Pattern Confidence: {r.PatternConfidence:F1}%\n" +
            $"  Pattern Trigger Quality: {r.PatternTriggerQuality:F2}\n" +
            orderflow + "\n" +
            "REQUIRED JSON RESPONSE FORMAT (absolute prices, NOT pips):\n" +
            jsonFormat + "\n\n" +
            "Rules:\n" +
            "- For BUY: sl_initial < entry_price < tp1 < tp2 < tp3 < tpmax\n" +
            "- For SELL: sl_initial > entry_price > tp1 > tp2 > tp3 > tpmax\n" +
            "- TP levels must be spaced realistically (not identical)\n" +
            "- SL must be wider than typical spread noise\n" +
            "- Base levels on volatility context and strategy type\n" +
            "- confidence reflects your certainty in the plan (not the trade outcome)";
    }

    protected abstract Task<string> SendHttpAsync(object payload, CancellationToken ct);
    protected abstract object BuildHttpPayload(string prompt, string apiKey);

    protected BridgeResponse ParseResponse(string raw, BridgeRequest req)
    {
        // Extract JSON block from response text
        var start = raw.IndexOf('{');
        var end   = raw.LastIndexOf('}');
        if (start < 0 || end < 0 || end <= start)
            throw new FormatException($"No JSON object found in provider response: {raw[..Math.Min(200, raw.Length)]}");

        var json = raw[start..(end + 1)];
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        double GetDouble(string key, double fallback = 0) =>
            root.TryGetProperty(key, out var el) ? el.GetDouble() : fallback;
        int GetInt(string key, int fallback = 0) =>
            root.TryGetProperty(key, out var el) ? el.GetInt32() : fallback;
        string GetStr(string key, string fallback = "") =>
            root.TryGetProperty(key, out var el) ? el.GetString() ?? fallback : fallback;

        return new BridgeResponse
        {
            ProviderUsed = Name,
            Confidence   = GetInt("confidence", 50),
            PricePlan    = true,
            SLInitial    = GetDouble("sl_initial"),
            TP1          = GetDouble("tp1"),
            TP2          = GetDouble("tp2"),
            TP3          = GetDouble("tp3"),
            TPMax        = GetDouble("tpmax"),
            TrailingMode = GetStr("trailing_mode", "ATR"),
            SLStepMode   = GetStr("sl_step_mode", "TP1BE"),
            InvalidateIf = GetStr("invalidate_if"),
            Notes        = GetStr("notes"),
            Success      = true
        };
    }
}
