using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using AiMindBridge.Models;
using Microsoft.Extensions.Logging;

namespace AiMindBridge.Bridge;

public sealed class CacheEntry
{
    public BridgeResponse Response { get; set; } = new();
    public DateTime CachedAt       { get; set; }
    public int TokensSaved         { get; set; }
}

public sealed class AiCache
{
    private readonly ILogger<AiCache> _logger;
    private readonly Dictionary<string, CacheEntry> _cache = new();

    // TTL by aggressiveness mode
    public TimeSpan ConservativeTtl { get; set; } = TimeSpan.FromSeconds(120);
    public TimeSpan ModerateTtl     { get; set; } = TimeSpan.FromSeconds(60);
    public TimeSpan AggressiveTtl   { get; set; } = TimeSpan.FromSeconds(30);

    public string Mode { get; set; } = "moderate"; // "conservative", "moderate", "aggressive"

    // Stats
    public int TotalHits   { get; private set; }
    public int TotalMisses { get; private set; }
    public int TotalTokensSaved { get; private set; }

    public AiCache(ILogger<AiCache> logger)
    {
        _logger = logger;
    }

    public BridgeResponse? TryGet(BridgeRequest req)
    {
        var key = ComputeKey(req);
        if (!_cache.TryGetValue(key, out var entry))
        {
            TotalMisses++;
            return null;
        }

        var ttl = GetCurrentTtl();
        if (DateTime.UtcNow - entry.CachedAt > ttl)
        {
            _cache.Remove(key);
            TotalMisses++;
            return null;
        }

        TotalHits++;
        TotalTokensSaved += entry.TokensSaved;
        _logger.LogDebug("[Cache] HIT for {Symbol}/{Strategy} (saved ~{Tokens} tokens)",
            req.Symbol, req.StrategyName, entry.TokensSaved);
        return entry.Response;
    }

    public void Store(BridgeRequest req, BridgeResponse resp, int estimatedTokens = 400)
    {
        var key = ComputeKey(req);
        _cache[key] = new CacheEntry
        {
            Response    = resp,
            CachedAt    = DateTime.UtcNow,
            TokensSaved = estimatedTokens
        };

        // Evict old entries
        var ttl = GetCurrentTtl() * 2;
        var expired = _cache.Where(kv => DateTime.UtcNow - kv.Value.CachedAt > ttl).Select(kv => kv.Key).ToList();
        foreach (var k in expired) _cache.Remove(k);
    }

    private TimeSpan GetCurrentTtl() => Mode.ToLowerInvariant() switch
    {
        "conservative" => ConservativeTtl,
        "aggressive"   => AggressiveTtl,
        _              => ModerateTtl
    };

    private static string ComputeKey(BridgeRequest req)
    {
        var raw = $"{req.Symbol}|{req.Timeframe}|{req.StrategyName}|{req.Direction}|{req.TPSLMode}|{Math.Round(req.SetupScore / 10.0)}";
        using var sha = SHA256.Create();
        var hash = sha.ComputeHash(Encoding.UTF8.GetBytes(raw));
        return Convert.ToHexString(hash[..12]);
    }

    public (int hits, int misses, int tokensSaved, int cacheSize) GetStats()
        => (TotalHits, TotalMisses, TotalTokensSaved, _cache.Count);
}
