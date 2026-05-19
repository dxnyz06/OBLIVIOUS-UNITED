namespace AiMindBridge.Server.Models;

public class TradingRequest
{
    public string Symbol { get; set; } = string.Empty;
    public string Timeframe { get; set; } = string.Empty;
    public int Direction { get; set; }
    public double EntryPrice { get; set; }
    public string StrategyName { get; set; } = string.Empty;
    public string TpslMode { get; set; } = string.Empty;
    public double SetupScore { get; set; }
    
    public VolatilityContext? VolatilityContext { get; set; }
    public SessionContext? SessionContext { get; set; }
    public IndicatorSupports? IndicatorSupports { get; set; }
    public FilterSupports? FilterSupports { get; set; }
    public PatternSupports? PatternSupports { get; set; }
}

public class VolatilityContext
{
    public double AtrValue { get; set; }
    public double AtrPercentile { get; set; }
    public string VolatilityRegime { get; set; } = string.Empty;
}

public class SessionContext
{
    public string SessionName { get; set; } = string.Empty;
    public double SessionQuality { get; set; }
    public double RelativeVolume { get; set; }
}

public class IndicatorSupports
{
    public double TrendSupport { get; set; }
    public double MomentumSupport { get; set; }
    public double OscillatorSupport { get; set; }
    public double VolumeSupport { get; set; }
}

public class FilterSupports
{
    public double QualityScore { get; set; }
    public double PenaltyScore { get; set; }
    public double ContextScore { get; set; }
}

public class PatternSupports
{
    public int DirectionSupport { get; set; }
    public double ConfidenceSupport { get; set; }
    public double TriggerQuality { get; set; }
}