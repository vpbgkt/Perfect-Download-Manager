using System.Text.Json;
using System.Text.Json.Serialization;
using PDM.Core.Abstractions;
using PDM.Core.Models;

namespace PDM.Core.Persistence;

/// <summary>
/// Stores each <see cref="DownloadState"/> as an individual JSON sidecar file in a
/// directory. Writes are atomic (write-to-temp then replace) so a crash during a save
/// cannot corrupt the last good state. This is the resume/crash-recovery backbone for
/// in-flight downloads; the UI-facing history uses a separate database.
/// </summary>
public sealed class JsonSidecarStateStore : IDownloadStateStore
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = false,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter() }
    };

    private readonly string _directory;

    public JsonSidecarStateStore(string directory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(directory);
        _directory = directory;
        Directory.CreateDirectory(_directory);
    }

    private string PathFor(Guid id) => Path.Combine(_directory, id.ToString("N") + ".pdmstate");

    /// <inheritdoc />
    public async Task SaveAsync(DownloadState state, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(state);

        string finalPath = PathFor(state.Id);
        string tempPath = finalPath + ".tmp";

        await using (var stream = new FileStream(
            tempPath, FileMode.Create, FileAccess.Write, FileShare.None,
            bufferSize: 4096, useAsync: true))
        {
            await JsonSerializer.SerializeAsync(stream, state, SerializerOptions, cancellationToken)
                .ConfigureAwait(false);
            await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
        }

        // Atomic replace: on Windows this is a single rename when the target is absent,
        // or an overwrite move when it exists.
        if (File.Exists(finalPath))
        {
            File.Replace(tempPath, finalPath, destinationBackupFileName: null);
        }
        else
        {
            File.Move(tempPath, finalPath);
        }
    }

    /// <inheritdoc />
    public async Task<DownloadState?> LoadAsync(Guid id, CancellationToken cancellationToken = default)
    {
        string path = PathFor(id);
        if (!File.Exists(path))
        {
            return null;
        }

        await using var stream = new FileStream(
            path, FileMode.Open, FileAccess.Read, FileShare.Read,
            bufferSize: 4096, useAsync: true);

        return await JsonSerializer.DeserializeAsync<DownloadState>(stream, SerializerOptions, cancellationToken)
            .ConfigureAwait(false);
    }

    /// <inheritdoc />
    public Task DeleteAsync(Guid id, CancellationToken cancellationToken = default)
    {
        string path = PathFor(id);
        if (File.Exists(path))
        {
            File.Delete(path);
        }

        return Task.CompletedTask;
    }

    /// <summary>Enumerates all persisted states, skipping any that fail to deserialize.</summary>
    public async Task<IReadOnlyList<DownloadState>> LoadAllAsync(CancellationToken cancellationToken = default)
    {
        var results = new List<DownloadState>();
        foreach (string file in Directory.EnumerateFiles(_directory, "*.pdmstate"))
        {
            cancellationToken.ThrowIfCancellationRequested();
            try
            {
                await using var stream = new FileStream(
                    file, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, useAsync: true);
                var state = await JsonSerializer
                    .DeserializeAsync<DownloadState>(stream, SerializerOptions, cancellationToken)
                    .ConfigureAwait(false);
                if (state is not null)
                {
                    results.Add(state);
                }
            }
            catch (JsonException)
            {
                // Skip corrupt sidecar files rather than failing the whole load.
            }
        }

        return results;
    }
}
