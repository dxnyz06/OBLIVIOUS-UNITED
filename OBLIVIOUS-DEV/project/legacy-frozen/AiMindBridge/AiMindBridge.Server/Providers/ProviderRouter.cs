using AiMindBridge.Config;
using AiMindBridge.Models;
using Microsoft.Extensions.Logging;

namespace AiMindBridge.Providers;

/// <summary>
/// Routes requests through providers in priority order.
/// Implements fallback chain with per-provider timeout and retry.
/// </summary>
public sealed class ProviderRouter
{
    private readonly List<IProviderAdapter> _providers;
    private readonly BridgeConfig           _config;
    private readonly ILogger<ProviderRouter> _logger;

    public ProviderRouter(List<IProviderAdapter> providers, BridgeConfig config, ILogger<ProviderRouter> logger)
    {
        _providers = providers;
        _config    = config;
        _logger    = logger;
    }

    /// <summary>
    /// Try each enabled, healthy provider in priority order.
    /// Returns the first successful response or a failure response if all providers fail.
    /// </summary>
    public async Task<BridgeResponse> RouteAsync(BridgeRequest request, CancellationToken ct)
    {
        // Sort providers by configured priority
        var ordered = _config.ProviderPriority
            .Select(name => _providers.FirstOrDefault(p =>
                string.Equals(p.Name, name, StringComparison.OrdinalIgnoreCase)))
            .Where(p => p != null && p.IsEnabled && p.IsHealthy)
            .Cast<IProviderAdapter>()
            .ToList();

        if (ordered.Count == 0)
        {
            _logger.LogError("No AI providers are enabled or healthy.");
            return new BridgeResponse { Success = false, Error = "No providers available" };
        }

        foreach (var provider in ordered)
        {
            for (int attempt = 0; attempt <= _config.ProviderRetryLimit; attempt++)
            {
                using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeoutCts.CancelAfter(_config.ProviderTimeoutMs);
                try
                {
                    _logger.LogInformation("[Router] Trying {Provider} (attempt {N})", provider.Name, attempt + 1);
                    var response = await provider.QueryAsync(request, timeoutCts.Token);
                    if (response.Success)
                    {
                        _logger.LogInformation("[Router] Success via {Provider} (confidence={C}%)",
                            provider.Name, response.Confidence);
                        return response;
                    }
                    _logger.LogWarning("[Router] {Provider} returned failure: {Err}", provider.Name, response.Error);
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    _logger.LogWarning("[Router] {Provider} timed out after {Ms}ms", provider.Name, _config.ProviderTimeoutMs);
                    break; // try next provider on timeout
                }
                catch (Exception ex)
                {
                    _logger.LogWarning("[Router] {Provider} exception: {Msg}", provider.Name, ex.Message);
                    if (attempt < _config.ProviderRetryLimit)
                        await Task.Delay(200, ct); // brief delay before retry
                }
            }
        }

        _logger.LogError("[Router] All providers failed for {Symbol} {Strategy}", request.Symbol, request.StrategyName);
        return new BridgeResponse { Success = false, Error = "All AI providers failed" };
    }

    /// <summary>Run health checks on all providers and update their status.</summary>
    public async Task RunHealthChecksAsync(CancellationToken ct)
    {
        var tasks = _providers
            .Where(p => p.IsEnabled)
            .Select(async p =>
            {
                var ok = await p.HealthCheckAsync(ct);
                _logger.LogInformation("[Health] {Provider}: {Status}", p.Name, ok ? "OK" : "DEGRADED");
            });
        await Task.WhenAll(tasks);
    }
}
