using AiMindBridge.Bridge;
using AiMindBridge.Providers;
using AiMindBridge.Security;
using Microsoft.Extensions.Logging;

namespace AiMindBridge.Bridge;

public sealed class ConsoleDashboard
{
    private readonly ILogger<ConsoleDashboard> _logger;
    private readonly List<IProviderAdapter> _providers;
    private readonly NewsIngestionEngine _news;
    private readonly BookmapAdapter _bookmap;
    private readonly AiCache _cache;
    private readonly KeyVault _vault;
    private bool _eaConnected;
    private int _requestCount;
    private readonly List<string> _decisionTrace = new();
    private const int MaxTraceLines = 10;

    public ConsoleDashboard(
        ILogger<ConsoleDashboard> logger,
        List<IProviderAdapter> providers,
        NewsIngestionEngine news,
        BookmapAdapter bookmap,
        AiCache cache,
        KeyVault vault)
    {
        _logger    = logger;
        _providers = providers;
        _news      = news;
        _bookmap   = bookmap;
        _cache     = cache;
        _vault     = vault;
    }

    public void SetEaConnected(bool connected) => _eaConnected = connected;
    public void IncrementRequests() => _requestCount++;

    public void AddDecisionTrace(string line)
    {
        _decisionTrace.Add($"[{DateTime.Now:HH:mm:ss}] {line}");
        if (_decisionTrace.Count > MaxTraceLines)
            _decisionTrace.RemoveAt(0);
    }

    public void Render()
    {
        try
        {
            Console.Clear();
            var w = Math.Max(Console.WindowWidth, 80);
            var sep = new string('─', w);

            WriteHeader(w);
            Console.WriteLine(sep);
            WritePanel1_SystemStatus();
            Console.WriteLine(sep);
            WritePanel2_Providers();
            Console.WriteLine(sep);
            WritePanel3_News();
            Console.WriteLine(sep);
            WritePanel4_Strategies();
            Console.WriteLine(sep);
            WritePanel5_Orderflow();
            Console.WriteLine(sep);
            WritePanel6_AiActivity();
            Console.WriteLine(sep);
            WritePanel7_DecisionTrace();
            Console.WriteLine(sep);
            WriteFooter();
        }
        catch
        {
            // Silently ignore console rendering errors during resize
        }
    }

    private void WriteHeader(int w)
    {
        var title = "OBLIVIOUS AI BRIDGE — CONSOLE DASHBOARD";
        var pad = Math.Max(0, (w - title.Length) / 2);
        Console.ForegroundColor = ConsoleColor.Cyan;
        Console.WriteLine(new string(' ', pad) + title);
        Console.ResetColor();
        Console.WriteLine($"  {DateTime.Now:yyyy-MM-dd HH:mm:ss UTC}    Uptime: running    Requests: {_requestCount}");
    }

    private void WritePanel1_SystemStatus()
    {
        WriteSectionTitle("1. SYSTEM STATUS");
        WriteStatusLine("EA Connection",      _eaConnected,      _eaConnected ? "Connected" : "Waiting...");
        WriteStatusLine("DLL Pipe",            true,              "Active (OBLIVIOUS_AIPC)");
        WriteStatusLine("Bookmap",             _bookmap.IsConnected, _bookmap.IsConnected ? "Connected" : "Offline");
        WriteStatusLine("News Engine",         _news.Events.Count > 0, $"{_news.Events.Count} events loaded");
    }

    private void WritePanel2_Providers()
    {
        WriteSectionTitle("2. AI PROVIDERS");
        foreach (var p in _providers)
        {
            var status = !p.IsEnabled ? "DISABLED" : (p.IsHealthy ? "HEALTHY" : "UNHEALTHY");
            var color = !p.IsEnabled ? ConsoleColor.DarkGray : (p.IsHealthy ? ConsoleColor.Green : ConsoleColor.Red);
            Console.Write($"  {p.Name,-15}");
            Console.ForegroundColor = color;
            Console.Write($"{status,-12}");
            Console.ResetColor();
            Console.WriteLine();
        }
    }

