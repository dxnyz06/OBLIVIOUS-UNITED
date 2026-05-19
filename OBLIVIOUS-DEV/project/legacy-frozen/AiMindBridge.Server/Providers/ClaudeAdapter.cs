using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json;
using AiMindBridge.Server.Models;
using System.Text;

namespace AiMindBridge.Server.Providers;

public class ClaudeAdapter : IProviderAdapter
{
    private readonly IConfiguration _configuration;
    private readonly ILogger<ClaudeAdapter> _logger;
    private readonly HttpClient _httpClient;
    private string? _apiKey;

    public string ProviderName => "Claude";
    public bool IsHealthy { get; private set; }
    public int Priority => _configuration.GetValue<int>("Providers:Claude:Priority", 2);

    public ClaudeAdapter(IConfiguration configuration, ILogger<ClaudeAdapter> logger)
    {
        _configuration = configuration;
        _logger = logger;
        _httpClient = new HttpClient();
        _httpClient.Timeout = TimeSpan.FromSeconds(30);
    }

    public async Task<bool> InitializeAsync()
    {
        try
        {
            _apiKey = Environment.GetEnvironmentVariable("ANTHROPIC_API_KEY") 
                     ?? _configuration["Providers:Claude:ApiKey"];

            if (string.IsNullOrEmpty(_apiKey))
            {
                _logger.LogWarning("Claude API key not found");
                return false;
            }

            _httpClient.DefaultRequestHeaders.Clear();
            _httpClient.DefaultRequestHeaders.Add("x-api-key", _apiKey);
            _httpClient.DefaultRequestHeaders.Add("anthropic-version", "2023-06-01");

            IsHealthy = await TestConnectionAsync();
            _logger.LogInformation($"Claude adapter initialized. Healthy: {IsHealthy}");
            return IsHealthy;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to initialize Claude adapter");
            IsHealthy = false;
            return false;
        }
    }

    public async Task<TradingResponse> ProcessRequestAsync(TradingRequest request)
    {
        if (!IsHealthy || string.IsNullOrEmpty(_apiKey))
        {
            return new TradingResponse 
            { 
                Success = false, 
                ErrorMessage = "Claude provider not healthy" 
            };
        }

        try
        {
            var prompt = BuildPrompt(request);
            var response = await CallClaudeApi(prompt);
            
            return ParseResponse(response, request);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing Claude request");
            return new TradingResponse 
            { 
                Success = false, 
                ErrorMessage = $"Claude processing error: {ex.Message}" 
            };
        }
    }

    public async Task<bool> TestConnectionAsync()
    {
        try
        {
            if (string.IsNullOrEmpty(_apiKey))
                return false;

            var testPayload = new
            {
                model = "claude-3-haiku-20240307",
                max_tokens = 10,
                messages = new[]
                {
                    new { role = "user", content = "Test" }
                }
            };

            var json = JsonConvert.SerializeObject(testPayload);
            var content = new StringContent(json, Encoding.UTF8, "application/json");

            var response = await _httpClient.PostAsync("https://api.anthropic.com/v1/messages", content);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private string BuildPrompt(TradingRequest request)
    {
        return $@"Analyze this trading setup and provide TP/SL levels:

Symbol: {request.Symbol}
Strategy: {request.StrategyName}
Direction: {(request.Direction > 0 ? "BUY" : "SELL")}
Entry: {request.EntryPrice:F5}
Setup Score: {request.SetupScore:F1}%

Respond with JSON containing: sl_initial, tp1, tp2, tp3, tpmax, trailing_mode, sl_step_mode, confidence, notes";
    }

    private async Task<string> CallClaudeApi(string prompt)
    {
        var payload = new
        {
            model = _configuration["Providers:Claude:Model"] ?? "claude-3-haiku-20240307",
            max_tokens = 500,
            messages = new[]
            {
                new { role = "user", content = prompt }
            }
        };

        var json = JsonConvert.SerializeObject(payload);
        var content = new StringContent(json, Encoding.UTF8, "application/json");

        var response = await _httpClient.PostAsync("https://api.anthropic.com/v1/messages", content);
        response.EnsureSuccessStatusCode();

        var responseJson = await response.Content.ReadAsStringAsync();
        dynamic result = JsonConvert.DeserializeObject(responseJson)!;
        
        return result.content[0].text;
    }

    private TradingResponse ParseResponse(string aiResponse, TradingRequest request)
    {
        try
        {
            var jsonStart = aiResponse.IndexOf('{');
            var jsonEnd = aiResponse.LastIndexOf('}');
            
            if (jsonStart >= 0 && jsonEnd > jsonStart)
            {
                var jsonStr = aiResponse.Substring(jsonStart, jsonEnd - jsonStart + 1);
                dynamic parsed = JsonConvert.DeserializeObject(jsonStr)!;
                
                return new TradingResponse
                {
                    ProviderUsed = ProviderName,
                    Success = true,
                    Confidence = parsed.confidence ?? 75.0,
                    SlInitial = parsed.sl_initial ?? CalculateDefaultSL(request),
                    Tp1 = parsed.tp1 ?? CalculateDefaultTP(request, 1.0),
                    Tp2 = parsed.tp2 ?? CalculateDefaultTP(request, 2.0),
                    Tp3 = parsed.tp3 ?? CalculateDefaultTP(request, 3.0),
                    TpMax = parsed.tpmax ?? CalculateDefaultTP(request, 5.0),
                    TrailingMode = parsed.trailing_mode ?? "Standard",
                    SlStepMode = parsed.sl_step_mode ?? "TP_Levels",
                    Notes = parsed.notes ?? "Claude-generated levels"
                };
            }
            
            return CreateDefaultResponse(request);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to parse Claude response, using defaults");
            return CreateDefaultResponse(request);
        }
    }

    private TradingResponse CreateDefaultResponse(TradingRequest request)
    {
        return new TradingResponse
        {
            ProviderUsed = ProviderName,
            Success = true,
            Confidence = 70.0,
            SlInitial = CalculateDefaultSL(request),
            Tp1 = CalculateDefaultTP(request, 1.0),
            Tp2 = CalculateDefaultTP(request, 2.0),
            Tp3 = CalculateDefaultTP(request, 3.0),
            TpMax = CalculateDefaultTP(request, 5.0),
            TrailingMode = "Standard",
            SlStepMode = "TP_Levels",
            Notes = "Default calculation"
        };
    }

    private double CalculateDefaultSL(TradingRequest request)
    {
        var atr = request.VolatilityContext?.AtrValue ?? 0.001;
        return request.Direction > 0 
            ? request.EntryPrice - (atr * 1.5)
            : request.EntryPrice + (atr * 1.5);
    }

    private double CalculateDefaultTP(TradingRequest request, double multiplier)
    {
        var atr = request.VolatilityContext?.AtrValue ?? 0.001;
        return request.Direction > 0 
            ? request.EntryPrice + (atr * multiplier)
            : request.EntryPrice - (atr * multiplier);
    }
}