using System.Text;
using System.Text.Json;
using AiMindBridge.Config;
using Microsoft.Extensions.Logging;

namespace AiMindBridge.Providers;

public sealed class OpenAIAdapter : ProviderAdapterBase
{
    public override string Name => "openai";
    private static readonly string DefaultModel = "gpt-4o-mini";

    public OpenAIAdapter(ProviderSettings settings, ILogger<OpenAIAdapter> logger)
        : base(settings, logger) { }

    protected override object BuildHttpPayload(string prompt, string apiKey)
    {
        Http.DefaultRequestHeaders.Clear();
        Http.DefaultRequestHeaders.Add("Authorization", $"Bearer {apiKey}");
        return new
        {
            model       = string.IsNullOrEmpty(Settings.Model) ? DefaultModel : Settings.Model,
            max_tokens  = Settings.MaxTokens,
            temperature = Settings.Temperature,
            messages    = new[]
            {
                new { role = "system", content = "You are a professional forex trade planner. Always respond only with valid JSON." },
                new { role = "user",   content = prompt }
            }
        };
    }

    protected override async Task<string> SendHttpAsync(object payload, CancellationToken ct)
    {
        var json    = JsonSerializer.Serialize(payload);
        var content = new StringContent(json, Encoding.UTF8, "application/json");
        var resp    = await Http.PostAsync("https://api.openai.com/v1/chat/completions", content, ct);
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(body);
        return doc.RootElement
            .GetProperty("choices")[0]
            .GetProperty("message")
            .GetProperty("content")
            .GetString() ?? "";
    }
}
