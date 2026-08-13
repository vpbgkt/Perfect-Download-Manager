using System.Buffers;
using System.Threading.Channels;
using Microsoft.Win32.SafeHandles;

namespace PDM.Core.Downloading;

/// <summary>
/// A single unit of work handed from a network reader to the disk writer: a rented buffer to be
/// written at an absolute file offset. The buffer belongs to the shared array pool and is returned by
/// the writer once written, so producers must not touch it after enqueuing.
/// </summary>
internal readonly struct WriteChunk
{
    public WriteChunk(int segmentIndex, long offset, byte[] buffer, int length)
    {
        SegmentIndex = segmentIndex;
        Offset = offset;
        Buffer = buffer;
        Length = length;
    }

    public int SegmentIndex { get; }
    public long Offset { get; }
    public byte[] Buffer { get; }
    public int Length { get; }
}

/// <summary>
/// Decouples network reads from disk writes. Network connections (producers) read from their sockets
/// into pooled buffers and hand them to this queue; a pool of writer tasks drains the queue to the
/// output file at the correct offsets. This is the key to stable, high download speed:
///
/// <para><b>Why decoupling.</b> Disks accept writes in bursts (the OS write cache fills, then flushes).
/// If a connection wrote inline it would stall on every flush and its socket would go idle, producing a
/// "speed drops to 0 then spikes" sawtooth and false "waiting for server" states. Buffering writes in
/// memory (bounded) lets connections keep draining their sockets continuously.</para>
///
/// <para><b>Why several writers.</b> A single writer awaiting one positional write at a time
/// keeps only ONE I/O in flight, so its ceiling is chunk-size ÷ write-latency — around
/// 100-250 MB/s on typical storage regardless of how fast the network is. On a fast link that made the
/// writer, not the network, the bottleneck: throughput peaked then collapsed to KB/s every time the
/// bounded queue filled and blocked every reader. Issuing several writes concurrently raises the I/O
/// queue depth so fast NVMe/premium storage can be saturated, which both raises peak speed and stops
/// the queue from filling in the first place.</para>
///
/// <para><b>Durable-offset correctness with parallel writes.</b> Concurrent writes can complete out of
/// order, so a segment's durable (resume) offset must not simply jump to the newest completion — that
/// would claim bytes as safe while an earlier chunk was still in flight, and a crash at that moment
/// would leave a hole. Completions are therefore accounted per segment and the durable offset advances
/// only across a <em>contiguous</em> prefix; out-of-order completions are held until the gap before them
/// is filled. The out-of-order window is at most the writer count, so this stays tiny.</para>
/// </summary>
internal sealed class DiskWriteQueue : IAsyncDisposable
{
    private readonly SafeFileHandle _handle;
    private readonly Channel<WriteChunk> _channel;
    private readonly Task[] _writerTasks;

    // Invoked after a segment's contiguous durable prefix advances: (segmentIndex, newDurableLength).
    private readonly Action<int, long> _onDurableAdvanced;

    // Per-segment contiguous write accounting, guarded by _accountingLock.
    private readonly Dictionary<int, SegmentWriteAccount> _accounts = new();
    private readonly object _accountingLock = new();

    private Exception? _failure;

    public DiskWriteQueue(
        string path, int capacity, int writerCount, Action<int, long> onDurableAdvanced)
    {
        _onDurableAdvanced = onDurableAdvanced;
        _handle = File.OpenHandle(
            path, FileMode.Open, FileAccess.Write, FileShare.ReadWrite, FileOptions.Asynchronous);

        _channel = Channel.CreateBounded<WriteChunk>(new BoundedChannelOptions(Math.Max(8, capacity))
        {
            SingleReader = false, // several writer tasks consume concurrently
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait, // producers wait for space => backpressure
        });

        int writers = Math.Max(1, writerCount);
        _writerTasks = new Task[writers];
        for (int i = 0; i < writers; i++)
        {
            _writerTasks[i] = Task.Run(WriterLoopAsync);
        }
    }

    /// <summary>The first write failure observed, if any. Non-null means the download must fail.</summary>
    public Exception? Failure => _failure;

    /// <summary>
    /// Registers the byte offset a segment's writes start from, so contiguous accounting knows where the
    /// durable prefix begins. Must be called before any chunk for that segment is enqueued.
    /// </summary>
    public void BeginSegment(int segmentIndex, long segmentStart, long alreadyDurableLength)
    {
        lock (_accountingLock)
        {
            _accounts[segmentIndex] = new SegmentWriteAccount(segmentStart, alreadyDurableLength);
        }
    }

