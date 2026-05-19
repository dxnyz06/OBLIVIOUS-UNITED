using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json;
using AiMindBridge.Server.Models;
using System.Text;

namespace AiMindBridge.Server.Providers;

public class OpenAiAdapter : IProviderAdapter
{
    private readonly IConfiguration _configuration;
    private readonly ILogger<OpenAiAdapter> _logger;
    private readonly HttpClient _httpClient;
    private string? _apiKey;

    public string ProviderName => "OpenAI";
    public bool IsHealthy { get; private set; }
    public int Priority => _configuration.GetValue<int>("Providers:OpenAI:Priority", 1);

    public OpenAiAdapter(IConfiguration configuration, ILogger<OpenAiAdapter> logger)
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
            // Get API key from environment or configuration
            _apiKey = Environment.GetEnvironmentVariable("OPENAI_API_KEY") 
                     ?? _configuration["Providers:OpenAI:ApiKey"];

            if (string.IsNullOrEmpty(_apiKey))
            {
                _logger.LogWarning("OpenAI API key not found in environment or configuration");
                return false;
            }

            _httpClient.DefaultRequestHeaders.Clear();
            _httpClient.DefaultRequestHeaders.Add("Authorization", $"Bearer {_apiKey}");
            _httpClient.DefaultRequestHeaders.Add("User-Agent", "OBLIVIOUS-AI-Bridge/1.0");

            IsHealthy = await TestConnectionAsync();
            _logger.LogInformation($"OpenAI adapter initialized. Healthy: {IsHealthy}");
            return IsHealthy;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to initialize OpenAI adapter");
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
                ErrorMessage = "OpenAI provider not healthy or API key missing" 
            };
        }

        try
        {
            var prompt = BuildPrompt(request);
            var response = await CallOpenAiApi(prompt);
            
            return ParseResponse(response, request);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing OpenAI request");
            return new TradingResponse 
            { 
                Success = false, 
                ErrorMessage = $"OpenAI processing error: {ex.Message}" 
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
                model = "gpt-3.5-turbo",
                messages = new[]
                {
                    new { role = "user", content = "Test connection" }
                },
                max_tokens = 10
            };

            var json = JsonConvert.SerializeObject(testPayload);
            var content = new StringContent(json, Encoding.UTF8, "application/json");

            var response = await _httpClient.PostAsync("https://api.openai.com/v1/chat/completions", content);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private string BuildPrompt(TradingRequest request)
    {
        var sb = new StringBuilder();
        sb.AppendLine("You are a professional trading AI assistant. Analyze the following trading setup and provide TP/SL levels.");
        sb.AppendLine($"Symbol: {request.Symbol}");
        sb.AppendLine($"Strategy: {request.StrategyName}");
        sb.AppendLine($"Direction: {(request.Direction > 0 ? "BUY" : "SELL")}");
        sb.AppendLine($"Entry Price: {request.EntryPrice:F5}");
        sb.AppendLine($"Setup Score: {request.SetupScore:F1}%");
        
        if (request.VolatilityContext != null)
        {
            sb.AppendLine($"ATR: {request.VolatilityContext.AtrValue:F5}");
            sb.AppendLine($"Volatility Regime: {request.VolatilityContext.VolatilityRegime}");
        }

        sb.AppendLine("\nProvide response in JSON format with these exact fields:");
        sb.AppendLine("sl_initial, tp1, tp2, tp3, tpmax, trailing_mode, sl_step_mode, confidence, notes");
        
        return sb.ToString();
    }

    private async Task<string> CallOpenAiApi(string prompt)
    {
        var payload = new
        {
            model = _configuration["Providers:OpenAI:Model"] ?? "gpt-3.5-turbo",
            messages = new[]
            {
                new { role = "system", content = "You are a professional trading AI that provides precise TP/SL analysis." },
                new { role = "user", content = prompt }
            },
            max_tokens = 500,
            temperature = 0.3
        };

        var json = JsonConvert.SerializeObject(payload);
        var content = new StringContent(json, Encoding.UTF8, "application/json");

        var response = await _httpClient.PostAsync("https://api.openai.com/v1/chat/completions", content);
        response.EnsureSuccessStatusCode();

        var responseJson = await response.Content.ReadAsStringAsync();
        dynamic result = JsonConvert.DeserializeObject(responseJson)!;
        
        return result.choices[0].message.content;
    }

    private TradingResponse ParseResponse(string aiResponse, TradingRequest request)
    {
        try
        {
            // Try to extract JSON from AI response
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
                    Notes = parsed.notes ?? "AI-generated levels"
                };
            }
            
            // Fallback to default calculation
            return CreateDefaultResponse(request);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to parse AI response, using defaults");
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
            Notes = "Default calculation used"
        };
    }

    private double CalculateDefaultSL(TradingRequest request)
    {
        var atr = request.VolatilityContext?.AtrValue ?? 0.001;
        var multiplier = 1.5;
        
        return request.Direction > 0 
            ? request.EntryPrice - (atr * multiplier)
            : request.EntryPrice + (atr * multiplier);
    }

    private double CalculateDefaultTP(TradingRequest request, double multiplier)
    {
        var atr = request.VolatilityContext?.AtrValue ?? 0.001;
        
        return request.Direction > 0 
            ? request.EntryPrice + (atr * multiplier)
            : request.EntryPrice - (atr * multiplier);
    }
}