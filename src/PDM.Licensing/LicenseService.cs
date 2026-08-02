using PDM.Licensing.Signed;

namespace PDM.Licensing;

/// <summary>
/// Resolved, ready-to-apply capability limits for the current licensing state. These are derived
/// from the <b>signed</b> token claims (for activated/grace licenses) or from fixed tier defaults
/// (trial / expired), never from a single boolean. A <see langword="null"/> cap means "no
/// client-imposed limit" (full speed).
///
/// <para>Security intent (C1): the premium throughput numbers ride inside a server-signed token, so
/// forcing a status flag on a patched client cannot fabricate them. Callers apply these caps at the
/// point of use rather than reading one central "is licensed" bool.</para>
/// </summary>
public readonly record struct LicenseEntitlements(
    int? MaxConnectionsPerDownload,
    int? MaxParallelDownloads,
    string[] Features)
{
    /// <summary>Reduced free/expired tier: throttled, one-at-a-time.</summary>
    public static readonly LicenseEntitlements Free = new(2, 1, Array.Empty<string>());

    /// <summary>Full trial/licensed tier when no explicit signed cap is present: uncapped.</summary>
    public static readonly LicenseEntitlements Full = new(null, null, Array.Empty<string>());
}

/// <summary>
/// Immutable, coarse view of the current licensing state used by the UI.
/// </summary>
public readonly record struct LicenseSnapshot(
    LicenseStatus Status,
    TimeSpan Remaining,
    string? Owner,
    string? Message,
    LicenseEntitlements Entitlements = default)
{
    /// <summary>True when the app should offer full commercial features.</summary>
    public bool IsFunctional => Status is LicenseStatus.Trial or LicenseStatus.Grace or LicenseStatus.Activated;
}

/// <summary>
/// Coordinates trial timing, license activation, periodic re-validation, and hardware binding.
///
/// Security model: activation and activated-state are anchored on a <b>server-signed token</b>
/// verified locally with an embedded public key (<see cref="LicenseTokenVerifier"/>). The client
/// never decides "licensed = true" from a plain server response; it requires a cryptographically
/// signed token whose claims (license key, machine fingerprint, expiry) it re-checks on every
/// launch. An attacker cannot forge such a token without the server's private key, and a patched
/// transport that "returns success" produces no token, so it cannot unlock the product.
///
/// Tokens are short-lived (server TTL). The client tolerates brief offline periods up to the
/// token expiry plus a grace window; beyond that it must re-validate online.
/// </summary>
public sealed class LicenseService
{
    /// <summary>Length of the initial free trial (14 days).</summary>
    public static readonly TimeSpan DefaultTrialLength = TimeSpan.FromDays(14);

    /// <summary>Grace period after the trial or token expires before features lock.</summary>
    public static readonly TimeSpan DefaultGracePeriod = TimeSpan.FromDays(7);

    private readonly ILicenseStore _store;
    private readonly ILicenseTransport _transport;
    private readonly LicenseTokenVerifier? _verifier;
    private readonly Func<DateTimeOffset> _clock;
    private readonly Func<string> _fingerprintProvider;

    public LicenseService(
        ILicenseStore store,
        ILicenseTransport? transport = null,
        LicenseTokenVerifier? verifier = null,
        Func<DateTimeOffset>? clock = null,
        Func<string>? fingerprintProvider = null)
    {
        _store = store ?? throw new ArgumentNullException(nameof(store));
        _transport = transport ?? NullLicenseTransport.Instance;
        _verifier = verifier;
        _clock = clock ?? (() => DateTimeOffset.UtcNow);
        _fingerprintProvider = fingerprintProvider ?? MachineFingerprint.Compute;
    }

    /// <summary>Trial length; overridable for testing.</summary>
    public TimeSpan TrialLength { get; init; } = DefaultTrialLength;

    /// <summary>Grace period; overridable for testing.</summary>
    public TimeSpan GracePeriod { get; init; } = DefaultGracePeriod;

    /// <summary>Loads the current snapshot, creating a fresh trial record on first launch.</summary>
    public async Task<LicenseSnapshot> GetSnapshotAsync(CancellationToken cancellationToken = default)
    {
        LicenseRecord record = await LoadOrInitializeAsync(cancellationToken).ConfigureAwait(false);
        await AdvanceMonotonicClockAsync(record, cancellationToken).ConfigureAwait(false);
        return BuildSnapshot(record);
    }

