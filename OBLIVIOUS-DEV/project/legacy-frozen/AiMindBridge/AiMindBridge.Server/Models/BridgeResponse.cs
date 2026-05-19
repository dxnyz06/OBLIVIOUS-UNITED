namespace AiMindBridge.Models;

/// <summary>
/// Response sent from the AI Bridge back to the MQ4 EA.
/// The EA uses these values to set SL/TP and manage the trade.
/// The EA ALWAYS remains the trade owner — the bridge only provides the plan.
/// </summary>
public sealed class BridgeResponse
{
    // === Provider info ===
    public string ProviderUsed  { get; set; } = "";
    public int    AiConfidence  { get; set; }   // 0-100 AI confidence
    public int    Confidence    { get; set; }   // alias for compatibility

    // === Bias ===
    public string NewsBias      { get; set; } = "Neutral";
    public string OrderflowBias { get; set; } = "Neutral";
    public string FinalBias     { get; set; } = "Neutral"; // combined decision

    // === News block state ===
    public bool   NewsBlockNewEntries     { get; set; }
    public int    NewsImpactLevel         { get; set; }   // 0=none, 1=low, 2=med, 3=high
    public int    MinutesToEvent          { get; set; } = 9999;
    public bool   PredictedSetupValid     { get; set; }

    // === TP/SL Plan ===
    public bool   PricePlan   { get; set; } = true;
    public double SLInitial   { get; set; }
    public double TP1         { get; set; }
    public double TP2         { get; set; }
    public double TP3         { get; set; }
    public double TPMax       { get; set; }

    // === Management hints ===
    public string TrailingMode  { get; set; } = "ATR";
    public string SLStepMode    { get; set; } = "TP1BE";
    public string InvalidateIf  { get; set; } = "";
    public bool   HoldContinue  { get; set; } = true;
    public bool   CancelSignal  { get; set; }

    // === Error handling ===
    public bool   Success    { get; set; } = true;
    public string Error      { get; set; } = "";

    // === Optional notes ===
    public string? Notes { get; set; }
}
