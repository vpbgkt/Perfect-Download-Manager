using System.Text.Json.Serialization;

namespace PDM.Core.Models;

/// <summary>
/// A download capture request handed to PDM by the browser integration (via the native
/// messaging host and local IPC). Kept small and transport-agnostic.
/// </summary>
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// FUTURE WORK: Session-cookie / header forwarding for login-gated downloads
// ══════════════════════════════════════════════════════════════════════════════════════════════
//
// PROBLEM:
// Large Google Drive files (and any download behind a login session) fail in PDM but work
// in the browser. The specific mechanism:
//
//   1. Google Drive's "confirm=t&at=..." download links are bound to the browser's login
//      session (cookies). Without those cookies the server returns a small HTML
//      interstitial page ("can't scan this file for viruses" / sign-in prompt) instead
//      of the actual file bytes.
//
//   2. PDM's probe (Range: bytes=0-0) sometimes succeeds because Google's edge serves the
//      first byte before enforcing the session check, so PrepareAsync reports a valid file
//      — but the full-body transfer request gets the HTML page back.
//
//   3. PDM now detects this HTML response during transfer and fails with a clear message
//      ("The server returned a web page instead of the file...") instead of the old
//      misleading "Unstable connection" loop. But the file still cannot be downloaded
//      without the session.
//
// SOLUTION (when ready):
// Forward the request's Cookie header (and optionally other auth-related headers like
// Authorization) from the browser extension through to the download engine. This requires:
//
//   A) Browser extension: capture the Cookie header from the intercepted request.
//      WARNING: This requires the "cookies" or "webRequest"/"webRequestBlocking" permission,
//      which many users distrust and Chrome Web Store flags for extra review. Consider:
//        - Making it an opt-in "advanced" permission requested at runtime (optional_permissions)
//        - Showing a clear explanation of WHY the permission is needed ("to download
//          files that need your login session, like large Google Drive files")
//        - Offering a fallback UX ("open in browser" button) when the permission is denied
//
//   B) This DownloadRequest model: add a Dictionary<string, string>? Headers property
//      to carry the captured request headers from the extension through the native host.
//      Keep it optional/nullable so existing extension versions (without the permission)
//      continue to work without change.
//
//   C) DownloadState (Models/DownloadState.cs): persist the headers (encrypted or at
//      minimum the Cookie value) so a resumed download can re-send them. Cookies expire,
//      so consider a TTL / "re-capture from browser" flow when they go stale.
//
//   D) DownloadWorker (Downloading/DownloadWorker.cs - TransferSegmentAsync): attach the
//      persisted headers to every HttpRequestMessage sent for this download. See the
//      existing Referer handling as the pattern to follow.
//
//   E) RemoteFileInspector (Net/RemoteFileInspector.cs): accept and forward the headers
//      on the probe request too, so the inspection doesn't falsely report "web page" for
//      a URL that requires the session to even inspect.
//
// SECURITY NOTES:
//   - Never log cookie values; reference by presence only.
//   - Consider encrypting persisted cookies at rest (DPAPI on Windows).
//   - Scope forwarded cookies to the download's domain only (don't leak cross-domain).
//   - Clear persisted cookies when the download completes or is removed.
//
// AFFECTED SERVICES:
//   Google Drive large files, Dropbox direct links, OneDrive shared links, any server
//   that gates file delivery behind a session established via browser login.
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
public sealed class DownloadRequest
{
    /// <summary>The absolute URL to download.</summary>
    [JsonPropertyName("url")]
    public string Url { get; init; } = string.Empty;

    /// <summary>Optional referrer page, for servers that require it.</summary>
    [JsonPropertyName("referrer")]
    public string? Referrer { get; init; }

    /// <summary>Optional suggested file name from the browser.</summary>
    [JsonPropertyName("filename")]
    public string? FileName { get; init; }

    /// <summary>Optional destination directory override.</summary>
    [JsonPropertyName("directory")]
    public string? Directory { get; init; }

    // ──────────────────────────────────────────────────────────────────────────────────────
    // TODO: Add when implementing session-cookie forwarding (see class-level comments above).
    //
    //   [JsonPropertyName("headers")]
    //   public Dictionary<string, string>? Headers { get; init; }
    //
    // Carries the captured request headers from the extension through the native host.
    // Keep it optional/nullable so existing extension versions (without the permission)
    // continue to work without change.
    // ──────────────────────────────────────────────────────────────────────────────────────
}
