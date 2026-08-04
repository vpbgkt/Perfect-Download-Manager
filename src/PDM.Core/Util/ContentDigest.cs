using System.Buffers;
using System.Security.Cryptography;

namespace PDM.Core.Util;

/// <summary>
/// Reads server-advertised content digests off a response and verifies a downloaded file against
/// them. This upgrades PDM's integrity guarantee from "we received the right number of bytes" to
/// "we received exactly the right bytes".
///
/// <para><b>Entirely opportunistic.</b> Most servers advertise no digest at all. When none is present
/// the download proceeds and completes normally — a missing digest is never treated as an error, and
/// nothing is slowed down. Verification only runs when the server gave us something to check against.</para>
///
/// <para>Supported sources, in the order they are trusted:</para>
/// <list type="bullet">
///   <item><c>Repr-Digest</c> / <c>Digest</c> (RFC 9530 / RFC 3230), e.g.
///         <c>sha-256=:BASE64:</c> or <c>sha-256=BASE64, md5=BASE64</c>. The strongest offered
///         algorithm wins.</item>
///   <item><c>Content-MD5</c> (RFC 1864) as a fallback.</item>
/// </list>
/// Both base64 (per spec) and hex encodings are accepted, because real-world servers emit both.
/// </summary>
public static class ContentDigest
{
    /// <summary>Canonical algorithm names used throughout PDM.</summary>
    public const string Md5 = "MD5";

    /// <summary>Canonical algorithm names used throughout PDM.</summary>
    public const string Sha1 = "SHA-1";

    /// <summary>Canonical algorithm names used throughout PDM.</summary>
    public const string Sha256 = "SHA-256";

    /// <summary>Canonical algorithm names used throughout PDM.</summary>
    public const string Sha512 = "SHA-512";

    /// <summary>
    /// Extracts the strongest usable digest advertised by <paramref name="response"/>, or null when the
    /// server advertised none (by far the common case). The returned value is normalised to base64.
    /// </summary>
    public static (string Algorithm, string Value)? TryExtract(HttpResponseMessage response)
    {
        ArgumentNullException.ThrowIfNull(response);

        (string Algorithm, string Value)? best = null;

        // RFC 9530 supersedes RFC 3230 but both use the same "name=value" shape, so parse either.
        foreach (string header in new[] { "Repr-Digest", "Digest" })
        {
            if (!response.Headers.TryGetValues(header, out IEnumerable<string>? values))
            {
                continue;
            }

            foreach (string raw in values)
            {
                foreach (string token in raw.Split(',', StringSplitOptions.RemoveEmptyEntries |
                                                       StringSplitOptions.TrimEntries))
                {
                    int eq = token.IndexOf('=');
                    if (eq <= 0)
                    {
                        continue;
                    }

                    string name = token[..eq].Trim();
                    // RFC 9530 wraps the value in colons as a structured-field byte sequence, and
                    // base64 padding also uses '=' — so only trim the delimiters, never the padding.
                    string value = token[(eq + 1)..].Trim().Trim(':');

                    string? algorithm = NormalizeAlgorithm(name);
                    if (algorithm is null || value.Length == 0)
                    {
                        continue;
                    }

                    if (TryDecode(value, DigestLength(algorithm), out byte[]? bytes))
                    {
                        var candidate = (algorithm, Convert.ToBase64String(bytes!));
                        if (best is null || Strength(algorithm) > Strength(best.Value.Algorithm))
                        {
                            best = candidate;
                        }
                    }
                }
            }
        }

        if (best is not null)
        {
            return best;
        }

        // Fallback: Content-MD5, which .NET parses into raw bytes for us.
        try
        {
            byte[]? md5 = response.Content.Headers.ContentMD5;
            if (md5 is { Length: 16 })
            {
                return (Md5, Convert.ToBase64String(md5));
            }
        }
        catch (FormatException)
        {
            // A malformed Content-MD5 is ignored rather than failing the download.
        }

        return null;
    }

    /// <summary>
    /// Hashes <paramref name="path"/> with <paramref name="algorithm"/> and returns the digest as
    /// base64. Streams the file in pooled buffers so hashing a very large download does not allocate
    /// proportionally to its size, and honours <paramref name="cancellationToken"/> so a pause during
    /// verification stays responsive.
    /// </summary>
    public static async Task<string> ComputeBase64Async(
        string path, string algorithm, int bufferSize = 1024 * 1024,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);

