using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace AiMindBridge.Security;

public sealed class KeyVault
{
    private readonly ILogger<KeyVault> _logger;
    private readonly string _filePath;
    private Dictionary<string, string> _keys = new(StringComparer.OrdinalIgnoreCase);
    private byte[]? _masterKey;

    public KeyVault(ILogger<KeyVault> logger, string? filePath = null)
    {
        _logger = logger;
        _filePath = filePath ?? Path.Combine(AppContext.BaseDirectory, "keys.vault");
    }

    public void Initialize(string? masterPassword = null)
    {
        if (masterPassword != null)
        {
            _masterKey = DeriveKey(masterPassword);
        }
        else
        {
            var envKey = Environment.GetEnvironmentVariable("OBLIVIOUS_VAULT_KEY");
            _masterKey = envKey != null ? DeriveKey(envKey) : DeriveKey("ObliviousDefault2024");
        }

        if (File.Exists(_filePath))
        {
            try
            {
                Load();
                _logger.LogInformation("[KeyVault] Loaded {Count} keys from vault", _keys.Count);
            }
            catch (Exception ex)
            {
                _logger.LogWarning("[KeyVault] Failed to load vault: {Msg}", ex.Message);
                _keys = new();
            }
        }
    }

    private static byte[] DeriveKey(string password)
    {
        using var sha = SHA256.Create();
        return sha.ComputeHash(Encoding.UTF8.GetBytes(password));
    }

    public string? GetKey(string providerName)
    {
        // Priority: vault -> environment variable
        if (_keys.TryGetValue(providerName, out var vaultKey) && !string.IsNullOrEmpty(vaultKey))
            return vaultKey;

        var envVarName = $"{providerName.ToUpperInvariant()}_API_KEY";
        return Environment.GetEnvironmentVariable(envVarName);
    }

    public void SetKey(string providerName, string apiKey)
    {
        _keys[providerName] = apiKey;
        Save();
        _logger.LogInformation("[KeyVault] Key for {Provider} updated", providerName);
    }

    public void RemoveKey(string providerName)
    {
        _keys.Remove(providerName);
        Save();
    }

    public IReadOnlyDictionary<string, bool> GetKeyStatus()
    {
        var providers = new[] { "openai", "anthropic", "google", "xai", "deepseek", "qwen", "perplexity" };
        var result = new Dictionary<string, bool>();
        foreach (var p in providers)
            result[p] = GetKey(p) != null;
        return result;
    }

    private void Save()
    {
        if (_masterKey == null) return;

        var json = JsonSerializer.Serialize(_keys);
        var plain = Encoding.UTF8.GetBytes(json);

        using var aes = Aes.Create();
        aes.Key = _masterKey;
        aes.GenerateIV();

        using var encryptor = aes.CreateEncryptor();
        var cipher = encryptor.TransformFinalBlock(plain, 0, plain.Length);

        // Format: [IV_LEN:1][IV][TAG_PLACEHOLDER:16][CIPHER]
        using var fs = File.Create(_filePath);
        fs.WriteByte((byte)aes.IV.Length);
        fs.Write(aes.IV);
        var tag = new byte[16]; // placeholder for HMAC
        using (var hmac = new HMACSHA256(_masterKey))
        {
            var hmacInput = aes.IV.Concat(cipher).ToArray();
            tag = hmac.ComputeHash(hmacInput)[..16];
        }
        fs.Write(tag);
        fs.Write(cipher);
    }

    private void Load()
    {
        if (_masterKey == null) return;

        var data = File.ReadAllBytes(_filePath);
        if (data.Length < 18) throw new InvalidDataException("Vault file too small");

        int ivLen = data[0];
        var iv = data[1..(1 + ivLen)];
        var tag = data[(1 + ivLen)..(1 + ivLen + 16)];
        var cipher = data[(1 + ivLen + 16)..];

        // Verify HMAC
        using (var hmac = new HMACSHA256(_masterKey))
        {
            var hmacInput = iv.Concat(cipher).ToArray();
            var expectedTag = hmac.ComputeHash(hmacInput)[..16];
            if (!tag.SequenceEqual(expectedTag))
                throw new CryptographicException("Vault integrity check failed");
        }

        using var aes = Aes.Create();
        aes.Key = _masterKey;
        aes.IV = iv;
        using var decryptor = aes.CreateDecryptor();
        var plain = decryptor.TransformFinalBlock(cipher, 0, cipher.Length);
        var json = Encoding.UTF8.GetString(plain);

        _keys = JsonSerializer.Deserialize<Dictionary<string, string>>(json) ?? new();
    }
}
