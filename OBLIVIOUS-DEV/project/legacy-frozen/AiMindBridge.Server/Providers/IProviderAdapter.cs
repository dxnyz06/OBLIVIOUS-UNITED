using AiMindBridge.Server.Models;

namespace AiMindBridge.Server.Providers;

public interface IProviderAdapter
{
    string ProviderName { get; }
    bool IsHealthy { get; }
    int Priority { get; }
    
    Task<bool> InitializeAsync();
    Task<TradingResponse> ProcessRequestAsync(TradingRequest request);
    Task<bool> TestConnectionAsync();
}