    /// <summary>
    /// Advances the persisted anti-rollback watermark (H3) when the real clock is ahead of it, so
    /// the highest-ever-seen time is durable. A single small write only when the clock moves
    /// forward — no cost on the download hot path.
    /// </summary>
    private async Task AdvanceMonotonicClockAsync(LicenseRecord record, CancellationToken cancellationToken)
    {
        DateTimeOffset now = _clock();
        if (record.MaxSeenUtc is null || now > record.MaxSeenUtc.Value)
        {
            record.MaxSeenUtc = now;
            await _store.SaveAsync(record, cancellationToken).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// The trustworthy "now" for expiry math: the later of the system clock and the persisted
    /// watermark. Winding the clock back therefore cannot roll time backwards for licensing.
    /// </summary>
    private DateTimeOffset EffectiveNow(LicenseRecord record)
    {
        DateTimeOffset now = _clock();
        return record.MaxSeenUtc is { } seen && seen > now ? seen : now;
    }

    /// <summary>
    /// Fetches the server-signed trial anchor for this machine and stores it, so the trial start
    /// is authoritative and survives reinstalls. No-op when a license is already active or the
    /// server is unreachable (the client then falls back to its local trial start).
    /// Call once at startup after <see cref="GetSnapshotAsync"/>.
    /// </summary>
    public async Task EnsureTrialAnchorAsync(CancellationToken cancellationToken = default)
    {
        LicenseRecord record = await LoadOrInitializeAsync(cancellationToken).ConfigureAwait(false);
        if (!string.IsNullOrWhiteSpace(record.SignedToken))
        {
            return; // licensed; trial anchor irrelevant
        }

        string fingerprint = _fingerprintProvider();

        string? token;
        try
        {
            token = await _transport.GetTrialAnchorAsync(fingerprint, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return; // offline: keep whatever we have
        }

        if (string.IsNullOrWhiteSpace(token) || _verifier is null)
        {
            return;
        }

        // Only trust an anchor that verifies and is bound to this machine.
        TrialClaims? claims = _verifier.VerifyTrial(token);
        if (claims is null ||
            !string.Equals(claims.Fingerprint, fingerprint, StringComparison.OrdinalIgnoreCase) ||
            claims.Type != "trial")
        {
            return;
        }

        record.TrialToken = token;
        await _store.SaveAsync(record, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Activates <paramref name="licenseKey"/>. Requires the server to return a signed token
    /// that verifies locally and is bound to this machine; otherwise activation is refused.
    /// </summary>
    public async Task<LicenseSnapshot> ActivateAsync(string licenseKey, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(licenseKey);

        string key = licenseKey.Trim();
        string fingerprint = _fingerprintProvider();

        LicenseValidationResult result;
        try
        {
            result = await _transport.ActivateAsync(key, fingerprint, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            return new LicenseSnapshot(LicenseStatus.Invalid, TimeSpan.Zero, null,
                "Could not reach the licensing server. Check your connection and try again.",
                LicenseEntitlements.Free);
        }

        if (!result.IsValid)
        {
            return new LicenseSnapshot(LicenseStatus.Invalid, TimeSpan.Zero, null, result.Message,
                LicenseEntitlements.Free);
        }

        LicenseClaims? claims = VerifyToken(result.Token, key, fingerprint);
        if (claims is null)
        {
            // Valid-looking response but the token failed cryptographic verification: reject.
            return new LicenseSnapshot(LicenseStatus.Invalid, TimeSpan.Zero, null,
                "The license token could not be verified. Please contact support.",
                LicenseEntitlements.Free);
        }

        LicenseRecord record = await LoadOrInitializeAsync(cancellationToken).ConfigureAwait(false);
        ApplyClaims(record, result.Token!, claims);
        await _store.SaveAsync(record, cancellationToken).ConfigureAwait(false);
        return BuildSnapshot(record);
    }

    /// <summary>
    /// Re-validates the current license and refreshes its token. A transient failure keeps the
    /// existing token (offline tolerance up to its expiry + grace); an explicit revocation clears it.
    /// </summary>
    public async Task<LicenseSnapshot> RefreshAsync(CancellationToken cancellationToken = default)
    {
        LicenseRecord record = await LoadOrInitializeAsync(cancellationToken).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(record.LicenseKey))
        {
            return BuildSnapshot(record);
        }

        string fingerprint = _fingerprintProvider();

        LicenseValidationResult result;
        try
        {
            result = await _transport.ValidateAsync(record.LicenseKey, fingerprint, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Offline: keep the existing token; the token TTL + grace govern how long that lasts.
            return BuildSnapshot(record);
        }

        if (result.IsValid)
        {
            LicenseClaims? claims = VerifyToken(result.Token, record.LicenseKey, fingerprint);
            if (claims is not null)
            {
                ApplyClaims(record, result.Token!, claims);
                await _store.SaveAsync(record, cancellationToken).ConfigureAwait(false);
            }
        }
        else if (result.Revoked || (result.Message is { Length: > 0 } m && ContainsRevocation(m)))
        {
            ClearLicense(record);
            await _store.SaveAsync(record, cancellationToken).ConfigureAwait(false);
        }

        return BuildSnapshot(record);
    }

    /// <summary>
    /// Deactivates the license on this PC. Releases the machine's activation seat on the server
    /// (best-effort) so the license can be re-activated on another computer, then clears the local
    /// record regardless. Clearing only local state — the previous behaviour — left the seat bound
    /// server-side, so the admin panel still showed the machine and the activation slot stayed
    /// consumed, blocking the user from moving the license.
    /// </summary>
    public async Task<LicenseSnapshot> DeactivateAsync(CancellationToken cancellationToken = default)
    {
        LicenseRecord record = await LoadOrInitializeAsync(cancellationToken).ConfigureAwait(false);

        string? key = record.LicenseKey;
        // Release the seat that was actually bound at activation; fall back to the current machine
        // fingerprint for older records that predate storing BoundFingerprint.
        string fingerprint = !string.IsNullOrWhiteSpace(record.BoundFingerprint)
            ? record.BoundFingerprint!
            : _fingerprintProvider();

        // The server authorizes the release by verifying this signed token against the key +
        // fingerprint, so a third party who only knows the key/fingerprint cannot release the seat.
        string? token = record.SignedToken;

        bool releasedRemotely = false;
        if (!string.IsNullOrWhiteSpace(key))
        {
            try
            {
                releasedRemotely = await _transport.DeactivateAsync(key!, fingerprint, token, cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // Offline or server error: still deactivate locally; surface a hint below.
                releasedRemotely = false;
            }
        }

        ClearLicense(record);
        await _store.SaveAsync(record, cancellationToken).ConfigureAwait(false);

        LicenseSnapshot snapshot = BuildSnapshot(record);

        // If we had a license but could not confirm the server-side release, tell the user so they
        // know a subsequent activation on another PC might need a retry (or support) if it was the
        // last free seat.
        if (!releasedRemotely && !string.IsNullOrWhiteSpace(key))
        {
            snapshot = snapshot with
            {
                Message = "Deactivated on this PC. If you can't activate on another computer, reconnect " +
                          "to the internet and deactivate again, or contact support to release the seat."
            };
        }

        return snapshot;
    }

    /// <summary>
    /// Resolves the ready-to-apply caps from verified license claims. A signed value &lt;= 0 means
    /// "no client-imposed cap" (full speed); a positive value is the enforced limit.
    /// </summary>
    private static LicenseEntitlements EntitlementsFromClaims(LicenseClaims claims)
    {
        int? conn = claims.MaxConnections > 0 ? claims.MaxConnections : null;
        int? parallel = claims.MaxParallel > 0 ? claims.MaxParallel : null;
        return new LicenseEntitlements(conn, parallel, claims.Features ?? Array.Empty<string>());
    }

    private LicenseClaims? VerifyToken(string? token, string expectedKey, string expectedFingerprint)
    {
        if (string.IsNullOrWhiteSpace(token) || _verifier is null)
        {
            return null;
        }

        LicenseClaims? claims = _verifier.Verify(token);
        if (claims is null)
        {
            return null;
        }

        // The signed claims must match the key we asked about and this exact machine.
        if (!string.Equals(claims.LicenseKey, expectedKey, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(claims.Fingerprint, expectedFingerprint, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        return claims;
    }

    private void ApplyClaims(LicenseRecord record, string token, LicenseClaims claims)
    {
        record.LicenseKey = claims.LicenseKey;
        record.BoundFingerprint = claims.Fingerprint;
        record.SignedToken = token;
        record.ExpiresUtc = claims.ExpiresAt;
        record.Owner = claims.Owner;
        record.Features = claims.Features;
        DateTimeOffset now = _clock();
        record.LastValidatedUtc = now;
        if (record.MaxSeenUtc is null || now > record.MaxSeenUtc.Value)
        {
            record.MaxSeenUtc = now;
        }
    }

    private static void ClearLicense(LicenseRecord record)
    {
        record.LicenseKey = null;
        record.BoundFingerprint = null;
        record.SignedToken = null;
        record.ExpiresUtc = null;
        record.Owner = null;
        record.Features = null;
        record.LastValidatedUtc = null;
    }

    private async Task<LicenseRecord> LoadOrInitializeAsync(CancellationToken cancellationToken)
    {
        LicenseRecord? existing = await _store.LoadAsync(cancellationToken).ConfigureAwait(false);
        if (existing is not null)
        {
            return existing;
        }

        var fresh = new LicenseRecord { FirstLaunchUtc = _clock() };
        await _store.SaveAsync(fresh, cancellationToken).ConfigureAwait(false);
        return fresh;
    }

    private LicenseSnapshot BuildSnapshot(LicenseRecord record)
    {
        DateTimeOffset now = EffectiveNow(record);

        if (!string.IsNullOrWhiteSpace(record.SignedToken))
        {
            return BuildLicensedSnapshot(record, now);
        }

        // No license: trial flow. Prefer the server-signed anchor (reinstall-proof) over the
        // local first-launch time, so deleting local state or the registry cannot reset the trial.
        (DateTimeOffset trialStart, TimeSpan trialLength) = ResolveTrialWindow(record);
        DateTimeOffset trialEnd = trialStart + trialLength;

        if (now < trialEnd)
        {
            // Trial is deliberately full-featured to showcase the product; it is time-limited by the
            // server-signed anchor rather than by throttling.
            return new LicenseSnapshot(LicenseStatus.Trial, trialEnd - now, null, null, LicenseEntitlements.Full);
        }

        return new LicenseSnapshot(LicenseStatus.Expired, TimeSpan.Zero, null,
            "Your free trial has ended. Please activate a license to continue.", LicenseEntitlements.Free);
    }

    /// <summary>
    /// Determines the effective trial start and length. Uses the verified server anchor when
    /// present; otherwise the local first-launch time. The anchor cannot be forged (signed) and
    /// its start is server-authoritative per machine fingerprint.
    /// </summary>
    private (DateTimeOffset start, TimeSpan length) ResolveTrialWindow(LicenseRecord record)
    {
        if (!string.IsNullOrWhiteSpace(record.TrialToken) && _verifier is not null)
        {
            TrialClaims? claims = _verifier.VerifyTrial(record.TrialToken);
            if (claims is not null &&
                claims.Type == "trial" &&
                string.Equals(claims.Fingerprint, _fingerprintProvider(), StringComparison.OrdinalIgnoreCase))
            {
                int days = claims.TrialDays > 0 ? claims.TrialDays : (int)TrialLength.TotalDays;
                return (claims.TrialStartUtc, TimeSpan.FromDays(days));
            }
        }

        return (record.FirstLaunchUtc, TrialLength);
    }

    private LicenseSnapshot BuildLicensedSnapshot(LicenseRecord record, DateTimeOffset now)
    {
        // Re-verify the stored token's signature on every read. A tampered token, a token for a
        // different machine, or a mismatched public key all collapse to Invalid here.
        LicenseClaims? claims = _verifier?.Verify(record.SignedToken);
        if (claims is null)
        {
            return new LicenseSnapshot(LicenseStatus.Invalid, TimeSpan.Zero, record.Owner,
                "The stored license token is invalid. Please re-activate.", LicenseEntitlements.Free);
        }

        string currentFp = _fingerprintProvider();
        if (!string.Equals(claims.Fingerprint, currentFp, StringComparison.OrdinalIgnoreCase))
        {
            return new LicenseSnapshot(LicenseStatus.Invalid, TimeSpan.Zero, record.Owner,
                "This license is bound to a different machine.", LicenseEntitlements.Free);
        }

        LicenseEntitlements entitlements = EntitlementsFromClaims(claims);

        if (now < claims.ExpiresAt)
        {
            return new LicenseSnapshot(LicenseStatus.Activated, claims.ExpiresAt - now, claims.Owner, null, entitlements);
        }

        // Token has expired: the client must re-validate online. Allow a grace window offline.
        TimeSpan sinceExpiry = now - claims.ExpiresAt;
        if (sinceExpiry < GracePeriod)
        {
            return new LicenseSnapshot(LicenseStatus.Grace, GracePeriod - sinceExpiry, claims.Owner,
                "Your license needs to re-validate online. Connect to the internet to continue.", entitlements);
        }

        return new LicenseSnapshot(LicenseStatus.Expired, TimeSpan.Zero, claims.Owner,
            "Your license could not be re-validated. Please connect and re-activate.", LicenseEntitlements.Free);
    }

    private static bool ContainsRevocation(string message)
    {
        return message.Contains("revoked", StringComparison.OrdinalIgnoreCase)
            || message.Contains("suspended", StringComparison.OrdinalIgnoreCase)
            || message.Contains("banned", StringComparison.OrdinalIgnoreCase);
    }
}
