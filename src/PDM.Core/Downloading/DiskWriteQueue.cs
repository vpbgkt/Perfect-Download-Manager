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
/// into pooled buffers and hand them to this queue; a single dedicated writer (consumer) drains the
/// queue to the output file at the correct offsets. This is the key to stable download speed:
///
/// <para>Disks — especially throughput-limited cloud VM disks — accept writes in bursts (the OS write
/// cache fills, then flushes). If a connection wrote to disk inline it would stall on every flush and
/// its socket would go idle, producing the "speed drops to 0 then spikes" sawtooth and false
/// "waiting for server" states. By buffering writes in memory (bounded), the connections keep draining
/// their sockets continuously while the writer absorbs the disk's burstiness, so the observed network
/// speed stays smooth. When the disk genuinely cannot keep up, the bounded queue applies clean
/// backpressure (producers await queue space) that paces every connection evenly instead of stalling
/// them one at a time into timeouts.</para>
///
/// <para>Writes use <see cref="RandomAccess"/> against one shared file handle (no per-connection
/// FileStream, no seeks), and the single-reader writer serialises them, so ordering within a segment
/// is preserved and the durable offset can be advanced safely.</para>
/// </summary>
internal sealed class DiskWriteQueue : IAsyncDisposable
{
    private readonly SafeFileHandle _handle;
    private readonly Channel<WriteChunk> _channel;
    private readonly Task _writerTask;

    // Invoked on the writer thread after each chunk is durably written to the OS: (segmentIndex,
    // absolute offset, length). Used to advance the download's durable/resume offset.
    private readonly Action<int, long, int> _onWritten;

    private Exception? _failure;

    public DiskWriteQueue(string path, int capacity, Action<int, long, int> onWritten)
    {
        _onWritten = onWritten;
        _handle = File.OpenHandle(
            path, FileMode.Open, FileAccess.Write, FileShare.ReadWrite, FileOptions.Asynchronous);

        _channel = Channel.CreateBounded<WriteChunk>(new BoundedChannelOptions(Math.Max(8, capacity))
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait, // producers wait for space => backpressure
        });

        _writerTask = Task.Run(WriterLoopAsync);
    }

    /// <summary>The first write failure observed, if any. Non-null means the download must fail.</summary>
    public Exception? Failure => _failure;

    /// <summary>
    /// Hands a chunk to the writer, awaiting queue space when the disk is behind (backpressure). If the
    /// writer has already failed, the buffer is returned and the failure is surfaced immediately so the
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
                    _onWritten(chunk.SegmentIndex, chunk.Offset, chunk.Length);
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
    /// Signals no more chunks will be enqueued and waits for every queued write to reach disk. Throws
    /// if any write failed. Call at a round boundary once all producers have stopped, so the durable
    /// offset reflects everything that was read.
    /// </summary>
    public async Task CompleteAndDrainAsync()
    {
        _channel.Writer.TryComplete();
        await _writerTask.ConfigureAwait(false);
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
            await _writerTask.ConfigureAwait(false);
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
}
