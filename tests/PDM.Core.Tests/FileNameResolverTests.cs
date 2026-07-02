using System.Net.Http.Headers;
using PDM.Core.Util;

namespace PDM.Core.Tests;

public sealed class FileNameResolverTests
{
    [Fact]
    public void Resolve_PrefersContentDisposition()
    {
        var cd = new ContentDispositionHeaderValue("attachment") { FileName = "report.pdf" };
        string name = FileNameResolver.Resolve(new Uri("https://x.test/download?id=9"), cd, "application/pdf");

        Assert.Equal("report.pdf", name);
    }

    [Fact]
    public void Resolve_FallsBackToUrlSegment()
    {
        string name = FileNameResolver.Resolve(new Uri("https://x.test/files/movie.mp4"), null, "video/mp4");
        Assert.Equal("movie.mp4", name);
    }

    [Fact]
    public void Resolve_DecodesPercentEncodedSegments()
    {
        string name = FileNameResolver.Resolve(new Uri("https://x.test/My%20File%20Name.zip"), null, null);
        Assert.Equal("My File Name.zip", name);
    }

    [Fact]
    public void Resolve_AddsExtensionFromContentTypeWhenMissing()
    {
        string name = FileNameResolver.Resolve(new Uri("https://x.test/getfile"), null, "application/pdf");
        Assert.Equal("getfile.pdf", name);
    }

    [Fact]
    public void Sanitize_ReplacesInvalidCharacters()
    {
        string name = FileNameResolver.Sanitize("in:va/lid*name?.txt");
        Assert.DoesNotContain(':', name);
        Assert.DoesNotContain('*', name);
        Assert.DoesNotContain('?', name);
    }

    [Fact]
    public void Sanitize_EmptyReturnsFallback()
    {
        Assert.Equal("download", FileNameResolver.Sanitize("   "));
    }
}
