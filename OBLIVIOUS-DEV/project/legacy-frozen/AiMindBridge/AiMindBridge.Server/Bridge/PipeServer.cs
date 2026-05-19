using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using AiMindBridge.Config;
using AiMindBridge.Models;
using AiMindBridge.Providers;
using Microsoft.Extensions.Logging;

namespace AiMindBridge.Bridge;

/// <summary>
/// Named-pipe server that listens for incoming BridgeRequest messages from the MT4 EA
/// and replies with BridgeResponse messages.
///
/// Protocol: newline-delimited UTF-8 JSON.
///   Request:  single JSON line terminated with '\n'
///   Response: single JSON line terminated with '\n'
///
/// Pipe name: \\.\pipe\OBLIVIOUS_AIPC
/// </summary>
public sealed class PipeServer
{
    private readonly BridgeConfig        _config;
    private readonly ProviderRouter      _router;
    private readonly ILogger<PipeServer> _logger;
    private readonly NewsIngestionEngine? _newsEngine;
    private readonly AiCache?             _cache;
    private readonly ConsoleDashboard?    _dashboard;
    private readonly BookmapAdapter?      _bookmap;

    private const int MaxRequestBytes = 65536;

    public PipeServer(BridgeConfig config, ProviderRouter router, ILogger<PipeServer> logger,
                      NewsIngestionEngine? newsEngine = null, AiCache? cache = null,
                      ConsoleDashboard? dashboard = null, BookmapAdapter? bookmap = null)
    {
        _config     = config;
        _router     = router;
        _logger     = logger;
        _newsEngine = newsEngine;
        _cache      = cache;
        _dashboard  = dashboard;
        _bookmap    = bookmap;
    }

    /// <summary>Start listening on multiple concurrent pipe instances.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        var pipeName = ExtractPipeName(_config.PipeName);
        _logger.LogInformation("[PipeServer] Starting on pipe: \\\\.\\pipe\\{Name} ({N} concurrent)",
            pipeName, _config.MaxConcurrentPipes);

