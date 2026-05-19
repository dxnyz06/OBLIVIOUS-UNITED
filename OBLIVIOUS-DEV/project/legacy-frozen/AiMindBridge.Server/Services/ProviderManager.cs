using Microsoft.Extensions.Logging;
using AiMindBridge.Server.Models;
using AiMindBridge.Server.Providers;

namespace AiMindBridge.Server.Services;

public class ProviderManager
{
    private readonly IEnumerable<IProviderAdapter> _providers;
    private readonly ILogger<ProviderManager> _logger;
    private List<IProviderAdapter> _healthyProviders = new();

    public ProviderManager(IEnumerable<IProviderAdapter> providers, ILogger<ProviderManager> logger)
    {
        _providers = providers;
        _logger = logger;
    }

    public async Task<bool> InitializeAsync()
    {
        _logger.LogInformation("Initializing AI providers...");
        
        var initTasks = _providers.Select(async provider =>
        {
            try
            {
                var success = await provider.InitializeAsync();
                if (success)
                {
                    _healthyProviders.Add(provider);
                    _logger.LogInformation($"Provider {provider.ProviderName} initialized successfully");
                }
                else
                {
                    _logger.LogWarning($"Provider {provider.ProviderName} failed to initialize");
                }
                return success;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, $"Error initializing provider {provider.ProviderName}");
                return false;
            }
        });

        await Task.WhenAll(initTasks);

        // Sort by priority
        _healthyProviders = _healthyProviders
            .OrderBy(p => p.Priority)
            .ToList();

        _logger.LogInformation($"Initialized {_healthyProviders.Count}/{_providers.Count()} providers");
        return _healthyProviders.Any();
    }

    public async Task<TradingResponse> ProcessRequestAsync(TradingRequest request)
    {
        if (!_healthyProviders.Any())
        {
            return new TradingResponse
            {
                Success = false,
                ErrorMessage = "No healthy AI providers available"
            };
        }

        // Try providers in priority order
        foreach (var provider in _healthyProviders)
        {
            try
            {
                _logger.LogDebug($"Trying provider {provider.ProviderName}");
                
                var response = await provider.ProcessRequestAsync(request);
                
                if (response.Success)
                {
                    _logger.LogInformation($"Request processed successfully by {provider.ProviderName}");
                    return response;
                }
                
                _logger.LogWarning($"Provider {provider.ProviderName} returned unsuccessful response: {response.ErrorMessage}");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, $"Error processing request with provider {provider.ProviderName}");
            }
        }

        return new TradingResponse
        {
            Success = false,
            ErrorMessage = "All AI providers failed to process the request"
        };
    }

    public async Task<bool> PerformHealthCheckAsync()
    {
        var healthTasks = _healthyProviders.Select(async provider =>
        {
            try
            {
                return await provider.TestConnectionAsync();
            }
            catch
            {
                return false;
            }
        });

        var results = await Task.WhenAll(healthTasks);
        
        // Remove unhealthy providers
        for (int i = _healthyProviders.Count - 1; i >= 0; i--)
        {
            if (!results[i])
            {
                _logger.LogWarning($"Provider {_healthyProviders[i].ProviderName} failed health check");
                _healthyProviders.RemoveAt(i);
            }
        }

        return _healthyProviders.Any();
    }

    public int HealthyProviderCount => _healthyProviders.Count;
    
    public IEnumerable<string> GetHealthyProviderNames() => 
        _healthyProviders.Select(p => p.ProviderName);
}