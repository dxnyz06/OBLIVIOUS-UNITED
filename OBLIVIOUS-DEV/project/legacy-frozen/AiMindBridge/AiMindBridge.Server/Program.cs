using AiMindBridge.Bridge;
using AiMindBridge.Config;
using AiMindBridge.Providers;
using AiMindBridge.Security;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

// ============================================================
// AiMindBridge.Server — AI TP/SL computation bridge for MT4
// ============================================================
// Architecture:
//   EA (MQ4) → DLL (pipe I/O) → EXE Bridge → AI Providers
//   + News CSV ingestion + Bookmap orderflow + Console Dashboard
//
// API keys: loaded from KeyVault (encrypted) or environment variables.
// ============================================================

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

// Configuration
var configBuilder = new ConfigurationBuilder()
    .SetBasePath(AppContext.BaseDirectory)
    .AddJsonFile("appsettings.json", optional: false, reloadOnChange: true)
    .AddEnvironmentVariables();
var configuration = configBuilder.Build();

var bridgeConfig = new BridgeConfig();
configuration.GetSection("Bridge").Bind(bridgeConfig);

// Logging
using var loggerFactory = LoggerFactory.Create(builder =>
{
    builder
        .SetMinimumLevel(Enum.Parse<LogLevel>(bridgeConfig.LogLevel, ignoreCase: true))
        .AddConsole();
});

var logger = loggerFactory.CreateLogger("AiMindBridge");
logger.LogInformation("=== AiMindBridge v2.0.0 starting ===");
logger.LogInformation("Pipe: {Pipe}", bridgeConfig.PipeName);
logger.LogInformation("Provider priority: {Chain}", string.Join(" → ", bridgeConfig.ProviderPriority));

// KeyVault
var vault = new KeyVault(loggerFactory.CreateLogger<KeyVault>());
vault.Initialize();

// Build provider list (all 7 providers)
var providers = new List<IProviderAdapter>
{
    new OpenAIAdapter(     bridgeConfig.OpenAI,     loggerFactory.CreateLogger<OpenAIAdapter>()),
    new AnthropicAdapter(  bridgeConfig.Anthropic,  loggerFactory.CreateLogger<AnthropicAdapter>()),
    new GoogleAdapter(     bridgeConfig.Google,     loggerFactory.CreateLogger<GoogleAdapter>()),
    new XAIAdapter(        bridgeConfig.XAI,        loggerFactory.CreateLogger<XAIAdapter>()),
    new DeepSeekAdapter(   bridgeConfig.DeepSeek,   loggerFactory.CreateLogger<DeepSeekAdapter>()),
    new QwenAdapter(       bridgeConfig.Qwen,       loggerFactory.CreateLogger<QwenAdapter>()),
    new PerplexityAdapter( bridgeConfig.Perplexity, loggerFactory.CreateLogger<PerplexityAdapter>()),
};

var enabledProviders = providers.Where(p => p.IsEnabled).Select(p => p.Name).ToList();
logger.LogInformation("Enabled providers: {List}", string.Join(", ", enabledProviders.Any() ? enabledProviders : new[] { "(none)" }));

if (!enabledProviders.Any())
{
    logger.LogCritical("No AI providers are enabled. Set API key environment variables and check appsettings.json.");
    return 1;
}

// News Ingestion Engine
var newsEngine = new NewsIngestionEngine(loggerFactory.CreateLogger<NewsIngestionEngine>());
await newsEngine.UpdateAsync(cts.Token);

// Bookmap Adapter
var bookmap = new BookmapAdapter(loggerFactory.CreateLogger<BookmapAdapter>(), bridgeConfig.BookmapWsUrl);
if (bridgeConfig.EnableBookmap)
    await bookmap.TryConnectAsync(cts.Token);

// AI Cache
var cache = new AiCache(loggerFactory.CreateLogger<AiCache>()) { Mode = bridgeConfig.CacheMode };

// Router
var router = new ProviderRouter(providers, bridgeConfig, loggerFactory.CreateLogger<ProviderRouter>());

// Initial health check
logger.LogInformation("Running initial provider health checks...");
await router.RunHealthChecksAsync(cts.Token);

// Console Dashboard
var dashboard = new ConsoleDashboard(
    loggerFactory.CreateLogger<ConsoleDashboard>(),
    providers, newsEngine, bookmap, cache, vault);

// Pipe server (with news, cache, dashboard, bookmap wiring)
var pipeServer = new PipeServer(bridgeConfig, router, loggerFactory.CreateLogger<PipeServer>(),
                                newsEngine, cache, dashboard, bookmap);

// Background tasks
var healthTask = Task.Run(async () =>
{
    while (!cts.Token.IsCancellationRequested)
    {
        await Task.Delay(TimeSpan.FromMinutes(5), cts.Token);
        await router.RunHealthChecksAsync(cts.Token);
    }
}, cts.Token);

var newsTask = Task.Run(async () =>
{
    while (!cts.Token.IsCancellationRequested)
    {
        await Task.Delay(TimeSpan.FromMinutes(2), cts.Token);
        await newsEngine.UpdateAsync(cts.Token);
    }
}, cts.Token);

var dashboardTask = Task.Run(async () =>
{
    while (!cts.Token.IsCancellationRequested)
    {
        await Task.Delay(TimeSpan.FromSeconds(3), cts.Token);
        dashboard.Render();
    }
}, cts.Token);

// Main pipe server loop
try
{
    logger.LogInformation("AiMindBridge ready. Waiting for EA connections...");
    await pipeServer.RunAsync(cts.Token);
}
catch (OperationCanceledException)
{
    logger.LogInformation("AiMindBridge shutting down.");
}

await bookmap.DisconnectAsync();
return 0;
