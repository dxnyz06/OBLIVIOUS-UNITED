using AiMindBridge.Models;

namespace AiMindBridge.Providers;

/// <summary>
/// Contract that every AI provider adapter must implement.
/// Each adapter is responsible for:
/// - Reading its API key from environment variables (never hardcoded)
/// - Building the request prompt from BridgeRequest context
/// - Calling the provider API with timeout and retry
/// - Parsing the response into a normalized BridgeResponse
/// </summary>
public interface IProviderAdapter
{
    string Name { get; }
    bool IsEnabled { get; }
    bool IsHealthy { get; }

    Task<BridgeResponse> QueryAsync(BridgeRequest request, CancellationToken ct);
    Task<bool> HealthCheckAsync(CancellationToken ct);
}
