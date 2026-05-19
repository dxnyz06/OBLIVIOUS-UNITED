namespace AiMindBridge.Config;

/// <summary>
/// Runtime configuration loaded from appsettings.json.
/// API keys are NEVER hardcoded — always read from environment variables or config file.
/// </summary>
public sealed class BridgeConfig
{
    public string PipeName            { get; set; } = @"\\.\pipe\OBLIVIOUS_AIPC";
    public int    PipeTimeout         { get; set; } = 3000;  // ms
    public int    MaxConcurrentPipes  { get; set; } = 4;
    public int    ProviderTimeoutMs   { get; set; } = 8000;
    public int    ProviderRetryLimit  { get; set; } = 2;
    public string LogLevel            { get; set; } = "Information";
    public string LogFile             { get; set; } = "AiMindBridge.log";

    // Provider priority chain (first = highest priority).
    // Default empty so that Bind() from appsettings.json doesn't double-populate.
    // appsettings.json must always declare the full ordered list.
    public List<string> ProviderPriority { get; set; } = new();

    // Individual provider settings (enable/disable without removing API key)
    public ProviderSettings OpenAI    { get; set; } = new();
    public ProviderSettings Anthropic { get; set; } = new();
    public ProviderSettings Google    { get; set; } = new();
    public ProviderSettings XAI       { get; set; } = new();
    public ProviderSettings DeepSeek  { get; set; } = new();
    public ProviderSettings Qwen       { get; set; } = new();
    public ProviderSettings Perplexity { get; set; } = new();

    // Bookmap WebSocket
    public bool   EnableBookmap    { get; set; } = false;
    public string BookmapWsUrl     { get; set; } = "ws://localhost:9090";

    // AI Cache mode
    public string CacheMode        { get; set; } = "moderate"; // "conservative", "moderate", "aggressive"
}

public sealed class ProviderSettings
{
    public bool   Enabled    { get; set; } = true;
    public string ApiKeyEnv  { get; set; } = ""; // environment variable name for API key
    public string Model      { get; set; } = ""; // model identifier
    public string BaseUrl    { get; set; } = ""; // optional custom endpoint
    public int    MaxTokens  { get; set; } = 512;
    public double Temperature { get; set; } = 0.1;

    public string? GetApiKey() =>
        string.IsNullOrEmpty(ApiKeyEnv) ? null : Environment.GetEnvironmentVariable(ApiKeyEnv);
}