    private void WritePanel3_News()
    {
        WriteSectionTitle("3. NEWS");
        var ctx = _news.GetContext("XAUUSD", DateTime.UtcNow);

        if (ctx.NextHighImpact != null)
        {
            var mins = (int)(ctx.NextHighImpact.Time - DateTime.UtcNow).TotalMinutes;
            Console.ForegroundColor = mins < 15 ? ConsoleColor.Red : ConsoleColor.Yellow;
            Console.WriteLine($"  Next High Impact: {ctx.NextHighImpact.Title} ({ctx.NextHighImpact.Currency}) in {mins} min");
            Console.ResetColor();
        }
        else
        {
            Console.WriteLine("  No upcoming high-impact news");
        }

        Console.WriteLine($"  Block Active: {(ctx.BlockNewEntries ? "YES" : "NO")}    Bias: {ctx.NewsBias}");

        if (ctx.ActiveEvents.Count > 0)
        {
            Console.WriteLine($"  Active Events: {ctx.ActiveEvents.Count}");
            foreach (var ev in ctx.ActiveEvents.Take(3))
                Console.WriteLine($"    - [{ev.Impact}] {ev.Title} ({ev.Currency})");
        }
    }

    private void WritePanel4_Strategies()
    {
        WriteSectionTitle("4. STRATEGIES");
        var strats = new[] { "Predicted", "Grid", "Breakout", "FVG", "InstitutionalSMC_ICT", "Reverse" };
        foreach (var s in strats)
        {
            Console.WriteLine($"  {s,-25} Active");
        }
    }

    private void WritePanel5_Orderflow()
    {
        WriteSectionTitle("5. ORDERFLOW (Bookmap)");
        if (!_bookmap.IsConnected)
        {
            Console.ForegroundColor = ConsoleColor.DarkGray;
            Console.WriteLine("  Bookmap not connected. Orderflow data unavailable.");
            Console.ResetColor();
            return;
        }

        var of = _bookmap.Latest;
        Console.WriteLine($"  Bias: {of.Bias,-10}  Confidence: {of.Confidence:F0}%");
        Console.WriteLine($"  Delta: {of.DeltaShift:+0.0;-0.0}    Absorption: {of.Absorption:F0}    Exhaustion: {of.Exhaustion:F0}");
        Console.WriteLine($"  DOM Pressure: {of.DomPressure:F0}    Imbalance: {of.Imbalance:F2}");
        Console.WriteLine($"  Last Update: {of.LastUpdate:HH:mm:ss}    Stale: {of.IsStale}");
    }

    private void WritePanel6_AiActivity()
    {
        WriteSectionTitle("6. AI ACTIVITY");
        var (hits, misses, saved, size) = _cache.GetStats();
        var total = hits + misses;
        var hitRate = total > 0 ? (double)hits / total * 100.0 : 0;
        Console.WriteLine($"  Cache: {size} entries    Hit Rate: {hitRate:F1}%    ({hits} hits / {misses} misses)");
        Console.WriteLine($"  Tokens Saved: ~{saved:N0}    Mode: {_cache.Mode}");
    }

    private void WritePanel7_DecisionTrace()
    {
        WriteSectionTitle("7. DECISION TRACE");
        if (_decisionTrace.Count == 0)
        {
            Console.ForegroundColor = ConsoleColor.DarkGray;
            Console.WriteLine("  No decisions yet.");
            Console.ResetColor();
            return;
        }

        foreach (var line in _decisionTrace.TakeLast(7))
            Console.WriteLine($"  {line}");
    }

    private void WriteFooter()
    {
        Console.ForegroundColor = ConsoleColor.DarkGray;
        Console.WriteLine("  Press Ctrl+C to exit. Dashboard refreshes every 3 seconds.");
        Console.ResetColor();
    }

    private static void WriteSectionTitle(string title)
    {
        Console.ForegroundColor = ConsoleColor.Yellow;
        Console.WriteLine($"  [{title}]");
        Console.ResetColor();
    }

    private static void WriteStatusLine(string label, bool ok, string detail)
    {
        Console.Write($"  {label,-20}");
        Console.ForegroundColor = ok ? ConsoleColor.Green : ConsoleColor.Red;
        Console.Write(ok ? "●" : "○");
        Console.ResetColor();
        Console.WriteLine($" {detail}");
    }
}
