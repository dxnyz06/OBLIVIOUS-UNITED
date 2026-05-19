using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace AiMindBridge.Bridge;

public sealed class OrderflowData
{
    public string Bias         { get; set; } = "Neutral"; // "Bullish", "Bearish", "Neutral"
    public double Confidence   { get; set; }  // 0-100
    public double Absorption   { get; set; }  // 0-100 (how much absorption detected)
    public double Exhaustion   { get; set; }  // 0-100
    public double DeltaShift   { get; set; }  // positive = buy pressure
    public double Imbalance    { get; set; }  // volume imbalance ratio
    public double DomPressure  { get; set; }  // -100 to +100 (bid vs ask depth)
    public DateTime LastUpdate { get; set; }
    public bool IsStale        { get; set; }
}

public sealed class BookmapAdapter
{
    private readonly ILogger<BookmapAdapter> _logger;
    private ClientWebSocket? _ws;
    private OrderflowData _latest = new();
    private bool _connected;
    private readonly string _wsUrl;
    private CancellationTokenSource? _readCts;

    public bool IsConnected => _connected && _ws?.State == WebSocketState.Open;
    public OrderflowData Latest => _latest;

    public BookmapAdapter(ILogger<BookmapAdapter> logger, string wsUrl = "ws://localhost:9090")
    {
        _logger = logger;
        _wsUrl = wsUrl;
    }

    public async Task<bool> TryConnectAsync(CancellationToken ct)
    {
        try
        {
            _ws = new ClientWebSocket();
            await _ws.ConnectAsync(new Uri(_wsUrl), ct);
            _connected = true;
            _logger.LogInformation("[Bookmap] Connected to {Url}", _wsUrl);

            _readCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            _ = Task.Run(() => ReadLoopAsync(_readCts.Token), _readCts.Token);

            return true;
        }
        catch (Exception ex)
        {
            _connected = false;
            _logger.LogWarning("[Bookmap] Connection failed: {Msg}. Orderflow will be unavailable.", ex.Message);
            return false;
        }
    }

    private async Task ReadLoopAsync(CancellationToken ct)
    {
        var buffer = new byte[8192];
        try
        {
            while (!ct.IsCancellationRequested && _ws?.State == WebSocketState.Open)
            {
                var result = await _ws.ReceiveAsync(buffer, ct);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    _connected = false;
                    _logger.LogInformation("[Bookmap] Server closed connection.");
                    break;
                }

                var msg = Encoding.UTF8.GetString(buffer, 0, result.Count);
                ParseMessage(msg);
            }
        }
        catch (OperationCanceledException) { }
        catch (Exception ex)
        {
            _logger.LogWarning("[Bookmap] Read error: {Msg}", ex.Message);
        }
        finally
        {
            _connected = false;
        }
    }

    private void ParseMessage(string msg)
    {
        try
        {
            using var doc = JsonDocument.Parse(msg);
            var root = doc.RootElement;

            double GetD(string key, double fb = 0) =>
                root.TryGetProperty(key, out var el) ? el.GetDouble() : fb;
            string GetS(string key, string fb = "") =>
                root.TryGetProperty(key, out var el) ? el.GetString() ?? fb : fb;

            _latest = new OrderflowData
            {
                Bias       = GetS("bias", "Neutral"),
                Confidence = GetD("confidence"),
                Absorption = GetD("absorption"),
                Exhaustion = GetD("exhaustion"),
                DeltaShift = GetD("delta_shift"),
                Imbalance  = GetD("imbalance"),
                DomPressure = GetD("dom_pressure"),
                LastUpdate = DateTime.UtcNow,
                IsStale    = false
            };
        }
        catch (Exception ex)
        {
            _logger.LogDebug("[Bookmap] Parse error: {Msg}", ex.Message);
        }
    }

    public void MarkStaleIfNeeded(TimeSpan maxAge)
    {
        if (DateTime.UtcNow - _latest.LastUpdate > maxAge)
            _latest.IsStale = true;
    }

    public async Task DisconnectAsync()
    {
        _readCts?.Cancel();
        if (_ws?.State == WebSocketState.Open)
        {
            try
            {
                await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "Shutdown", CancellationToken.None);
            }
            catch { }
        }
        _connected = false;
    }
}
