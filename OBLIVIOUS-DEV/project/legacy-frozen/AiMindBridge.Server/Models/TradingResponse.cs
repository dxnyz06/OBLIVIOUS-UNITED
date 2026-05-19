namespace AiMindBridge.Server.Models;

public class TradingResponse
{
    public string ProviderUsed { get; set; } = string.Empty;
    public double Confidence { get; set; }
    public double SlInitial { get; set; }
    public double Tp1 { get; set; }
    public double Tp2 { get; set; }
    public double Tp3 { get; set; }
    public double TpMax { get; set; }
    public string TrailingMode { get; set; } = string.Empty;
    public string SlStepMode { get; set; } = string.Empty;
    public string InvalidateIf { get; set; } = string.Empty;
    public string Notes { get; set; } = string.Empty;
    public bool Success { get; set; }
    public string ErrorMessage { get; set; } = string.Empty;
}