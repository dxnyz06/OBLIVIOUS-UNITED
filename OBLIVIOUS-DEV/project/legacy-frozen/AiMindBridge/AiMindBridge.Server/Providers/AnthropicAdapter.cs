using System.Text;
using System.Text.Json;
using AiMindBridge.Config;
using Microsoft.Extensions.Logging;

namespace AiMindBridge.Providers;

public sealed class AnthropicAdapter : ProviderAdapterBase
{
    public override string Name => "anthropic";
    private static readonly string DefaultModel = "claude-3-5-haiku-20241022";

    public AnthropicAdapter(ProviderSettings settings, ILogger<AnthropicAdapter> logger)
        : base(settings, logger) { }

    protected override object BuildHttpPayload(string prompt, string apiKey)
    {
        Http.DefaultRequestHeaders.Clear();
        Http.DefaultRequestHeaders.Add("x-api-key", apiKey);
        Http.DefaultRequestHeaders.Add("anthropic-version", "2023-06-01");
        return new
        {
            model       = string.IsNullOrEmpty(Settings.Model) ? DefaultModel : Settings.Model,
            max_tokens  = Settings.MaxTokens,
            temperature = Settings.Temperature,
            system      = "You are a professional forex trade planner. Always respond only with valid JSON.",
            messages    = new[] { new { role = "user", content = prompt } }
        };
    }

    protected override async Task<string> SendHttpAsync(object payload, CancellationToken ct)
    {
        var json    = JsonSerializer.Serialize(payload);
        var content = new StringContent(json, Encoding.UTF8, "application/json");
        var resp    = await Http.PostAsync("https://api.anthropic.com/v1/messages", content, ct);
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(body);
        return doc.RootElement
            .GetProperty("content")[0]
            .GetProperty("text")
            .GetString() ?? "";
    }
}
