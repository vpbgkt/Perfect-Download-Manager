using System.Diagnostics;
using PDM.Core.Downloading;
using PDM.Core.Net;
using PDM.TestSupport;

namespace PDM.Core.Tests;

public sealed class InspectorAndLimiterTests
{
    [Fact]
    public async Task Inspector_DetectsSizeAndRangeSupport()
    {
        byte[] content = new byte[54321];
        var handler = new InMemoryHttpHandler(content, supportsRanges: true) { FileName = "file.bin" };
        var inspector = new RemoteFileInspector(new HttpClient(handler));

        var info = await inspector.InspectAsync(new Uri("https://server.test/file.bin"));

        Assert.True(info.SupportsRanges);
        Assert.Equal(54321, info.TotalBytes);
        Assert.True(info.CanSegment);
        Assert.Equal("file.bin", info.SuggestedFileName);
    }

    [Fact]
    public async Task Inspector_DetectsNoRangeSupport()
    {
        byte[] content = new byte[1000];
        var handler = new InMemoryHttpHandler(content, supportsRanges: false);
        var inspector = new RemoteFileInspector(new HttpClient(handler));

        var info = await inspector.InspectAsync(new Uri("https://server.test/x"));

        Assert.False(info.SupportsRanges);
        Assert.False(info.CanSegment);
    }

    [Fact]
    public async Task SpeedLimiter_Disabled_DoesNotDelay()
    {
        var limiter = new SpeedLimiter(0);
        Assert.False(limiter.IsEnabled);

        var sw = Stopwatch.StartNew();
        for (int i = 0; i < 100; i++)
        {
            await limiter.ThrottleAsync(64 * 1024, CancellationToken.None);
        }

        sw.Stop();
        Assert.True(sw.ElapsedMilliseconds < 200, $"Unlimited limiter should not delay; took {sw.ElapsedMilliseconds} ms.");
    }

    [Fact]
    public async Task SpeedLimiter_Enabled_ThrottlesToApproximateRate()
    {
        const long rate = 512 * 1024; // 512 KiB/s
        var limiter = new SpeedLimiter(rate);
        Assert.True(limiter.IsEnabled);

        var sw = Stopwatch.StartNew();
        // Transfer ~512 KiB which should take on the order of ~1 second at the cap.
        for (int i = 0; i < 64; i++)
        {
            await limiter.ThrottleAsync(8 * 1024, CancellationToken.None);
        }

        sw.Stop();
        // Allow generous slack for CI timing; the point is that it delayed meaningfully.
        Assert.True(sw.ElapsedMilliseconds >= 500,
            $"Throttled transfer should take noticeable time; took {sw.ElapsedMilliseconds} ms.");
    }
}