        using IncrementalHash hash = CreateHash(algorithm);
        byte[] buffer = ArrayPool<byte>.Shared.Rent(Math.Max(64 * 1024, bufferSize));
        try
        {
            await using var stream = new FileStream(
                path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite,
                bufferSize: 0, FileOptions.Asynchronous | FileOptions.SequentialScan);

            while (true)
            {
                int read = await stream.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
                if (read <= 0)
                {
                    break;
                }

                hash.AppendData(buffer, 0, read);
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }

        return Convert.ToBase64String(hash.GetHashAndReset());
    }

    /// <summary>
    /// Compares an expected digest (as advertised by the server, base64 or hex) with a computed base64
    /// digest. Returns false when either value cannot be decoded, so an unparseable digest is treated
    /// as a mismatch only by the caller's choice — callers should prefer <see cref="TryExtract"/>,
    /// which already discards undecodable values.
    /// </summary>
    public static bool Matches(string expectedValue, string computedBase64, string algorithm)
    {
        if (string.IsNullOrWhiteSpace(expectedValue) || string.IsNullOrWhiteSpace(computedBase64))
        {
            return false;
        }

        int length = DigestLength(algorithm);
        if (!TryDecode(expectedValue, length, out byte[]? expected) ||
            !TryDecode(computedBase64, length, out byte[]? computed))
        {
            return false;
        }

        return CryptographicOperations.FixedTimeEquals(expected!, computed!);
    }

    /// <summary>True when PDM can hash with the named algorithm.</summary>
    public static bool IsSupported(string? algorithm) =>
        algorithm is Md5 or Sha1 or Sha256 or Sha512;

    private static IncrementalHash CreateHash(string algorithm) => algorithm switch
    {
        Md5 => IncrementalHash.CreateHash(HashAlgorithmName.MD5),
        Sha1 => IncrementalHash.CreateHash(HashAlgorithmName.SHA1),
        Sha256 => IncrementalHash.CreateHash(HashAlgorithmName.SHA256),
        Sha512 => IncrementalHash.CreateHash(HashAlgorithmName.SHA512),
        _ => throw new ArgumentOutOfRangeException(nameof(algorithm), algorithm, "Unsupported digest algorithm.")
    };

    /// <summary>Maps the many spellings servers use onto PDM's canonical names.</summary>
    private static string? NormalizeAlgorithm(string name) => name.Trim().ToLowerInvariant() switch
    {
        "md5" => Md5,
        "sha" or "sha1" or "sha-1" => Sha1,
        "sha256" or "sha-256" => Sha256,
        "sha512" or "sha-512" => Sha512,
        _ => null // unknown or non-hash tokens (e.g. "unixsum") are ignored
    };

    /// <summary>Preference order: a stronger hash is a better integrity proof.</summary>
    private static int Strength(string algorithm) => algorithm switch
    {
        Sha512 => 4,
        Sha256 => 3,
        Sha1 => 2,
        Md5 => 1,
        _ => 0
    };

    private static int DigestLength(string algorithm) => algorithm switch
    {
        Md5 => 16,
        Sha1 => 20,
        Sha256 => 32,
        Sha512 => 64,
        _ => 0
    };

    /// <summary>
    /// Decodes a digest that may be base64 (per the specs) or hex (used by some servers), rejecting
    /// anything whose decoded length does not match the algorithm.
    /// </summary>
    private static bool TryDecode(string value, int expectedLength, out byte[]? bytes)
    {
        bytes = null;
        value = value.Trim();
        if (value.Length == 0 || expectedLength <= 0)
        {
            return false;
        }

        // Hex first: unambiguous by length and character set.
        if (value.Length == expectedLength * 2 && IsHex(value))
        {
            try
            {
                bytes = Convert.FromHexString(value);
                return bytes.Length == expectedLength;
            }
            catch (FormatException)
            {
                return false;
            }
        }

        try
        {
            byte[] decoded = Convert.FromBase64String(value);
            if (decoded.Length != expectedLength)
            {
                return false;
            }

            bytes = decoded;
            return true;
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static bool IsHex(string value)
    {
        foreach (char c in value)
        {
            bool hex = c is >= '0' and <= '9' or >= 'a' and <= 'f' or >= 'A' and <= 'F';
            if (!hex)
            {
                return false;
            }
        }

        return true;
    }
}
