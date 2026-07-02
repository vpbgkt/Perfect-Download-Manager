using System.Data;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Data.Sqlite;
using PDM.Core.Abstractions;
using PDM.Core.Models;

namespace PDM.Infrastructure;

/// <summary>
/// SQLite-backed catalog of downloads. Uses WAL journaling for concurrent readers and a
/// single writer, parameterized queries throughout, and denormalizes only the fields
/// needed for filtering; segment layout is stored as a JSON blob because segments are
/// only relevant when the same download is opened by the engine again.
/// </summary>
public sealed class SqliteDownloadRepository : IDownloadRepository
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter() }
    };

    private readonly string _connectionString;

    public SqliteDownloadRepository(string databasePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePath);
        Directory.CreateDirectory(Path.GetDirectoryName(databasePath)!);

        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = databasePath,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared,
            Pooling = true
        }.ToString();
    }

    /// <inheritdoc />
    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        await using SqliteConnection connection = await OpenAsync(cancellationToken).ConfigureAwait(false);

        const string schema = @"
            CREATE TABLE IF NOT EXISTS downloads (
                Id              TEXT PRIMARY KEY NOT NULL,
                SourceUrl       TEXT NOT NULL,
                EffectiveUrl    TEXT NOT NULL,
                DestinationPath TEXT NOT NULL,
                TotalBytes      INTEGER NULL,
                SupportsRanges  INTEGER NOT NULL,
                ETag            TEXT NULL,
                LastModified    TEXT NULL,
                Status          INTEGER NOT NULL,
                Category        INTEGER NOT NULL,
                CustomCategory  TEXT NULL,
                ErrorMessage    TEXT NULL,
                CreatedUtc      TEXT NOT NULL,
                CompletedUtc    TEXT NULL,
                BytesDownloaded INTEGER NOT NULL,
                Segments        TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS ix_downloads_status ON downloads(Status);
            CREATE INDEX IF NOT EXISTS ix_downloads_category ON downloads(Category);
            CREATE INDEX IF NOT EXISTS ix_downloads_created ON downloads(CreatedUtc DESC);
        ";

        await using SqliteCommand cmd = connection.CreateCommand();
        cmd.CommandText = schema;
        await cmd.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task UpsertAsync(DownloadState state, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(state);

        await using SqliteConnection connection = await OpenAsync(cancellationToken).ConfigureAwait(false);

        const string sql = @"
            INSERT INTO downloads (
                Id, SourceUrl, EffectiveUrl, DestinationPath, TotalBytes, SupportsRanges,
                ETag, LastModified, Status, Category, CustomCategory, ErrorMessage,
                CreatedUtc, CompletedUtc, BytesDownloaded, Segments)
            VALUES (
                $id, $src, $eff, $dst, $total, $ranges,
                $etag, $lm, $status, $cat, $custom, $err,
                $created, $completed, $bytes, $segments)
            ON CONFLICT(Id) DO UPDATE SET
                SourceUrl=excluded.SourceUrl,
                EffectiveUrl=excluded.EffectiveUrl,
                DestinationPath=excluded.DestinationPath,
                TotalBytes=excluded.TotalBytes,
                SupportsRanges=excluded.SupportsRanges,
                ETag=excluded.ETag,
                LastModified=excluded.LastModified,
                Status=excluded.Status,
                Category=excluded.Category,
                CustomCategory=excluded.CustomCategory,
                ErrorMessage=excluded.ErrorMessage,
                CompletedUtc=excluded.CompletedUtc,
                BytesDownloaded=excluded.BytesDownloaded,
                Segments=excluded.Segments;
        ";

        await using SqliteCommand cmd = connection.CreateCommand();
        cmd.CommandText = sql;
        BindState(cmd, state);
        await cmd.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<DownloadState?> GetAsync(Guid id, CancellationToken cancellationToken = default)
    {
        await using SqliteConnection connection = await OpenAsync(cancellationToken).ConfigureAwait(false);
        await using SqliteCommand cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT * FROM downloads WHERE Id = $id";
        cmd.Parameters.AddWithValue("$id", id.ToString("N"));

        await using SqliteDataReader reader = await cmd.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        return await reader.ReadAsync(cancellationToken).ConfigureAwait(false) ? Read(reader) : null;
    }

    /// <inheritdoc />
    public async Task DeleteAsync(Guid id, CancellationToken cancellationToken = default)
    {
        await using SqliteConnection connection = await OpenAsync(cancellationToken).ConfigureAwait(false);
        await using SqliteCommand cmd = connection.CreateCommand();
        cmd.CommandText = "DELETE FROM downloads WHERE Id = $id";
        cmd.Parameters.AddWithValue("$id", id.ToString("N"));
        await cmd.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<IReadOnlyList<DownloadState>> ListAsync(CancellationToken cancellationToken = default)
    {
        await using SqliteConnection connection = await OpenAsync(cancellationToken).ConfigureAwait(false);
        await using SqliteCommand cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT * FROM downloads ORDER BY CreatedUtc DESC";
        return await ReadAllAsync(cmd, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<IReadOnlyList<DownloadState>> ListByStatusAsync(
        IEnumerable<DownloadStatus> statuses, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(statuses);
        int[] codes = statuses.Select(s => (int)s).Distinct().ToArray();
        if (codes.Length == 0)
        {
            return Array.Empty<DownloadState>();
        }

        await using SqliteConnection connection = await OpenAsync(cancellationToken).ConfigureAwait(false);
        await using SqliteCommand cmd = connection.CreateCommand();

        // Build a parameterized IN clause so callers cannot inject SQL via the enum values.
        var placeholders = new List<string>(codes.Length);
        for (int i = 0; i < codes.Length; i++)
        {
            string name = $"$s{i}";
            placeholders.Add(name);
            cmd.Parameters.AddWithValue(name, codes[i]);
        }

        cmd.CommandText = $"SELECT * FROM downloads WHERE Status IN ({string.Join(',', placeholders)}) " +
                          "ORDER BY CreatedUtc DESC";
        return await ReadAllAsync(cmd, cancellationToken).ConfigureAwait(false);
    }

    /// <inheritdoc />
    public async Task<IReadOnlyList<DownloadState>> ListByCategoryAsync(
        DownloadCategory category, CancellationToken cancellationToken = default)
    {
        await using SqliteConnection connection = await OpenAsync(cancellationToken).ConfigureAwait(false);
        await using SqliteCommand cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT * FROM downloads WHERE Category = $cat ORDER BY CreatedUtc DESC";
        cmd.Parameters.AddWithValue("$cat", (int)category);
        return await ReadAllAsync(cmd, cancellationToken).ConfigureAwait(false);
    }

    private async Task<SqliteConnection> OpenAsync(CancellationToken cancellationToken)
    {
        var connection = new SqliteConnection(_connectionString);
        await connection.OpenAsync(cancellationToken).ConfigureAwait(false);

        // Enable WAL + normal sync for good throughput without risking corruption.
        await using SqliteCommand pragma = connection.CreateCommand();
        pragma.CommandText = "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;";
        await pragma.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        return connection;
    }

    private static void BindState(SqliteCommand cmd, DownloadState state)
    {
        cmd.Parameters.AddWithValue("$id", state.Id.ToString("N"));
        cmd.Parameters.AddWithValue("$src", state.SourceUrl);
        cmd.Parameters.AddWithValue("$eff", state.EffectiveUrl);
        cmd.Parameters.AddWithValue("$dst", state.DestinationPath);
        cmd.Parameters.AddWithValue("$total", state.TotalBytes.HasValue ? state.TotalBytes.Value : DBNull.Value);
        cmd.Parameters.AddWithValue("$ranges", state.SupportsRanges ? 1 : 0);
        cmd.Parameters.AddWithValue("$etag", (object?)state.ETag ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$lm", state.LastModified?.ToString("O") ?? (object)DBNull.Value);
        cmd.Parameters.AddWithValue("$status", (int)state.Status);
        cmd.Parameters.AddWithValue("$cat", (int)state.Category);
        cmd.Parameters.AddWithValue("$custom", (object?)state.CustomCategory ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$err", (object?)state.ErrorMessage ?? DBNull.Value);
        cmd.Parameters.AddWithValue("$created", state.CreatedUtc.ToString("O"));
        cmd.Parameters.AddWithValue("$completed", state.CompletedUtc?.ToString("O") ?? (object)DBNull.Value);
        cmd.Parameters.AddWithValue("$bytes", state.BytesDownloaded);
        cmd.Parameters.AddWithValue("$segments", JsonSerializer.Serialize(state.Segments, JsonOptions));
    }

    private static async Task<IReadOnlyList<DownloadState>> ReadAllAsync(
        SqliteCommand cmd, CancellationToken cancellationToken)
    {
        var result = new List<DownloadState>();
        await using SqliteDataReader reader = await cmd.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            result.Add(Read(reader));
        }

        return result;
    }

    private static DownloadState Read(IDataRecord reader)
    {
        return new DownloadState
        {
            Id = Guid.ParseExact(reader.GetString(reader.GetOrdinal("Id")), "N"),
            SourceUrl = reader.GetString(reader.GetOrdinal("SourceUrl")),
            EffectiveUrl = reader.GetString(reader.GetOrdinal("EffectiveUrl")),
            DestinationPath = reader.GetString(reader.GetOrdinal("DestinationPath")),
            TotalBytes = reader.IsDBNull(reader.GetOrdinal("TotalBytes"))
                ? null
                : reader.GetInt64(reader.GetOrdinal("TotalBytes")),
            SupportsRanges = reader.GetInt32(reader.GetOrdinal("SupportsRanges")) != 0,
            ETag = reader.IsDBNull(reader.GetOrdinal("ETag")) ? null : reader.GetString(reader.GetOrdinal("ETag")),
            LastModified = reader.IsDBNull(reader.GetOrdinal("LastModified"))
                ? null
                : DateTimeOffset.Parse(reader.GetString(reader.GetOrdinal("LastModified")),
                    System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.RoundtripKind),
            Status = (DownloadStatus)reader.GetInt32(reader.GetOrdinal("Status")),
            Category = (DownloadCategory)reader.GetInt32(reader.GetOrdinal("Category")),
            CustomCategory = reader.IsDBNull(reader.GetOrdinal("CustomCategory"))
                ? null
                : reader.GetString(reader.GetOrdinal("CustomCategory")),
            ErrorMessage = reader.IsDBNull(reader.GetOrdinal("ErrorMessage"))
                ? null
                : reader.GetString(reader.GetOrdinal("ErrorMessage")),
            CreatedUtc = DateTimeOffset.Parse(reader.GetString(reader.GetOrdinal("CreatedUtc")),
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.RoundtripKind),
            CompletedUtc = reader.IsDBNull(reader.GetOrdinal("CompletedUtc"))
                ? null
                : DateTimeOffset.Parse(reader.GetString(reader.GetOrdinal("CompletedUtc")),
                    System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.RoundtripKind),
            Segments = JsonSerializer.Deserialize<List<DownloadSegment>>(
                reader.GetString(reader.GetOrdinal("Segments")), JsonOptions) ?? new List<DownloadSegment>()
        };
    }
}