        var tasks = Enumerable.Range(0, _config.MaxConcurrentPipes)
            .Select(_ => ListenerLoopAsync(pipeName, ct));
        await Task.WhenAll(tasks);
    }

    private async Task ListenerLoopAsync(string pipeName, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            NamedPipeServerStream? pipe = null;
            try
            {
                pipe = new NamedPipeServerStream(
                    pipeName,
                    PipeDirection.InOut,
                    NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous,
                    inBufferSize:  4096,
                    outBufferSize: 4096);

                await pipe.WaitForConnectionAsync(ct);
                _logger.LogDebug("[PipeServer] EA connected.");

                string? requestJson = await ReadLineAsync(pipe, ct);
                if (string.IsNullOrWhiteSpace(requestJson))
                {
                    _logger.LogWarning("[PipeServer] Empty request received.");
                    continue;
                }

                BridgeRequest? request = null;
                try
                {
                    request = JsonSerializer.Deserialize<BridgeRequest>(requestJson,
                        new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                }
                catch (Exception ex)
                {
                    _logger.LogWarning("[PipeServer] Failed to deserialize request: {Msg}", ex.Message);
                }

                BridgeResponse response;
                if (request == null)
                {
                    response = new BridgeResponse { Success = false, Error = "Invalid JSON request" };
                }
                else
                {
                    _logger.LogInformation("[PipeServer] Request: {Symbol} {Strategy} dir={Dir}",
                        request.Symbol, request.StrategyName, request.Direction);
                    _dashboard?.SetEaConnected(true);
                    _dashboard?.IncrementRequests();

                    if (request.StrategyName == "NEWS_QUERY")
                    {
                        response = HandleNewsQuery(request);
                    }
                    else
                    {
                        EnrichRequest(request);

                        var cached = _cache?.TryGet(request);
                        if (cached != null)
                        {
                            response = cached;
                            response.Notes = "cached";
                        }
                        else
                        {
                            response = await _router.RouteAsync(request, ct);
                            _cache?.Store(request, response);
                        }

                        EnrichResponse(response);
                    }
                }

                var responseBytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(response) + "\n");
                await pipe.WriteAsync(responseBytes, ct);
                await pipe.FlushAsync(ct);

                _logger.LogInformation("[PipeServer] Response sent: provider={P} success={S} sl={SL} tp1={TP1}",
                    response.ProviderUsed ?? "none", response.Success, response.SLInitial, response.TP1);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                _logger.LogError(ex, "[PipeServer] Unexpected error in listener loop.");
                await Task.Delay(500, ct);
            }
            finally
            {
                try { if (pipe?.IsConnected == true) pipe.Disconnect(); } catch { }
                pipe?.Dispose();
            }
        }
    }

    private BridgeResponse HandleNewsQuery(BridgeRequest request)
    {
        var resp = new BridgeResponse { Success = true };
        if (_newsEngine == null)
        {
            resp.NewsImpactLevel = 0;
            resp.MinutesToEvent = 9999;
            resp.NewsBlockNewEntries = false;
            return resp;
        }

        var ctx = _newsEngine.GetContext();
        resp.NewsImpactLevel = ctx.HighestImpact;
        resp.MinutesToEvent = ctx.MinutesToNextHigh;
        resp.NewsBlockNewEntries = ctx.ShouldBlock;
        resp.NewsBias = ctx.Bias;
        return resp;
    }

    private void EnrichRequest(BridgeRequest request)
    {
        if (_newsEngine != null)
        {
            var ctx = _newsEngine.GetContext();
            request.NewsContext = $"impact={ctx.HighestImpact};min={ctx.MinutesToNextHigh};bias={ctx.Bias}";
        }
        if (_bookmap != null && _bookmap.IsConnected)
        {
            var of = _bookmap.Latest;
            request.OrderflowBias = of.Bias;
            request.OrderflowConfidence = of.Confidence;
        }
    }

    private void EnrichResponse(BridgeResponse response)
    {
        if (_newsEngine != null)
        {
            var ctx = _newsEngine.GetContext();
            response.NewsImpactLevel = ctx.HighestImpact;
            response.MinutesToEvent = ctx.MinutesToNextHigh;
            response.NewsBlockNewEntries = ctx.ShouldBlock;
            response.NewsBias = ctx.Bias;
        }
        if (_bookmap != null && _bookmap.IsConnected)
        {
            response.OrderflowBias = _bookmap.Latest.Bias;
        }
    }

    /// <summary>
    /// Read bytes from the pipe until a newline or MaxRequestBytes is reached.
    /// Uses raw async reads to avoid StreamReader + async-pipe compatibility issues.
    /// </summary>
    private static async Task<string?> ReadLineAsync(NamedPipeServerStream pipe, CancellationToken ct)
    {
        var buffer   = new byte[MaxRequestBytes];
        int total    = 0;

        while (total < MaxRequestBytes)
        {
            int read = await pipe.ReadAsync(buffer.AsMemory(total, 1), ct);
            if (read == 0) break;            // EOF / disconnected

            if (buffer[total] == (byte)'\n') // newline = end of request
                break;

            total++;
        }

        if (total == 0) return null;

        // Strip optional trailing CR
        int len = (total > 0 && buffer[total - 1] == (byte)'\r') ? total - 1 : total;
        return Encoding.UTF8.GetString(buffer, 0, len);
    }

    /// <summary>
    /// Extract just the pipe name from a full UNC path like \\.\pipe\OBLIVIOUS_AIPC.
    /// NamedPipeServerStream only needs the bare name (e.g. "OBLIVIOUS_AIPC").
    /// </summary>
    private static string ExtractPipeName(string fullName)
    {
        // Handle both \\.\pipe\NAME and bare NAME
        const string prefix = @"\\.\pipe\";
        if (fullName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            return fullName[prefix.Length..];
        if (fullName.StartsWith(@"\\.\pipe/", StringComparison.OrdinalIgnoreCase))
            return fullName[@"\\.\pipe/".Length..];
        // Fallback: strip all leading backslashes, dots, and "pipe\"
        return fullName
            .TrimStart('\\')
            .TrimStart('.')
            .TrimStart('\\')
            .TrimStart("pipe\\".ToCharArray());
    }
}
