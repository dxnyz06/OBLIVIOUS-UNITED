using System.Globalization;
using AiMindBridge.Config;
using Microsoft.Extensions.Logging;

namespace AiMindBridge.Bridge;

public sealed class NewsEvent
{
    public string Title    { get; set; } = "";
    public string Currency { get; set; } = "";
    public DateTime Time   { get; set; }
    public string Impact   { get; set; } = ""; // "High", "Medium", "Low", "Holiday"
    public string Forecast { get; set; } = "";
    public string Previous { get; set; } = "";
}

public sealed class NewsIngestionEngine
{
    private const string CsvUrl = "https://nfs.faireconomy.media/ff_calendar_thisweek.csv";
    private readonly ILogger<NewsIngestionEngine> _logger;
    private readonly HttpClient _http = new();
    private List<NewsEvent> _events = new();
    private string? _lastETag;
    private DateTime _lastFetch = DateTime.MinValue;
    private readonly TimeSpan _minFetchInterval = TimeSpan.FromMinutes(5);

    public IReadOnlyList<NewsEvent> Events => _events;

    public NewsIngestionEngine(ILogger<NewsIngestionEngine> logger)
    {
        _logger = logger;
    }

    public async Task UpdateAsync(CancellationToken ct)
    {
        if (DateTime.UtcNow - _lastFetch < _minFetchInterval)
            return;

        try
        {
            var request = new HttpRequestMessage(HttpMethod.Get, CsvUrl);
            if (_lastETag != null)
                request.Headers.IfNoneMatch.Add(new System.Net.Http.Headers.EntityTagHeaderValue($"\"{_lastETag}\""));

            var response = await _http.SendAsync(request, ct);
            if (response.StatusCode == System.Net.HttpStatusCode.NotModified)
            {
                _lastFetch = DateTime.UtcNow;
                return;
            }

            response.EnsureSuccessStatusCode();
            _lastETag = response.Headers.ETag?.Tag?.Trim('"');
            var csv = await response.Content.ReadAsStringAsync(ct);
            _events = ParseCsv(csv);
            _lastFetch = DateTime.UtcNow;
            _logger.LogInformation("[News] Loaded {Count} events from ForexFactory CSV", _events.Count);
        }
        catch (Exception ex)
        {
            _logger.LogWarning("[News] CSV fetch failed: {Msg}", ex.Message);
        }
    }

    private List<NewsEvent> ParseCsv(string csv)
    {
        var result = new List<NewsEvent>();
        var lines = csv.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        if (lines.Length < 2) return result;

        for (int i = 1; i < lines.Length; i++)
        {
            var parts = lines[i].Split(',');
            if (parts.Length < 6) continue;

            try
            {
                var title    = parts[0].Trim().Trim('"');
                var currency = parts[1].Trim().Trim('"');
                var dateStr  = parts[2].Trim().Trim('"');
                var timeStr  = parts[3].Trim().Trim('"');
                var impact   = parts[4].Trim().Trim('"');
                var forecast = parts.Length > 5 ? parts[5].Trim().Trim('"') : "";
                var previous = parts.Length > 6 ? parts[6].Trim().Trim('"') : "";

                DateTime dt;
                var combined = $"{dateStr} {timeStr}".Trim();
                if (!DateTime.TryParse(combined, CultureInfo.InvariantCulture,
                        DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out dt))
                {
                    if (!DateTime.TryParseExact(combined,
                        new[] { "MM-dd-yyyy h:mmtt", "MM-dd-yyyy hh:mmtt", "MM/dd/yyyy h:mmtt" },
                        CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out dt))
                        continue;
                }

                result.Add(new NewsEvent
                {
                    Title    = title,
                    Currency = currency,
                    Time     = dt,
                    Impact   = NormalizeImpact(impact),
                    Forecast = forecast,
                    Previous = previous
                });
            }
            catch { }
        }

        return result.OrderBy(e => e.Time).ToList();
    }

