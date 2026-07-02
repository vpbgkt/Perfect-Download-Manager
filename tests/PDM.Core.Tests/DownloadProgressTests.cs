using PDM.Core.Models;

namespace PDM.Core.Tests;

public sealed class DownloadProgressTests
{
    [Fact]
    public void Fraction_ComputesCorrectly()
    {
        var progress = new DownloadProgress { BytesDownloaded = 250, TotalBytes = 1000 };
        Assert.Equal(0.25, progress.Fraction);
    }

    [Fact]
    public void Fraction_UnknownTotal_IsNull()
    {
        var progress = new DownloadProgress { BytesDownloaded = 250, TotalBytes = null };
        Assert.Null(progress.Fraction);
    }

    [Fact]
    public void Eta_ComputesFromRate()
    {
        var progress = new DownloadProgress
        {
            BytesDownloaded = 500,
            TotalBytes = 1500,
            BytesPerSecond = 100
        };

        // 1000 bytes remaining at 100 B/s => 10 seconds.
        Assert.Equal(TimeSpan.FromSeconds(10), progress.Eta);
    }

    [Fact]
    public void Eta_ZeroRate_IsNull()
    {
        var progress = new DownloadProgress { BytesDownloaded = 500, TotalBytes = 1500, BytesPerSecond = 0 };
        Assert.Null(progress.Eta);
    }
}
