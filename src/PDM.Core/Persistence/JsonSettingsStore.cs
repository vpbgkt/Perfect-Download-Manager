using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using PDM.Core.Models;
using PDM.Core.Serialization;

namespace PDM.Core.Persistence;

/// <summary>
/// Loads and persists <see cref="AppSettings"/> as JSON on disk, atomically. Concurrent
/// callers see a consistent snapshot; a save always fully replaces the file so partial
/// writes cannot corrupt the settings.
/// </summary>
public sealed class JsonSettingsStore
{
    // Source-generated metadata (AOT/trim-safe) with settings-specific formatting layered on: the
    // file stays pretty-printed and is read case-insensitively. Null-omitting + string enums come
    // from the context. A JsonTypeInfo bound to these options is used at the call sites so the
    // AOT/trim-safe (JsonTypeInfo) serializer overloads are taken — never the reflection-based ones.
    private static readonly JsonSerializerOptions Options = new(PdmCoreJsonContext.Default.Options)
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true
    };

    private static readonly JsonTypeInfo<AppSettings> AppSettingsTypeInfo =
        (JsonTypeInfo<AppSettings>)Options.GetTypeInfo(typeof(AppSettings));

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

            AppSettings settings;
            await using (var stream = new FileStream(
                _path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, useAsync: true))
            {
                try
                {
                    settings = await JsonSerializer
                                   .DeserializeAsync(stream, AppSettingsTypeInfo, cancellationToken)
                                   .ConfigureAwait(false) ?? new AppSettings();
                }
                catch (JsonException)
                {
                    // Corrupt settings should not brick the app; fall back to defaults.
                    return new AppSettings();
                }
            }

            // Apply one-time migrations and persist them, so an existing install picks up improved
            // defaults instead of being stuck on the values written by an older version.
            if (Migrate(settings))
            {
                try
                {
                    await WriteAsync(settings, cancellationToken).ConfigureAwait(false);
                }
                catch (IOException)
                {
                    // A failed migration write is non-fatal: the migrated values are already in effect
                    // for this session and the write will be retried on the next load.
                }
            }

            return settings;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Brings an older settings file up to date. Returns true when something changed and the file
    /// should be rewritten.
    ///
    /// <para>Migrations must only replace values that are recognisably an old <em>default</em>, never a
    /// value the user may have chosen deliberately — hence the equality checks against the previous
    /// defaults rather than blanket overwrites.</para>
    /// </summary>
    private static bool Migrate(AppSettings settings)
    {
        bool changed = false;

        // v1: the per-download connection default moved from 8 to 16 (see AppSettings for the
        // rationale). Only bump installs still sitting on the old default of exactly 8.
        if (settings.SettingsVersion < 1)
        {
            if (settings.MaxConnectionsPerDownload == 8)
            {
                settings.MaxConnectionsPerDownload = 16;
            }

            settings.SettingsVersion = 1;
            changed = true;
        }

        return changed;
    }

    /// <summary>Persists the given settings, replacing any previous file atomically.</summary>
    public async Task SaveAsync(AppSettings settings, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(settings);

        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await WriteAsync(settings, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Writes the settings atomically (temp file then replace). Caller must already hold
    /// <see cref="_gate"/>; kept separate so the migration path in <see cref="LoadAsync"/> can reuse it
    /// without re-entering the non-reentrant semaphore.
    /// </summary>
    private async Task WriteAsync(AppSettings settings, CancellationToken cancellationToken)
    {
        string tempPath = _path + ".tmp";
        await using (var stream = new FileStream(
            tempPath, FileMode.Create, FileAccess.Write, FileShare.None, 4096, useAsync: true))
        {
            await JsonSerializer.SerializeAsync(stream, settings, AppSettingsTypeInfo, cancellationToken)
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
}
