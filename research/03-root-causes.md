# 3. Root causes in PDM 1.3.2

Seven problems were found. R1-R4 explain the four reported symptoms. R5 is a capability that became
necessary once R1 was fixed. R6 is a correctness issue found during the audit. R7 is a write-path
inefficiency found while investigating CPU use.

| | Problem | Symptoms | How it was established |
|---|---|---|---|
| R1 | Connections opened too slowly, often never all opened | Lower speed, unstable speed | Lab A, B, C request logs |
| R2 | Connections that finished early quit | Slow end of download | Lab A and C timelines |
| R3 | Split rule based on bytes, far too coarse | KB/s at 90-99% | Lab C |
| R4 | Dead connections held for 60 s | 0 B/s near the end | Lab D |
| R5 | No handling of per-client connection limits | Very slow downloads on some servers | Real server (Hetzner), then lab E |
| R6 | Resume offset could run ahead of written bytes | Possible silent corruption after a crash | Code review |
| R7 | Every 8 KiB read became its own disk write | High CPU; speed dips on brief disk stalls | Diagnostic harness, CPU measurement |

---

## R1. Connections opened too slowly, and often never all opened

**What the code did.** `DownloadWorker` started a download with `InitialConnections = 2` and ran a
"probe" (`ProbeConnectionsAsync`): every `RampUpInterval` (2 s) it added one connection, measured the
written bytes over the next 2 s, and kept going only if throughput rose by at least 15%
(`ThroughputGainThreshold = 1.15`). The first time a step fell short, probing stopped for good.

**Why it fails.**

1. **The target is unreachable in theory.** With connections of equal speed, going from 7 to 8 adds
   1/7 = 14.3%, below the 15% bar. Even on a perfect link the probe cannot legitimately reach the default
   of 8.
2. **A new connection is judged while it is still starting.** For the 2 s after it is added, a
   connection is doing its TCP and TLS handshakes and then TCP slow start. Its contribution is
   systematically under-measured.
3. **One bad reading is final.** Real throughput varies by tens of percent from second to second. A
   single low sample stopped the probe permanently.

**Evidence.**

| Scenario | Connections reached | Time to reach them |
|---|---|---|
| A clean | 8 (by luck of noise) | 14.75 s; the first 14 s averaged about 11 MiB/s |
| B noisy | **6**, never 8 | Never |
| C degraded | **3** for the whole download | Never: the third connection happened to be a slow one, so adding it "didn't help" |

