# 4. Implementation

All engine changes are in [`DownloadWorker.cs`](../src/PDM.Core/Downloading/DownloadWorker.cs), with a
small change in [`DiskWriteQueue.cs`](../src/PDM.Core/Downloading/DiskWriteQueue.cs) and option changes in
[`DownloadOptions.cs`](../src/PDM.Core/Models/DownloadOptions.cs). Line numbers below are from the time
of writing.

## 4.1 How a download runs now

```
RunAsync
 └─ round (normally exactly one)
     ├─ DiskWriteQueue: bounded channel of chunks, 4 parallel writers into the .pdmdownload file
     ├─ progress loop (every 500 ms): durable bytes, UI speed, per-connection speed sampling
     └─ N workers started at once (N = min(incomplete segments, MaxConnections)), each looping:
          TryClaimWork ─ needs a connection slot ─┬─ claim an unstarted or released segment
                                                  └─ or take over part of an in-flight segment
          DownloadSegmentAsync ─ retries, back-off, takeover/cancel handling
              TransferSegmentAsync ─ one HTTP range request; gather reads; hand 512 KiB chunks to the writer
          nothing to take? wait 200 ms and look again; leave only when every byte has been read
```

## 4.2 All connections start immediately (fixes R1)

[`RunAsync`](../src/PDM.Core/Downloading/DownloadWorker.cs#L318) now starts every worker of the round at
once:

```csharp
var workerTasks = new List<Task>(workers);
for (int i = 0; i < workers; i++)
{
    workerTasks.Add(RunWorkerAsync());
}
await Task.WhenAll(workerTasks).ConfigureAwait(false);
```

`ProbeConnectionsAsync`, `ThroughputGainThreshold` and the options `InitialConnections` and
`RampUpInterval` were removed rather than kept as dead configuration.

**Why not keep some form of probing?** The probe existed to protect servers that dislike many
connections. That concern is real, but probing by throughput is the wrong tool (see R1). A server that
dislikes connections says so by refusing them, and that is now handled directly by connection admission
(section 4.6). IDM, the reference the users compare against, opens its 8 connections within about 2 s.

## 4.3 Workers stay available until the end (fixes R2)

[`RunWorkerAsync`](../src/PDM.Core/Downloading/DownloadWorker.cs#L251):

```csharp
while (true)
{
    DownloadSegment? current = TryClaimWork();
    if (current is null)
    {
        if (AllRangesRead())
        {
            return;               // every byte of the file has been read: this worker is done
        }

        await Task.Delay(IdlePollInterval, faultCts.Token).ConfigureAwait(false);   // 200 ms
        continue;                 // look again: a split that was not worth it may be worth it now
    }
    ...
}
```

`AllRangesRead()` uses the **read cursor**, not the durable offset, so a worker does not wait for disk
writes it has no part in. The poll is cheap: it takes the plan lock for a scan of at most a few hundred
segments, five times a second, and only while a worker has nothing to do (in practice only at the very end).

## 4.4 Rate-aware takeover (fixes R3)

[`ClaimOrSplitLocked`](../src/PDM.Core/Downloading/DownloadWorker.cs#L532) runs under the plan lock and
hands the calling worker its next piece of work.

**Step 1, claim an unstarted segment.** Any segment that is not yet fully read and not claimed: a segment
of the initial plan, or one released by a connection that retired or was refused. This costs no extra
split, so it is always preferred.

**Step 2, take over part of the in-flight segment that will finish last.** For each claimed segment the
scheduler knows its remaining bytes (from the read cursor) and its connection's measured speed. The victim
is the segment with the **latest expected finish**, `remaining / speed`, not the most bytes.

Speeds are measured by [`SampleSegmentRates`](../src/PDM.Core/Downloading/DownloadWorker.cs#L864) every
progress tick (500 ms), as a moving average (`0.5 * new + 0.5 * old`) of the bytes each connection
**received** in that interval (see section 4.8 for why "received" and not "handed over").

A connection that started less than `warmUp = max(1.5 s, 4 x L)` ago is still connecting or in TCP slow
start, so its own measurement is not trusted yet: it is assumed to run at the typical speed (the average
of the measured connections). Before any connection has been measured at all, every connection is assumed
to run at the same nominal speed, which makes the rule degrade to "split the largest remaining range in
half", which is what IDM does.

### Where to split

Let `R` be the victim's remaining bytes, `v` its speed, `t` the speed expected for the new connection
(the typical speed), and `L` the measured request round trip (time from sending a request to receiving its
headers, smoothed). The victim keeps `keep` bytes and the new connection takes `R - keep`. Both should
finish at the same moment, the new connection paying one round trip first:

```
keep / v  =  L + (R - keep) / t
=>  keep  =  v (L t + R) / (t + v)
```

In code ([line 639](../src/PDM.Core/Downloading/DownloadWorker.cs#L639)):

```csharp
double x = v * (latency * t + victimRemaining) / (t + v);
keep = (long)Math.Clamp(x, 1, victimRemaining);

double saved = (victimRemaining / v) - (keep / v);
if (saved <= latency || victimRemaining - keep < _options.MinSplitSize)
{
    return null;    // not worth a request
}
```

The split is made only when it **saves more than one round trip** and hands over at least
`MinSplitSize` (128 KiB, down from 4 MiB).

**Worked examples** (L = 0.3 s):

| Situation | Result |
|---|---|
| Equal speeds, v = t = 2.5 MB/s | Split only while R > 3 L t = 2.25 MB (about 0.9 s of work). Below that, idle connections wait; the end of the download is no longer churned into tiny requests |
| Slow victim, v = 0.1 MB/s, t = 3 MB/s, R = 16 MB | The victim keeps about 545 KB (5.5 s at its speed); the new connection takes about 15.5 MB (5.2 s plus the round trip). The case that took 160 s in 1.3.2 |
| Victim with nothing measured yet, no connection measured yet | Nominal equal speeds: roughly halves the range, like IDM |

### Why the split is safe

* A segment's end only ever moves **backwards**, and never below the victim's read cursor.
* The new segment is fully formed before the victim's end is moved, and the plan list is replaced
  copy-on-write, so readers (the UI, the progress loop) always see a complete plan.
* The victim re-reads its end every time it hands bytes to the writer and **clamps** to it
  (section 4.8), so no byte past a moved end is ever written by the victim.
* In the instant between a hand-over computing its limit and the end moving, the victim may still write
  a few bytes that now belong to the new connection. Both write identical bytes from the same file
  (`If-Range` validated), so the data is the same; the durable counts are clamped to each segment's length
  so nothing is double-counted.
* At the end, [`VerifyTransferCompleteness`](../src/PDM.Core/Downloading/DownloadWorker.cs#L1443) checks
  that every segment is complete and that the segments tile the file exactly once. It skips empty
  segments (a stalled connection whose whole range was handed over before it delivered a byte).

**Segment budget.** Repeated splitting creates segments; their number is capped at
`initial + max(32, 16 x MaxConnections)`, at most 512, which also bounds the persisted state.

## 4.5 Stalled connections are taken over (fixes R4)

Each connection records `WaitingSince`: the moment it started waiting **on the server**. It is set when a
request is sent and before every network read, and cleared as soon as data arrives:

```csharp
Interlocked.CompareExchange(ref activity.WaitingSince, Stopwatch.GetTimestamp(), 0);  // before a read
read = await network.ReadAsync(...);
Interlocked.Exchange(ref activity.WaitingSince, 0);                                    // data arrived
```

Time spent handing data to a busy disk writer or waiting on a speed limit is **not** counted, so a
throttled or disk-bound connection is never mistaken for a dead one. A connection is **stalled** when it
is past its warm-up and has been waiting for `max(3 s, 8 x L)`. A stalled victim keeps nothing: the new
connection takes everything it has not read, and the victim's transfer is cancelled through a per-claim
`CancellationTokenSource` (`activity.Preempt`), so its worker is free at once instead of sitting in a
dead read, or a retry back-off, until the watchdog fires.

**Only stalled connections are ever cancelled.** A connection that is slow but delivering keeps at least
one byte of its range (`Math.Clamp(x, 1, ...)`) and finishes normally.

The per-read watchdog remains as the last line of defence, now `StallTimeout = 20 s` (IDM: about 17-18 s).
A download that cannot resume by range keeps at least 60 s, because a retry restarts it from byte 0.

## 4.6 Connection admission (fixes R5)

A worker needs one of `_connectionLimit` slots before it may claim or split work
([`TryReserveConnectionLocked`](../src/PDM.Core/Downloading/DownloadWorker.cs#L752)). The limit starts at
`MaxConnections`. When a request is answered `429` or `503`
([`TryRecordRefusal`](../src/PDM.Core/Downloading/DownloadWorker.cs#L792)):

1. If this is the only connection in use, it is not a connection limit; it is retried like any transient
   error.
2. Otherwise the limit drops by at least one (`min(limit - 1, inUse - 1)`), and the refused worker throws
   `ConnectionRefusedException`, hands its segment back with its progress intact, releases its slot, and
   parks. A connection that **is** allowed picks the segment up later.
3. Refusals that arrive together (within `max(1 s, 2 x L)`) are one answer from the server: they all lower
   the limit, but the retry timer and back-off are updated only once. (A first version doubled the
   back-off for each refusal of a burst; see [05](05-bugs-found-during-implementation.md#2-a-burst-of-refusals-was-counted-six-times).)
4. After `RefusedConnectionRetryDelay` (8 s) one extra connection is allowed (marked `AboveLimit`). If it
   is refused, the limit goes back down and the delay doubles: 8, 16, 32, up to 64 s. If it is accepted,
   the higher limit stays.
5. A refusal of a connection that was **inside** a limit the server has already accepted is treated as
   transient and retried, not as a new limit. This happens when a connection reconnects moments after its
   previous one closed and the server has not released it yet.

On a server that accepts 2 connections, a one-minute download now costs 9-10 refused requests: 6 when the
connections first open, then one probe at 8, 16 and 32 s. IDM sent 23-43.

Progress now reports `ActiveConnections` as the slots in use, so the popup shows `2 / 8 active` on such a
server instead of pretending all 8 are working.

## 4.7 Resume offset kept across retries (fixes R6)

[`DiskWriteQueue.BeginSegment`](../src/PDM.Core/Downloading/DiskWriteQueue.cs#L103) now **keeps** an
existing account for the segment when a transfer is retried or handed to another connection within the
same round. The account tracks contiguous completed writes, so chunks from the earlier attempt that are
still in flight are accounted for when they land. It is reset only when a segment genuinely restarts from
byte 0 (a single-stream download whose server ignored the range).

## 4.8 Read gathering (fixes R7)

[`TransferSegmentAsync`](../src/PDM.Core/Downloading/DownloadWorker.cs#L1011) now gathers reads into one
512 KiB pooled buffer and hands it to the writer
([`HandOverAsync`](../src/PDM.Core/Downloading/DownloadWorker.cs#L1280)) when any of these is true:

| Condition | Why |
|---|---|
| The space left could not take another read of the size just received | With WinHTTP's 8 KiB reads this means "full". It also avoids chopping reads into ever-smaller pieces to fill the last bytes (see [05](05-bugs-found-during-implementation.md#4-read-gathering-chopped-reads-into-tiny-pieces)) |
| The segment's range is complete | Nothing more to gather |
| The oldest gathered byte has waited 200 ms | Keeps progress, the resume offset and the scheduler's view current on slow connections |

Three rules keep it correct:

* **The read cursor advances only at hand-over.** Bytes still in a buffer are never counted as received.
  A takeover splits from the handed-over position; anything gathered beyond the new end is dropped at
  hand-over. Anything still buffered when a transfer fails or is cancelled is dropped and fetched again.
  A hole is impossible.
* **Hand-over clamps to the segment's current end**, re-read every time.
* **Buffer ownership is explicit.** The local reference is cleared before `HandOverAsync`, which owns the
  buffer from then on (the writer returns it to the pool; `EnqueueAsync` returns it itself on a write
  failure). A `finally` returns only a buffer that was never handed over, so no array is returned to the
  pool twice, which would let two readers share one array.

**Speed is measured on receipt.** A per-read counter (`activity.Received`) feeds the speed sampling,
because the read cursor now moves in 512 KiB steps. Sampled between hand-overs, a healthy connection would
look idle.

Effect: write calls and queue operations fall by 64 times; the write queue's 256 slots now hold up to the
intended 128 MiB instead of 2 MiB; CPU per byte falls about 2.6 times (see [results](06-results.md#cpu-and-memory)).

## 4.9 Options

| Option | Before | After |
|---|---|---|
| `MaxConnections` | 8 (ceiling of the probe) | 8 (all opened at once) |
| `InitialConnections` | 2 | removed |
| `RampUpInterval` | 2 s | removed |
| `MinSplitDuration` | 5 s | removed (replaced by the time-saved rule) |
| `MinSplitSize` | 4 MiB | 128 KiB |
| `StallTimeout` | 60 s | 20 s (at least 60 s for downloads that cannot resume) |
| `RefusedConnectionRetryDelay` | n/a | 8 s, doubling up to 8 times this |
| `ReadBufferSize` | 512 KiB per read (in practice 8 KiB) | 512 KiB per gathered disk write |

## 4.10 Alternatives considered and rejected

| Alternative | Why not |
|---|---|
| Tune socket buffers (`SO_RCVBUF`) | IDM doesn't, and the lab showed the socket layer reaching line rate. No evidence it would help |
| Keep the probe with a lower threshold | Still judges new connections during slow start and still stops for good on one bad sample |
| Copy IDM exactly (new TCP connection per split, open-ended ranges) | PDM's keep-alive reuse is cheaper per split, especially over TLS. IDM's weaknesses (C, E) would come along too |
| Race a duplicate request for the last piece (IDM's "alternative connection") | More complexity for a small gain; see [limitations](09-limitations-and-next-steps.md) |
| Replace slow connections mid-download | IDM doesn't either; the end-of-download takeover already rescues their ranges |
| Switch from `WinHttpHandler` to `SocketsHttpHandler` (larger reads, less CPU) | `WinHttpHandler` is kept deliberately for its TLS fingerprint (CDNs such as Cloudflare block the managed stack's); see `HttpClientProvider` |
| Hand each read to the writer, but raise the queue's chunk count | Fixes buffering but not the CPU cost of one write per 8 KiB |
