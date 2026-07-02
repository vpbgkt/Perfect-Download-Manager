namespace PDM.Core.Downloading;

/// <summary>Raised when a download fails in a way that cannot be automatically recovered.</summary>
public sealed class DownloadException : Exception
{
    public DownloadException(string message) : base(message)
    {
    }

    public DownloadException(string message, Exception innerException) : base(message, innerException)
    {
    }
}
