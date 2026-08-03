using System.Diagnostics;

namespace PDM.Core.Downloading;

/// <summary>
/// A thread-safe token-bucket rate limiter. A single instance can be shared across the segments of
/// one download <em>and</em> across many concurrent downloads to enforce a single aggregate cap —
/// callers invoke <see cref="ThrottleAsync"/> after each read and the call asynchronously delays to
/// smooth transfers to the configured rate. The cap can be changed at runtime via
/// <see cref="SetBytesPerSecond"/> (used to track a changing global speed setting without recreating
/// the limiter). A limit of zero disables throttling entirely: the fast path takes no lock, so an
/// unlimited limiter adds no measurable overhead.
/// </summary>
public sealed class SpeedLimiter
{
    private readonly object _gate = new();

    // Read on the lock-free fast path, so kept as a volatile flag rather than testing the long rate
    // (which is not guaranteed to read atomically on all platforms).
    private volatile bool _enabled;

    private long _bytesPerSecond;
    private double _ticksPerByte;
    private long _availableTicks;
    private long _lastTimestamp;

    /// <summary>
    /// Creates a limiter capped at <paramref name="bytesPerSecond"/>. A value of zero or less means
    /// unlimited (throttling disabled).
    /// </summary>
    public SpeedLimiter(long bytesPerSecond) => SetBytesPerSecond(bytesPerSecond);

    /// <summary>True when this limiter currently enforces a cap.</summary>
    public bool IsEnabled => _enabled;

    /// <summary>
    /// Updates the cap at runtime. Zero or less disables throttling. Shared instances use this to
    /// follow a changing global speed setting without being recreated. The token bucket is reset so a
    /// rate change (or a re-enable after being idle) never releases a large accumulated burst.
    /// </summary>
    public void SetBytesPerSecond(long bytesPerSecond)
    {
        if (bytesPerSecond < 0)
        {
            bytesPerSecond = 0;
        }

        lock (_gate)
        {
            // No-op when the cap is unchanged so routine re-syncs don't reset the token bucket.
            if (bytesPerSecond == _bytesPerSecond)
            {
                return;
            }

            if (bytesPerSecond > 0)
            {
                _bytesPerSecond = bytesPerSecond;
                _ticksPerByte = (double)Stopwatch.Frequency / bytesPerSecond;
                _lastTimestamp = Stopwatch.GetTimestamp();
                // Allow a modest initial burst (~50 ms worth) to avoid choppy starts.
                _availableTicks = Stopwatch.Frequency / 20;
                _enabled = true;
            }
            else
            {
                _bytesPerSecond = 0;
                _ticksPerByte = 0;
                _enabled = false;
            }
        }
    }

    /// <summary>
    /// Accounts for <paramref name="byteCount"/> transferred bytes and, if the bucket
    /// is exhausted, asynchronously waits until enough capacity has accrued.
    /// </summary>
    public async ValueTask ThrottleAsync(int byteCount, CancellationToken cancellationToken)
    {
        if (!_enabled || byteCount <= 0)
        {
            return;
        }

        TimeSpan delay;
        lock (_gate)
        {
            // The cap may have been disabled between the fast-path check and acquiring the lock.
            if (!_enabled)
            {
                return;
            }

            long now = Stopwatch.GetTimestamp();
            long elapsed = now - _lastTimestamp;
            _lastTimestamp = now;

            // Refill the bucket based on elapsed time, capped at one second of capacity.
            _availableTicks += elapsed;
            long maxTicks = Stopwatch.Frequency;
            if (_availableTicks > maxTicks)
            {
                _availableTicks = maxTicks;
            }

            long cost = (long)(byteCount * _ticksPerByte);
            _availableTicks -= cost;

            if (_availableTicks >= 0)
            {
                return;
            }

            double deficitSeconds = -_availableTicks / (double)Stopwatch.Frequency;
            delay = TimeSpan.FromSeconds(deficitSeconds);
        }

        if (delay > TimeSpan.Zero)
        {
            await Task.Delay(delay, cancellationToken).ConfigureAwait(false);
        }
    }
}
