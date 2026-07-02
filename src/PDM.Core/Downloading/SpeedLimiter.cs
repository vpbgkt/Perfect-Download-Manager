using System.Diagnostics;

namespace PDM.Core.Downloading;

/// <summary>
/// A thread-safe token-bucket rate limiter shared across the segments of a download.
/// Segments call <see cref="ThrottleAsync"/> after each read; when the configured
/// rate is exceeded the call asynchronously delays to smooth the transfer to the cap.
/// A limit of zero disables throttling entirely (no allocations, no waiting).
/// </summary>
public sealed class SpeedLimiter
{
    private readonly long _bytesPerSecond;
    private readonly double _ticksPerByte;
    private readonly object _gate = new();
    private long _availableTicks;
    private long _lastTimestamp;

    /// <summary>
    /// Creates a limiter capped at <paramref name="bytesPerSecond"/>. A value of zero
    /// or less means unlimited.
    /// </summary>
    public SpeedLimiter(long bytesPerSecond)
    {
        _bytesPerSecond = bytesPerSecond;
        if (bytesPerSecond > 0)
        {
            _ticksPerByte = (double)Stopwatch.Frequency / bytesPerSecond;
            _lastTimestamp = Stopwatch.GetTimestamp();
            // Allow a modest initial burst (~50 ms worth) to avoid choppy starts.
            _availableTicks = Stopwatch.Frequency / 20;
        }
    }

    /// <summary>True when this limiter enforces a cap.</summary>
    public bool IsEnabled => _bytesPerSecond > 0;

    /// <summary>
    /// Accounts for <paramref name="byteCount"/> transferred bytes and, if the bucket
    /// is exhausted, asynchronously waits until enough capacity has accrued.
    /// </summary>
    public async ValueTask ThrottleAsync(int byteCount, CancellationToken cancellationToken)
    {
        if (!IsEnabled || byteCount <= 0)
        {
            return;
        }

        TimeSpan delay;
        lock (_gate)
        {
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
