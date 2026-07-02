using PDM.Core.Models;
using PDM.Core.Util;

namespace PDM.Infrastructure.Tests;

public sealed class CategoryClassifierTests
{
    [Theory]
    [InlineData("movie.mp4", DownloadCategory.Video)]
    [InlineData("track.MP3", DownloadCategory.Music)]
    [InlineData("archive.7z", DownloadCategory.Compressed)]
    [InlineData("report.pdf", DownloadCategory.Documents)]
    [InlineData("setup.exe", DownloadCategory.Programs)]
    [InlineData("unknown.xyz", DownloadCategory.General)]
    [InlineData("", DownloadCategory.General)]
    public void Classify_MapsExtensions(string name, DownloadCategory expected)
    {
        Assert.Equal(expected, CategoryClassifier.Classify(name));
    }
}
