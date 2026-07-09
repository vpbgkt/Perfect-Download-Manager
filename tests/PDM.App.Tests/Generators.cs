using FsCheck;
using FsCheck.Fluent;
using PDM.Core.Models;

namespace PDM.App.Tests;

/// <summary>
/// FsCheck arbitraries for the domain types used by the IDM-style popup feature.
/// These generators intentionally exercise the corners the popup derivation layer cares about:
/// every <see cref="DownloadStatus"/>, progress snapshots with zero/large/known/unknown sizes and
/// speeds, and download states with present or missing file name / URL / error message.
///
/// Register with a property test via <c>[Properties(Arbitrary = new[] { typeof(Generators) })]</c>
/// on the test class, or per-test with <c>[Property(Arbitrary = new[] { typeof(Generators) })]</c>.
/// </summary>
public static class Generators
{
    /// <summary>All lifecycle states, drawn uniformly (including terminal states).</summary>
    public static Arbitrary<DownloadStatus> DownloadStatus() =>
        Gen.Elements(
                Core.Models.DownloadStatus.Queued,
                Core.Models.DownloadStatus.Connecting,
                Core.Models.DownloadStatus.Downloading,
                Core.Models.DownloadStatus.Paused,
                Core.Models.DownloadStatus.Assembling,
                Core.Models.DownloadStatus.Verifying,
                Core.Models.DownloadStatus.Completed,
                Core.Models.DownloadStatus.Failed,
                Core.Models.DownloadStatus.Canceled)
            .ToArbitrary();

    /// <summary>
    /// Progress snapshots that vary bytes downloaded, nullable total bytes (unknown size),
    /// bytes-per-second (including zero and very large values), connection counts, and status.
    /// The <see cref="DownloadProgress.Eta"/> is derived by the type from these fields, so varying
    /// total/downloaded/speed here also exercises the ETA path (available, zero, and unknown).
    /// </summary>
    public static Arbitrary<DownloadProgress> DownloadProgress()
    {
        Gen<long> bytesDownloaded = Gen.Choose(0, int.MaxValue).Select(i => (long)i);

        // Total bytes: unknown (null) sometimes, otherwise a non-negative size.
        Gen<long?> totalBytes = Gen.Frequency(
            (1, Gen.Constant((long?)null)),
            (3, Gen.Choose(0, int.MaxValue).Select(i => (long?)i)));

        // Bytes/sec: zero often (stalled), plus small and very large positive rates.
        Gen<double> bytesPerSecond = Gen.Frequency(
            (1, Gen.Constant(0.0)),
            (3, Gen.Choose(1, int.MaxValue).Select(i => (double)i)),
            (1, Gen.Constant(1e12)));

        Gen<double> averageBytesPerSecond = Gen.Frequency(
            (1, Gen.Constant(0.0)),
            (3, Gen.Choose(1, int.MaxValue).Select(i => (double)i)));

        Gen<int> totalConnections = Gen.Choose(1, 32);

        return (from downloaded in bytesDownloaded
                from total in totalBytes
                from bps in bytesPerSecond
                from avg in averageBytesPerSecond
                from totalConn in totalConnections
                from activeConn in Gen.Choose(0, totalConn)
                from status in DownloadStatus().Generator
                select new DownloadProgress
                {
                    BytesDownloaded = downloaded,
                    TotalBytes = total,
                    BytesPerSecond = bps,
                    AverageBytesPerSecond = avg,
                    ActiveConnections = activeConn,
                    TotalConnections = totalConn,
                    Status = status,
                })
            .ToArbitrary();
    }

    /// <summary>
    /// Download states that vary file-name/URL presence (present, empty, or whitespace-only) and
    /// error-message presence (present, empty, or absent), so the popup identity/failure
    /// projections can be exercised for both the "available" and "missing" branches.
    /// </summary>
    public static Arbitrary<DownloadState> DownloadState()
    {
        // A value that is present, empty, or whitespace-only.
        Gen<string> presentOrBlank = Gen.Frequency(
            (3, NonEmptyToken()),
            (1, Gen.Constant(string.Empty)),
            (1, Gen.Constant("   ")));

        // Error message: a present string, empty, or null (not recorded).
        Gen<string?> errorMessage = Gen.Frequency(
            (2, NonEmptyToken().Select(s => (string?)s)),
            (1, Gen.Constant((string?)string.Empty)),
            (2, Gen.Constant((string?)null)));

        return (from url in presentOrBlank
                from destination in presentOrBlank
                from total in Gen.Frequency(
                    (1, Gen.Constant((long?)null)),
                    (3, Gen.Choose(0, int.MaxValue).Select(i => (long?)i)))
                from status in DownloadStatus().Generator
                from error in errorMessage
                select new DownloadState
                {
                    Id = Guid.NewGuid(),
                    SourceUrl = url,
                    EffectiveUrl = url,
                    DestinationPath = destination,
                    TotalBytes = total,
                    Status = status,
                    ErrorMessage = error,
                })
            .ToArbitrary();
    }

    /// <summary>A short, non-empty, printable token with no leading/trailing whitespace.</summary>
    private static Gen<string> NonEmptyToken() =>
        Gen.Elements("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".ToCharArray())
            .NonEmptyListOf()
            .Select(chars => new string(chars.ToArray()));
}
