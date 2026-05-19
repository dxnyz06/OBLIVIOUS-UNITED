using System.Text;
using System.Text.Json;
using AiMindBridge.Config;
using Microsoft.Extensions.Logging;

namespace AiMindBridge.Providers;

public sealed class GoogleAdapter : ProviderAdapterBase
{
    public override string Name => "google";
    private static readonly string DefaultModel = "gemini-1.5-flash";

    public GoogleAdapter(ProviderSettings settings, ILogger<GoogleAdapter> logger)
        : base(settings, logger) { }

    protected override object BuildHttpPayload(string prompt, string apiKey)
    {
        Http.DefaultRequestHeaders.Clear();
        return new
        {
            contents = new[]
            {
                new
                {
                    parts = new[]
                    {
                        new { text = "You are a professional forex trade planner. Always respond only with valid JSON.\n\n" + prompt }
                    }
                }
            },
            generationConfig = new
            {
                temperature     = Settings.Temperature,
                maxOutputTokens = Settings.MaxTokens
            }
        };
    }

    protected override async Task<string> SendHttpAsync(object payload, CancellationToken ct)
    {
        var model  = string.IsNullOrEmpty(Settings.Model) ? DefaultModel : Settings.Model;
        var apiKey = Settings.GetApiKey();
        var url    = $"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}";
        var json    = JsonSerializer.Serialize(payload);
        var content = new StringContent(json, Encoding.UTF8, "application/json");
        var resp    = await Http.PostAsync(url, content, ct);
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(body);
        return doc.RootElement
            .GetProperty("candidates")[0]
            .GetProperty("content")
            .GetProperty("parts")[0]
            .GetProperty("text")
            .GetString() ?? "";
    }
}