    private static string NormalizeImpact(string raw)
    {
        var lower = raw.ToLowerInvariant();
        if (lower.Contains("high")) return "High";
        if (lower.Contains("medium") || lower.Contains("med")) return "Medium";
        if (lower.Contains("low")) return "Low";
        if (lower.Contains("holiday")) return "Holiday";
        return "Low";
    }

    public NewsContext GetContext() => GetContext("XAUUSD", DateTime.UtcNow);

    public NewsContext GetContext(string symbol, DateTime now, int preMinutes = 30, int postMinutes = 60)
    {
        var relevantCurrencies = GetRelevantCurrencies(symbol);
        var ctx = new NewsContext();

        foreach (var ev in _events)
        {
            if (!relevantCurrencies.Contains(ev.Currency)) continue;

            var minutesToEvent = (int)(ev.Time - now).TotalMinutes;

            if (minutesToEvent > -postMinutes && minutesToEvent < preMinutes)
            {
                if (ev.Impact == "High")
                {
                    ctx.BlockNewEntries = true;
                    ctx.SpikeRisk = true;
                    ctx.VolatilityExpected = "High";
                }
                ctx.ActiveEvents.Add(ev);
            }

            if (minutesToEvent > 0 && minutesToEvent < 120 && ev.Impact == "High")
            {
                if (ctx.NextHighImpact == null || ev.Time < ctx.NextHighImpact.Time)
                    ctx.NextHighImpact = ev;
            }
        }

        ctx.NewsBias = ComputeNewsBias(ctx.ActiveEvents);
        ctx.CooldownState = ctx.BlockNewEntries ? "BLOCKED" : "CLEAR";

        return ctx;
    }

    private static HashSet<string> GetRelevantCurrencies(string symbol)
    {
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var sym = symbol.ToUpperInvariant();
        if (sym.Contains("USD") || sym.Contains("XAU") || sym.Contains("GOLD")) result.Add("USD");
        if (sym.Contains("EUR")) result.Add("EUR");
        if (sym.Contains("GBP")) result.Add("GBP");
        if (sym.Contains("JPY")) result.Add("JPY");
        if (sym.Contains("CHF")) result.Add("CHF");
        if (sym.Contains("CAD")) result.Add("CAD");
        if (sym.Contains("AUD")) result.Add("AUD");
        if (sym.Contains("NZD")) result.Add("NZD");
        if (sym.Contains("XAU") || sym.Contains("GOLD")) result.Add("USD");
        return result;
    }

    private static string ComputeNewsBias(List<NewsEvent> events)
    {
        if (!events.Any()) return "Neutral";
        if (events.Any(e => e.Impact == "High")) return "HighImpact";
        if (events.Any(e => e.Impact == "Medium")) return "MediumRisk";
        return "LowRisk";
    }
}

public sealed class NewsContext
{
    public bool BlockNewEntries    { get; set; }
    public bool ShouldBlock => BlockNewEntries;
    public string NewsBias         { get; set; } = "Neutral";
    public string Bias => NewsBias;
    public string VolatilityExpected { get; set; } = "Normal";
    public bool SpikeRisk          { get; set; }
    public string CooldownState    { get; set; } = "CLEAR";
    public NewsEvent? NextHighImpact { get; set; }
    public List<NewsEvent> ActiveEvents { get; set; } = new();

    public int HighestImpact {
        get {
            if (ActiveEvents.Any(e => e.Impact == "High")) return 3;
            if (ActiveEvents.Any(e => e.Impact == "Medium")) return 2;
            if (ActiveEvents.Any(e => e.Impact == "Low")) return 1;
            return 0;
        }
    }

    public int MinutesToNextHigh {
        get {
            if (NextHighImpact == null) return 9999;
            return (int)(NextHighImpact.Time - DateTime.UtcNow).TotalMinutes;
        }
    }
}
