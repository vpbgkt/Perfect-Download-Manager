namespace PDM.Core.Util;

/// <summary>Helpers for producing safe, non-colliding output file paths.</summary>
public static class PathHelper
{
    /// <summary>
    /// Returns a path that does not collide with an existing file. If <paramref name="path"/>
    /// is free it is returned unchanged; otherwise a counter is inserted before the
    /// extension, e.g. "movie.mp4" -> "movie (1).mp4" -> "movie (2).mp4".
    /// </summary>
    public static string EnsureUnique(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);

        if (!File.Exists(path) && !File.Exists(path + Downloading.DownloadWorker.PartSuffix))
        {
            return path;
        }

        string directory = Path.GetDirectoryName(path) ?? string.Empty;
        string name = Path.GetFileNameWithoutExtension(path);
        string extension = Path.GetExtension(path);

        for (int counter = 1; counter < int.MaxValue; counter++)
        {
            string candidate = Path.Combine(directory, $"{name} ({counter}){extension}");
            if (!File.Exists(candidate) && !File.Exists(candidate + Downloading.DownloadWorker.PartSuffix))
            {
                return candidate;
            }
        }

        throw new IOException($"Unable to find a unique file name for '{path}'.");
    }
}
