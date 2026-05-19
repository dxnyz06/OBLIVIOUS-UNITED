namespace AiMindBridge.Models;

/// <summary>
/// Request sent from the MQ4 EA to the AI Bridge.
/// All fields are serialized as JSON over the named pipe.
/// </summary>
public sealed class BridgeRequest
{
    // === Core context ===
    public string Symbol         { get; set; } = "";
    public int    Timeframe      { get; set; }
    public int    Direction      { get; set; }   // +1 buy, -1 sell
    public double EntryPrice     { get; set; }
    public string StrategyName   { get; set; } = "";
    public string Mode           { get; set; } = "";   // "Aggressive", "Moderate", "Conservative"
    public string TPSLMode       { get; set; } = "AI"; // "AI" or "Native"

    // === Direction context ===
    public string DirectionContext { get; set; } = ""; // "impulse_bull", "retracement", etc.

    // === Setup quality ===
    public double SetupScore         { get; set; }  // 0-100
    public double VolatilityContext  { get; set; }  // ATR ratio
    public string SessionContext     { get; set; } = "";

    // === Engine support outputs ===
    public double IndicatorBiasSupport    { get; set; }
    public double IndicatorConfidence     { get; set; }
    public double FilterQualityScore      { get; set; }
    public double FilterPenaltyScore      { get; set; }
    public double PatternDirectionSupport { get; set; }
    public double PatternConfidence       { get; set; }
    public double PatternTriggerQuality   { get; set; }

    // === News context ===
    public int    NewsImpactLevel    { get; set; } // 0=none, 1=low, 2=medium, 3=high
    public string NewsContext        { get; set; } = "";
    public bool   NewsBlockActive    { get; set; }

    // === Trade state (management requests) ===
    public bool   TradeOpen      { get; set; }
    public int    Ticket         { get; set; }
    public double OpenPrice      { get; set; }
    public double CurrentSL      { get; set; }
    public double CurrentTP      { get; set; }
    public double UnrealizedPnL  { get; set; }
    public int    BarsOpen       { get; set; }

    // === Orderflow (Bookmap-only) ===
    public double? DeltaShift      { get; set; }
    public double? CumulativeDelta { get; set; }
    public double? VolumeImbalance { get; set; }
    public bool?   AbsorptionSeen  { get; set; }
    public bool?   ExhaustionFlag  { get; set; }
    public double? DomPressure     { get; set; } // -100 to +100
    public string? OrderflowSource { get; set; } // "Bookmap" or null
    public string  OrderflowBias   { get; set; } = "Neutral";
    public double  OrderflowConfidence { get; set; }

    // === Spread / execution context ===
    public double SpreadAnomalyScore   { get; set; }
    public double SpreadStabilityScore { get; set; }
}
