using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using AiMindBridge.Server.Providers;
using AiMindBridge.Server.Services;

namespace AiMindBridge.Server;

public class Program
{
    public static async Task Main(string[] args)
    {
        Console.WriteLine("OBLIVIOUS AI Mind Bridge Server v1.0");
        Console.WriteLine("Multi-Provider AI Bridge for MT4 Trading System");
        Console.WriteLine("===============================================");

        var host = CreateHostBuilder(args).Build();

        // Initialize providers
        var providerManager = host.Services.GetRequiredService<ProviderManager>();
        await providerManager.InitializeAsync();

        // Start pipe server
        var pipeServer = host.Services.GetRequiredService<PipeServer>();
        var logger = host.Services.GetRequiredService<ILogger<Program>>();

        logger.LogInformation("Starting AI Bridge Server...");

        try
        {
            await pipeServer.StartAsync();
            logger.LogInformation("AI Bridge Server started successfully");

            // Keep running until cancelled
            var cancellationToken = new CancellationTokenSource();
            Console.CancelKeyPress += (_, e) =>
            {
                e.Cancel = true;
                cancellationToken.Cancel();
                logger.LogInformation("Shutdown requested");
            };

            await Task.Delay(-1, cancellationToken.Token);
        }
        catch (OperationCanceledException)
        {
            logger.LogInformation("Server shutdown completed");
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Server error occurred");
        }
        finally
        {
            await pipeServer.StopAsync();
            logger.LogInformation("AI Bridge Server stopped");
        }
    }

    public static IHostBuilder CreateHostBuilder(string[] args) =>
        Host.CreateDefaultBuilder(args)
            .ConfigureAppConfiguration((context, config) =>
            {
                config.AddJsonFile("appsettings.json", optional: false, reloadOnChange: true);
                config.AddEnvironmentVariables();
            })
            .ConfigureServices((context, services) =>
            {
                var configuration = context.Configuration;

                // Register logging
                services.AddLogging(builder =>
                {
                    builder.AddConsole();
                    builder.SetMinimumLevel(LogLevel.Information);
                });

                // Register AI provider adapters
                services.AddSingleton<IProviderAdapter, OpenAiAdapter>();
                services.AddSingleton<IProviderAdapter, ClaudeAdapter>();

                // Register core services
                services.AddSingleton<ProviderManager>();
                services.AddSingleton<PipeServer>();

                // Pass configuration to services
                services.AddSingleton(configuration);
            });
}