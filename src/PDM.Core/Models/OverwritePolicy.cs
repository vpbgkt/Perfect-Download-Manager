namespace PDM.Core.Models;

/// <summary>
/// Controls what happens when a download resolves to a destination path that already exists.
/// </summary>
public enum OverwritePolicy
{
    /// <summary>Append " (N)" to the name until it is unique. Safest default.</summary>
    Rename = 0,

    /// <summary>Overwrite the existing file at the destination.</summary>
    Overwrite = 1,

    /// <summary>Refuse the download; caller will see an error.</summary>
    Skip = 2
}