**Why it causes instability too.** With fewer connections, each packet loss on one connection (which
halves that connection's sending rate) removes a larger share of the total. The steady-state variation of
the 1-second speed was 27.7% for 1.3.2 against 8.1% for IDM in scenario A.

## R2. Connections that finished early quit instead of helping

**What the code did.** When a connection finished its range it called `TryClaimWork()`. If nothing was
worth splitting **at that instant**, it returned `null` and the connection's worker **exited for the rest
of the round**.

**Why it fails.** Whether a split is worthwhile changes by the second as other connections slow down,
stall or finish. A connection that left could not come back. Concurrency therefore decayed monotonically
at the end of every download (8, then 3, then 1 in scenario A), and the download finished on whichever
connection was slowest.

**Evidence.** Scenario A: the last 10% ran at 10.0 MiB/s and the last 1% at 3.2 MiB/s, while IDM held
18.7 and 12.5. Only 2 splits happened in the whole download.

## R3. The split rule was based on bytes, and far too coarse

**What the code did.** A split required the victim to have at least
`2 x max(MinSplitSize = 4 MiB, MinSplitDuration (5 s) x per-connection speed)` left, which is about 10
seconds of transfer. The victim was the segment with the most **bytes** left.

**Why it fails.**

* A slow connection with fewer bytes left can finish much later than a fast one with more. Choosing by
  bytes picks the wrong victim.
* "10 s of transfer at the average speed" is computed with the *average* speed, so a range on a very slow
  connection that would take minutes still looked "too small to split".

**Evidence.** Scenario C: a 16 MiB remainder on a 100 KB/s connection was never split. The download sat
between 90% and 99% for **160 s at 90-130 KB/s**, the reported "KB/s near the end" symptom exactly. IDM
splits down to about 130 KB.

## R4. Dead connections were held for 60 seconds

**What the code did.** A per-read watchdog (`StallTimeout = 60 s`) was the only defence against a
connection that stays open but stops sending.

**Evidence.** Scenario D: near the end the download sat at **0 B/s for about 45 s** until the watchdog
fired. IDM abandons a silent connection after about 17-18 s, and in its case other connections keep
working meanwhile.

## R5. No handling of servers that limit connections per client

**Found on a real server.** After R1 was fixed (all 8 connections open at once), a 1 GiB download from
Hetzner's speed-test mirror took **270 s** against IDM's 105 s. The diagnostic harness showed why: 493 of
536 requests were answered `429 Too Many Requests`. The mirror accepted 2 connections per client.

**What went wrong.**

1. The 6 refused connections were treated as ordinary transient errors: retry after 1, 2, 4, 8, 10 s.
2. After 5 retries a connection retired and released its segment, which idle workers (kept alive by the R2
   fix) immediately re-claimed, and were refused again.
3. Segments sitting in retry back-off looked stalled, so idle connections "took them over" with yet more
   requests, and split the one connection that was working into ever smaller pieces.

The result was about 2 refused requests per second for the whole download, and the server answered by
slowing down the connections it had accepted.

**Why 1.3.2 did not show it.** 1.3.2 started with 2 connections, which happened to be the server's
limit. That was luck, not design: with any limit below 2, or with the probe adding a third connection,
the same retry pattern appeared.

**Reproduced in the lab** (scenario E): 142 refused requests for the intermediate build, against 23 for IDM
and 6 for 1.3.2.

## R6. The resume offset could run ahead of the written bytes

**What the code did.** `DiskWriteQueue.BeginSegment(index, start, alreadyDurable)` was called at the start
of every transfer attempt, and it **replaced** the segment's write accounting with a new one starting at
the attempt's **read** position.

**Why it is wrong.** Chunks from the previous attempt could still be queued or being written. The new
accounting claimed them as durable before they were on disk. Had PDM crashed in that window, the persisted
resume offset would have skipped unwritten bytes, and because the part file is sparse those bytes would
read back as zeros: a silently corrupt file. The window was small (retries back off for at least a
second), but this is the worst kind of failure for a download manager.

## R7. Every 8 KiB read became its own disk write

**Found with the diagnostic harness.** WinHTTP returns **exactly 8 KiB per read**: 128 reads per MiB,
both on the lab link and on the internet. `WinHttpHandler`'s response stream first asks WinHTTP how much
data is available, then reads at most that much, and WinHTTP makes 8 KiB available at a time.

**What the code did.** Each read was handed to the disk writer as its own `WriteChunk`, in its own
512 KiB pooled buffer. Three consequences:

1. **CPU**: one queue operation, one asynchronous disk write and one 512 KiB pool rental per 8 KiB, about
   2,500 of each per second at 20 MiB/s. Measured: 20-21.5 s of CPU per 600 MiB, 3.3 times IDM's 6.3 s.
2. **A 64 times smaller disk-stall buffer.** The write queue holds `MaxBufferedBytes / ReadBufferSize`
   = 128 MiB / 512 KiB = 256 chunks. With 8 KiB chunks that is **2 MiB of data instead of the intended
   128 MiB**: about 0.1 s of a 20 MiB/s download. Any disk pause longer than that (an operating-system
   cache flush, an antivirus scan) blocked every connection's reads, which users see as a speed dip.
3. **Memory waste.** Each 8 KiB of data pinned a 512 KiB array while queued.

The second point was established from the code and the measured read size. It was not reproduced
against a slow disk, because the test machine only has an NVMe SSD (see
[limitations](09-limitations-and-next-steps.md)).

---

## Ruled out

| Suspect | Why it is not the cause |
|---|---|
| Socket options / TCP tuning | IDM sets none (no `setsockopt` import). PDM reached the full lab line rate once it had 8 connections |
| TLS / WinHTTP throughput | Same as above; after R7 the engine moved 567-584 MiB/s on an unthrottled loopback link |
| Disk throughput | Even before R7 the write path sustained the full line rate on the test machine. R7 was CPU and buffering, not disk speed |
| Final file assembly | PDM finishes about 0.2-0.3 s after the last byte (verification and an atomic rename) |
| Periodic dips every 8-9 s in lab timelines | Identical for IDM and PDM; they come from the lab server (Node.js) itself |
| The UI's speed smoothing | Purely display-side; the engine's throughput was measured on the server |