    /// <summary>
    /// Hands a chunk to the writers, awaiting queue space when the disk is behind (backpressure). If a
    /// write has already failed, the buffer is returned and the failure is surfaced immediately so the
    /// producer stops reading.
    /// </summary>
    public async ValueTask EnqueueAsync(WriteChunk chunk, CancellationToken cancellationToken)
    {
        if (_failure is not null)
        {
            ArrayPool<byte>.Shared.Return(chunk.Buffer);
            throw AsDownloadException(_failure);
        }

        await _channel.Writer.WriteAsync(chunk, cancellationToken).ConfigureAwait(false);
    }

    private async Task WriterLoopAsync()
    {
        try
        {
            await foreach (WriteChunk chunk in _channel.Reader.ReadAllAsync().ConfigureAwait(false))
            {
                // Once a failure occurs, keep draining the channel only to return buffers to the pool.
                if (_failure is not null)
                {
                    ArrayPool<byte>.Shared.Return(chunk.Buffer);
                    continue;
                }

                try
                {
                    await RandomAccess
                        .WriteAsync(_handle, chunk.Buffer.AsMemory(0, chunk.Length), chunk.Offset)
                        .ConfigureAwait(false);

                    NoteCompleted(chunk.SegmentIndex, chunk.Offset, chunk.Length);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    _failure = ex;
                }
                finally
                {
                    ArrayPool<byte>.Shared.Return(chunk.Buffer);
                }
            }
        }
        catch (Exception ex)
        {
            _failure ??= ex;
        }
    }

    /// <summary>
    /// Records a completed write and advances the segment's durable prefix if this completion (plus any
    /// previously held out-of-order completions) extends it contiguously.
    /// </summary>
    private void NoteCompleted(int segmentIndex, long offset, int length)
    {
        long advancedTo;
        lock (_accountingLock)
        {
            if (!_accounts.TryGetValue(segmentIndex, out SegmentWriteAccount? account))
            {
                return; // unknown segment (should not happen); nothing to account
            }

            if (!account.Add(offset, length, out advancedTo))
            {
                return; // held as out-of-order; durable prefix unchanged
            }
        }

        _onDurableAdvanced(segmentIndex, advancedTo);
    }

    /// <summary>
    /// Signals no more chunks will be enqueued and waits for every queued write to reach disk. Throws
    /// if any write failed. Call at a round boundary once all producers have stopped, so the durable
    /// offset reflects everything that was read.
    /// </summary>
    public async Task CompleteAndDrainAsync()
    {
        _channel.Writer.TryComplete();
        await Task.WhenAll(_writerTasks).ConfigureAwait(false);
        if (_failure is not null)
        {
            throw AsDownloadException(_failure);
        }
    }

    public async ValueTask DisposeAsync()
    {
        _channel.Writer.TryComplete();
        try
        {
            await Task.WhenAll(_writerTasks).ConfigureAwait(false);
        }
        catch
        {
            // Best-effort on dispose; failures are surfaced via CompleteAndDrainAsync on the normal path.
        }

        _handle.Dispose();
    }

    private static DownloadException AsDownloadException(Exception inner) =>
        inner as DownloadException
        ?? new DownloadException(
            "Unable to write data to disk. Please check available storage and permissions.", inner);

    /// <summary>
    /// Tracks one segment's contiguous written prefix, holding completions that arrive out of order
    /// until the bytes before them land. Keeps the persisted resume offset truthful when several writes
    /// are in flight at once.
    /// </summary>
    private sealed class SegmentWriteAccount
    {
        private readonly long _segmentStart;
        private readonly List<(long Offset, int Length)> _pending = new();
        private long _durableLength;

        public SegmentWriteAccount(long segmentStart, long alreadyDurableLength)
        {
            _segmentStart = segmentStart;
            _durableLength = alreadyDurableLength;
        }

        /// <summary>
        /// Adds a completed write. Returns true (with the new durable length) when the contiguous prefix
        /// advanced, false when the completion was held pending an earlier gap.
        /// </summary>
        public bool Add(long offset, int length, out long durableLength)
        {
            long relative = offset - _segmentStart;
            if (relative != _durableLength)
            {
                _pending.Add((offset, length)); // out of order: hold until the gap is filled
                durableLength = _durableLength;
                return false;
            }

            _durableLength = relative + length;

            // Absorb any held completions that now connect to the prefix.
            bool merged = true;
            while (merged && _pending.Count > 0)
            {
                merged = false;
                for (int i = 0; i < _pending.Count; i++)
                {
                    if (_pending[i].Offset - _segmentStart == _durableLength)
                    {
                        _durableLength += _pending[i].Length;
                        _pending.RemoveAt(i);
                        merged = true;
                        break;
                    }
                }
            }

            durableLength = _durableLength;
            return true;
        }
    }
}
