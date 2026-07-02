using System.Text.Json;
using System.Text.Json.Serialization;
using PDM.Core.Models;

namespace PDM.Core.Persistence;

/// <summary>
/// Loads and persists <see cref="AppSettings"/> as JSON on disk, atomically. Concurrent
/// callers see a consistent snapshot; a save always fully replaces the file so partial
/// writes cannot corrupt the settings.
/// </summary>
public sealed class JsonSettingsStore
{
    private static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter() }
    };

    private readonly string _path;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public JsonSettingsStore(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        _path = path;
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
    }

    /// <summary>Loads settings from disk, returning defaults when no file exists or when it is invalid.</summary>
    public async Task<AppSettings> LoadAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!File.Exists(_path))
            {
                return new AppSettings();
            }

            await using var stream = new FileStream(
                _path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, useAsync: true);
            try
            {
                return await JsonSerializer.DeserializeAsync<AppSettings>(stream, Options, cancellationToken)
                       .ConfigureAwait(false) ?? new AppSettings();
            }
            catch (JsonException)
            {
                // Corrupt settings should not brick the app; fall back to defaults.
                return new AppSettings();
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Persists the given settings, replacing any previous file atomically.</summary>
    public async Task SaveAsync(AppSettings settings, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(settings);

        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            string tempPath = _path + ".tmp";
            await using (var stream = new FileStream(
                tempPath, FileMode.Create, FileAccess.Write, FileShare.None, 4096, useAsync: true))
            {
                await JsonSerializer.SerializeAsync(stream, settings, Options, cancellationToken)
                    .ConfigureAwait(false);
                await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
            }

            if (File.Exists(_path))
            {
                File.Replace(tempPath, _path, destinationBackupFileName: null);
            }
            else
            {
                File.Move(tempPath, _path);
            }
        }
        finally
        {
            _gate.Release();
        }
    }
}
