using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json;
using System.IO.Pipes;
using System.Text;
using AiMindBridge.Server.Models;

namespace AiMindBridge.Server.Services;

public class PipeServer
{
    private readonly ProviderManager _providerManager;
    private readonly IConfiguration _configuration;
    private readonly ILogger<PipeServer> _logger;
    private NamedPipeServerStream? _pipeServer;
    private bool _isRunning;
    private readonly string _pipeName;

    public PipeServer(ProviderManager providerManager, IConfiguration configuration, ILogger<PipeServer> logger)
    {
        _providerManager = providerManager;
        _configuration = configuration;
        _logger = logger;
        _pipeName = configuration["Bridge:PipeName"] ?? "OBLIVIOUS_AI_BRIDGE";
    }

    public async Task StartAsync()
    {
        _isRunning = true;
        _logger.LogInformation($"Starting pipe server on: {_pipeName}");

        while (_isRunning)
        {
            try
            {
                _pipeServer = new NamedPipeServerStream(
                    _pipeName,
                    PipeDirection.InOut,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous);

                _logger.LogInformation("Waiting for client connection...");
                await _pipeServer.WaitForConnectionAsync();
                _logger.LogInformation("Client connected");

                await HandleClientAsync(_pipeServer);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error in pipe server");
            }
            finally
            {
                _pipeServer?.Dispose();
                _pipeServer = null;
            }

            if (_isRunning)
            {
                await Task.Delay(1000); // Brief delay before restarting
            }
        }
    }

    public Task StopAsync()
    {
        _isRunning = false;
        _pipeServer?.Dispose();
        _logger.LogInformation("Pipe server stopped");
        return Task.CompletedTask;
    }

    private async Task HandleClientAsync(NamedPipeServerStream pipe)
    {
        try
        {
            while (pipe.IsConnected && _isRunning)
            {
                // Read request
                var requestJson = await ReadMessageAsync(pipe);
                if (string.IsNullOrEmpty(requestJson))
                    break;

                _logger.LogDebug($"Received request: {requestJson}");

                // Process request
                var response = await ProcessRequestAsync(requestJson);

                // Send response
                await WriteMessageAsync(pipe, response);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error handling client");
        }
    }

    private async Task<string> ReadMessageAsync(NamedPipeServerStream pipe)
    {
        try
        {
            var buffer = new byte[4096];
            var totalBytes = 0;
            var message = new StringBuilder();

            while (true)
            {
                var bytesRead = await pipe.ReadAsync(buffer, 0, buffer.Length);
                if (bytesRead == 0)
                    break;

                var chunk = Encoding.UTF8.GetString(buffer, 0, bytesRead);
                message.Append(chunk);
                totalBytes += bytesRead;

                // Check for end of message (assuming null terminator or specific delimiter)
                if (chunk.Contains('\0') || totalBytes >= 4096)
                    break;
            }

            return message.ToString().TrimEnd('\0');
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error reading message");
            return string.Empty;
        }
    }

    private async Task WriteMessageAsync(NamedPipeServerStream pipe, string message)
    {
        try
        {
            var buffer = Encoding.UTF8.GetBytes(message + '\0');
            await pipe.WriteAsync(buffer, 0, buffer.Length);
            await pipe.FlushAsync();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error writing message");
        }
    }

    private async Task<string> ProcessRequestAsync(string requestJson)
    {
        try
        {
            var request = JsonConvert.DeserializeObject<TradingRequest>(requestJson);
            if (request == null)
            {
                return JsonConvert.SerializeObject(new TradingResponse
                {
                    Success = false,
                    ErrorMessage = "Invalid request format"
                });
            }

            var response = await _providerManager.ProcessRequestAsync(request);
            return JsonConvert.SerializeObject(response);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Error processing request");
            return JsonConvert.SerializeObject(new TradingResponse
            {
                Success = false,
                ErrorMessage = $"Processing error: {ex.Message}"
            });
        }
    }
}