# Download engine performance: root causes and fixes

This document records why PDM 1.3.2 downloaded slower and less steadily than Internet Download
Manager (IDM) 6.43 on the same connection, how that was established, what was changed, and how the
change was measured.

The full research (IDM investigation, measurement method, a code walkthrough, every result and the
bugs found along the way) is in [research/](../research/README.md).

**Reported symptoms**

1. Download speed drops during active downloads.
2. Speed is not stable: it dips and recovers, where IDM stays fast and flat.
3. Speed collapses to KB/s near 90-99%.
4. PDM reaches 13-16 MB/s where IDM reaches 18-20 MB/s on the same file and connection.

All four had the same origin: how the engine decides **how many connections to run and what each one
works on** (R1-R4). Real-internet testing then exposed a capability that matters as soon as connections
open promptly: respecting a server's per-client connection limit (R5). The audit of the write path found
a separate inefficiency (R7): every 8 KiB network read became its own disk write, which tripled CPU use
and shrank the buffer meant to ride out disk stalls to 1/64th of its intended size. Socket tuning and
final file assembly were audited and are not a cause (see [What was ruled out](#what-was-ruled-out)).

---

## How it was measured

### Lab link (reproducible, client-agnostic)

[`tools/netlab/labserver.mjs`](../tools/netlab/labserver.mjs) is an HTTP/1.1 range server that emulates a
WAN link and logs every request and connection. It serves deterministic content, so every download is
verified byte-for-byte. Throughput is measured on the server side, from the first request to the last
byte, so PDM and IDM are timed by exactly the same clock.

Link model used for every scenario: 600 MiB file, 20 MiB/s shared line, 3 MiB/s per TCP connection
(window/RTT-bound, the reason multi-connection downloading helps at all), 1 s slow-start ramp per new
connection, 150 ms connection setup, 50 ms per request.

| Scenario | What it adds | Models |
|---|---|---|
| A clean | nothing | a healthy server on a ~160 Mbit/s line |
| B noisy | each connection's speed re-drawn every 500 ms within ±50% | cross traffic, TCP sawtooth |
| C degraded | every 3rd new TCP connection is capped at 100 KB/s | a bad path or overloaded CDN node |
| D stalled | every 4th new TCP connection stops sending after 20 MiB, socket left open | a dead-but-open connection |
| E limited | server accepts 2 connections per client and answers the rest with 429; 5 MiB/s per connection | file hosts and mirrors with per-client connection caps |

```sh
node tools/netlab/labserver.mjs --port 8765 --path run1.bin --size 629145600 \
     --link 20971520 --perconn 3145728 --ramp 1 [--jitter 0.5 | --slowevery 3 --slowrate 102400 | --stallevery 4 --stallafter 20971520 | --maxconns 2 --perconn 5242880] \
     --log run1.jsonl
pdm http://127.0.0.1:8765/run1.bin <dir> --connections 8          # or: IDMan.exe /d <url> /p <dir> /f run1.bin /n
node tools/netlab/labserver.mjs --size 629145600 --verify <dir>/<file>
node tools/netlab/analyze.mjs run1.jsonl --timeline --ranges 40
```

Use a fresh `--path` for every run. The server answers anything else with 404 and logs it, so a client
still retrying an earlier run cannot skew a measurement.

### Real internet

1 GiB and 1000 MiB files from public mirrors that support range requests, downloaded by each client in turn while
the machine's network-adapter receive counters were sampled every 250 ms (a client-agnostic timeline that
also works for IDM, which writes into its own temporary folder). Each downloaded file was hashed and
compared across clients.

---

## IDM investigation

### Static (IDMan.exe 6.43 build 16, 32-bit)

* **Not packed.** Normal section layout and entropy; strings and imports are readable.
* **Own HTTP/FTP stack over raw Winsock.** `WS2_32.dll` is delay-loaded by ordinal: `socket`,
  `connect`, `ioctlsocket`, `select`, `recv`, `send`, `closesocket`, `getsockopt`,
  `gethostbyname`. TLS is done through Schannel/SSPI (`AcquireCredentialsHandle`,
  `InitializeSecurityContext`, `EncryptMessage`, `DecryptMessage`) or OpenSSL (`libssl.dll`). WinHTTP is
  imported only for proxy discovery (`WinHttpGetProxyForUrl`, `WinHttpGetIEProxyConfigForCurrentUser`).
* **No socket tuning.** Ordinal 21 (`setsockopt`) is not imported, so IDM never sets `SO_RCVBUF`,
  `SO_SNDBUF` or `TCP_NODELAY`; it relies on Windows receive-window auto-tuning like any other client.
  Its speed advantage therefore cannot come from the socket layer.
* **Engine structure**, from IDM's own diagnostic strings:
  `ChunksList::FindMaxFreeChunk()`, `ChunksList::NeedNewConnection()`, `Connection::OnChangeBounds()`
  (the end of a running connection's range is moved back when another connection takes part of it),
  `ChunksList::AddAlternative / CheckAlternative / ApplyAlternative` ("Add alternative connection (%ld)
  for connection %ld"), "Connection timed out, restarting...", and "Download complete, appending all
  downloaded parts into one file...". Default connection count is `MaxConnectionsNumber` = 8.
* **IPv4 only.** Names are resolved with `gethostbyname`, which returns IPv4 addresses only. On the test
  network one mirror (`speedtest.tele2.net`) was reachable only over IPv6; IDM timed out connecting
  (WSAETIMEDOUT) six times and gave up, while PDM, whose WinHTTP stack is dual-stack, downloaded it.

IDM writes a log for every download (`%APPDATA%\IDM\DwnlData\<user>\<name>_<id>\<name>_<id>.log`) with
per-connection events. It confirmed the two failures above and a third behaviour: when a server closes
the connection on IDM's first, range-less request, IDM reports "Cannot download this file" and does not
retry.

### Observed behaviour (lab scenario A)

| | IDM 6.43 | PDM 1.3.2 |
|---|---|---|
| First request | Plain GET from byte 0; data flows at once and the response doubles as the probe | Separate `bytes=0-0` probe, then data |
| Ramp-up | Each new connection takes half of the largest unfinished chunk: 4 connections at 0.5 s, 8 at 2.4 s | Fixed plan of 8 x 75 MiB; one connection added every 2 s; 8 reached at 14.8 s |
| Range requests | Open-ended (`start-EOF`); the connection stops reading at its current bound and closes | Closed (`start-end`) |
| Connection reuse | None: one request per TCP connection | Keep-alive reuse through WinHTTP |
| End of download | Keeps splitting down to about 130-170 KB pieces; 7-8 connections busy until the final second | Two splits in total, then idle connections quit; ended on a single connection |
| Dead connection | Abandoned after about 17-18 s | Abandoned after 60 s |
| Final file | Appends per-connection part files | Writes into one preallocated sparse file and renames it (no copy) |

---

## Root causes

### R1. Connections were opened too slowly, and often never all opened (symptoms 2, 4)

`DownloadWorker` started with 2 connections and added one every 2 s only if measured throughput rose by
at least 15%. In practice this failed in three ways:

* **It cannot reach the configured count even in theory.** Going from 7 to 8 equal connections adds
  14.3%, which is under the 15% bar.
* **Each new connection was judged during its own TCP slow start and TLS handshake,** so its
  contribution was systematically under-measured.
* **Once probing stopped it never resumed,** so one noisy reading capped the download for good.

Measured: 14.8 s to reach 8 connections on the clean link (scenario A), stuck at **6** on the noisy link
(B), stuck at **3** for the whole download when the third connection happened to be a slow one (C).
Fewer connections means lower aggregate speed. It also means each packet loss on one connection removes
a larger share of the total, which is the visible instability.

### R2. Connections that finished early quit instead of helping (symptom 3)

When a connection finished its range and found nothing worth splitting at that instant, it **exited for
the rest of the round**. A split that was not worthwhile one second earlier often became worthwhile
later, but no connection was left to take it, so concurrency decayed 8 -> 3 -> 1 over the last seconds
and the end of every download ran on whichever connection happened to be slowest.

### R3. The split rule was based on bytes and was far too coarse (symptom 3)

A split required the victim to have at least 2 x max(4 MiB, 5 s x per-connection speed) left, about
10 seconds of transfer, and the victim was chosen as the range with the most **bytes** left rather
than the one that would **finish last**. In scenario C a 16 MiB remainder on a 100 KB/s connection was
never split: the download sat at 90-99% for 160 s at 90-130 KB/s. IDM keeps splitting down to about
130 KB.

### R4. Dead connections were held for 60 seconds (symptom 3)

A connection whose socket stays open but stops sending held its range until the 60 s watchdog fired. In
scenario D the download sat at 0 B/s for about 45 s near the end.

### R5. Servers that limit connections per client (found in real-internet testing)

Many file hosts and mirrors cap concurrent connections per client and refuse the extra ones with
`429 Too Many Requests` or `503` (nginx `limit_conn`'s default). Hetzner's speed-test mirror accepted 2
of 8 connections and refused the other 6. 1.3.2 dodged most of this by accident, because it started with
2 connections. Opening all 8 at once exposed a real gap: refused connections were simply retried with
the normal back-off, then retired, then re-claimed by idle workers, while their ranges, idle during the
back-off, looked stalled and were "taken over" by yet more requests. One 1 GiB download sent **493
refused requests in 270 s** (IDM, connecting over IPv4: 105 s), and the server responded by slowing down
the connections it had accepted. The lab reproduces the request storm (scenario E: 142 refused
requests, against 23 for IDM).

### R6. Resume offset could run ahead of the written bytes (correctness, not speed)

`DiskWriteQueue.BeginSegment` reset a segment's contiguous-write account to the new attempt's **read**
position on every retry, while chunks from the previous attempt could still be in flight. A crash in
that window could persist a resume offset past unwritten bytes. Rare (retries back off for at least a
second), but a silent-corruption path.

### R7. Every 8 KiB read became its own disk write (CPU, and a 64x smaller disk-stall buffer)

WinHTTP returns exactly 8 KiB per read: 128 reads per MiB, measured on the lab link and on the internet.
PDM handed each read to the disk writer as a separate chunk, each in its own 512 KiB pooled buffer. That
cost one queue operation and one disk write per 8 KiB (about 2,500 of each per second at 20 MiB/s).
Worse, the write queue holds `MaxBufferedBytes / ReadBufferSize` = 256 chunks, so it could hold only
256 x 8 KiB = **2 MiB of data instead of the intended 128 MiB**: about 0.1 s of a 20 MiB/s download.
A disk pause longer than that (an OS cache flush, an antivirus scan) stops every connection's reads,
which shows up as a speed dip. Measured cost: 20-21.5 s of CPU per 600 MiB, 3.3x IDM's 6.3 s.

---

## Changes

Engine changes, all in `src/PDM.Core`. (Two display fixes outside the engine are described under
[Tests](#also-fixed-while-getting-the-suite-green).)

**`DownloadWorker`**

* **All connections open immediately** (R1). The probing controller
  (`ProbeConnectionsAsync`, `InitialConnections`, `RampUpInterval`) is removed. Servers that refuse
  some of them are handled by connection admission (below); a connection that keeps failing for other
  reasons still retires after its retries, and the next round runs with fewer.
* **Idle connections stay available** (R2). A worker with nothing to take waits 200 ms and looks again;
  it leaves only when every byte of the file has been read.
* **Rate-aware takeover** (R3). Each connection's speed is sampled every progress tick from the bytes
  it receives. A free connection picks the in-flight segment with the latest expected finish (remaining
  bytes / measured speed) and splits it so both connections are expected to finish together, allowing for
  the measured request round trip L:

  `keep / v = L + (remaining - keep) / t` -> `keep = v (L t + remaining) / (t + v)`

  where v is the victim's speed and t a typical connection's speed. A split is made only when it shortens
  the range's finish by more than L, and when it hands over at least `MinSplitSize` (now 128 KiB, down
  from 4 MiB). Equal-speed connections near the end are therefore left alone, while a range stuck
  behind a slow connection is always rescued. The old `MinSplitDuration` option is removed.
* **Stalled connections are taken over** (R4). A connection blocked on the server (waiting for a
  response, data, or a retry) for max(3 s, 8 L) after its warm-up is relieved of everything it has not
  read, and its in-flight transfer is cancelled so its worker is freed at once. Time spent waiting on the
  disk writer or a speed limit does not count, so a throttled or disk-bound connection is never
  mistaken for a dead one.
* **Connection admission** (R5). A worker needs one of `limit` connection slots to make requests or
  split work. When a request is refused with 429 or 503 while other connections are in use, the limit
  drops by one and the refused worker hands its range back and parks. Refusals that arrive together
  (one burst) count as one answer. After `RefusedConnectionRetryDelay` (8 s), one extra connection is
  tried; each time that try is refused the delay doubles, up to 64 s. A refusal of a connection inside a
  limit the server has already accepted (typically a reconnect a moment after the previous connection
  closed) is retried normally instead of lowering the limit. IDM spaces its retries of refused
  connections in a similar way (observed at roughly 4, 8 and 12 s).
* **Reads are gathered before they are written** (R7). Each connection fills its 512 KiB buffer and then
  hands it to the disk writer; it hands over earlier when its range is done, after 200 ms (so progress
  and the resume offset stay current on slow connections), or when the space left could not take
  another read of the size just received (so reads are never chopped into ever-smaller pieces). The
  read cursor advances only at hand-over, so bytes still in a buffer are never counted as received: a
  takeover or a cancellation can only drop them, to be fetched again, and never leave a hole. The
  scheduler measures each connection's speed on receipt, not at hand-over, so gathering does not make
  a healthy connection look idle.
* **Hand-overs are clamped to the segment's current end,** re-read every time, so a connection never
  passes bytes beyond a moved boundary to the writer. A split therefore needs no safety margin. Only a
  stalled connection is ever cut off completely and cancelled; one that is still delivering keeps at
  least one byte of its range and finishes normally.
* The stall watchdog (`StallTimeout`) defaults to **20 s** for range-capable downloads, close to IDM's
  measured 17-18 s. Downloads that cannot resume keep at least 60 s, because a retry restarts them from
  byte 0.
* Integrity verification skips empty segments (a range taken over before it read a byte), and durable
  byte counts are clamped to each segment's length.

**`DiskWriteQueue`**: `BeginSegment` keeps an existing account on retry or hand-over (R6) and resets it
only when a segment really restarts from byte 0.

**`DownloadOptions`**: `InitialConnections`, `RampUpInterval` and `MinSplitDuration` removed;
`MinSplitSize` 4 MiB -> 128 KiB; `StallTimeout` 60 s -> 20 s; `RefusedConnectionRetryDelay` (8 s) added.

Progress now reports `ActiveConnections` as the connections actually allowed to transfer, so a
connection-limited download shows, for example, `2/8`.

---

## Results

Every lab download below was verified byte-for-byte, and no run received a request from another client.
"n" is the number of runs averaged. Runs of different clients were interleaved.

### Lab: average speed (MiB/s) and total time

The "after this change" column is the final code (including read gathering, R7); an earlier build with
the same scheduler but without gathering measured the same within run-to-run noise.

| Scenario | PDM 1.3.2 | PDM after this change | IDM 6.43 |
|---|---|---|---|
| A clean | 15.24 (39.4 s), n=2 | **19.56 (30.7 s)**, n=3 | 18.98 (31.6 s), n=3 |
| B noisy | 14.72 (40.8 s), n=2 | **19.50 (30.8 s)**, n=2 | 18.99 (31.6 s), n=3 |
| C degraded | 2.31 (260.0 s), n=1 | **16.32 (36.8 s)**, n=2 | 5.55 (110.8 s; 89-131 s), n=3 |
| D stalled | 7.36 (81.6 s), n=2 | **18.37 (32.7 s)**, n=2 | 17.90 (33.5 s), n=3 |
| E limited (2 connections, 5 MiB/s each) | 9.88 (60.7 s), n=1 | 9.85 (60.9 s), n=2 | 9.30 (64.5 s), n=1 |

On a connection-limited server every client is held to the same 2 connections; PDM ties 1.3.2 within
noise and stays ahead of IDM. (With 3 MiB/s per connection: 5.95 / 5.96 / 5.77 MiB/s, same order.)

### Lab: the end of the download (MiB/s over the last 10% / last 1% of bytes)

| Scenario | PDM 1.3.2 | PDM after this change | IDM 6.43 |
|---|---|---|---|
| A clean | 10.03 / 3.23 | **20.99 / 35.61** | 18.69 / 12.52 |
| B noisy | 10.03 / 5.12 | **19.27 / 16.81** | 18.15 / 10.85 |
| C degraded | 0.35 / 0.10 | **9.43 / 1.70** | 1.00 / 0.80 |
| D stalled | 1.31 / 3.38 | 18.62 / **14.83** | **19.04** / 12.64 |
| E limited | 9.83 / 8.97 | 9.83 / **10.83** | 8.39 / 6.04 |

(A figure above the line rate means several connections were still delivering those final bytes
together. In D, IDM is marginally faster over the last 10%; PDM is faster over the last 1%.)

### Lab: stability, ramp-up and politeness

* **Time to reach line speed** (scenario A, first one-second interval averaging >= 18 MiB/s): it starts
  1-2 s after the first request for PDM now, 3-4 s for IDM and 11-12 s for 1.3.2.
* **Variation of the 1-second speed** during the steady part (coefficient of variation): 1.3.2 27.7%
  (A) and 26.1% (B); PDM now 9.0% and 8.6%; IDM 8.1% and 8.5%. The remaining variation is the same for
  both clients and comes from the lab server (a periodic dip every 8-9 s that appears in every client's
  timeline).
* **Refused requests on a connection-limited server** (scenario E): PDM now 9-10 in a one-minute
  download (6 when the connections first open, then one spaced retry after 8, 16 and 32 s); 1.3.2: 6;
  IDM: 23 (43 in the 100 s variant). The intermediate build without connection admission sent 142.

### Lab: CPU and memory

600 MiB at 20 MiB/s (scenario A); runs of the two PDM builds were alternated, because CPU time on this
machine varies by up to 50% between identical runs.

| | CPU time | Peak working set |
|---|---|---|
| PDM 1.3.2 | 14.2-22.3 s (n=3) | 52 MB |
| Same scheduler, without read gathering | 20.1-21.5 s (n=3) | 52 MB |
| PDM after this change | **7.8-8.5 s** (n=3) | 56-57 MB |
| IDM 6.43 | 6.3 s (n=1) | 44 MB (35 MB idle) |

With no link limit (1 GiB over loopback), PDM now downloads at 567-584 MiB/s using 3.6-4.1 s of CPU;
before read gathering it reached 388 MiB/s using 14.3 s, and IDM 409 MiB/s. CPU does not limit speed at
any realistic link speed.

### Real internet

All runs from one machine and network (about 200 ms from these European mirrors), 1 GiB or 1000 MiB
files, clients interleaved. "Wall" is the time from starting the client to the finished file, so it
includes start-up (PDM's command-line client: process start and the probe; IDM: command-line hand-off
and joining its part files). Every completed download of a file had the same SHA-256 across clients.

**Same network path, no connection limit:** BelWü mirror addressed by IPv4 literal
(`http://129.143.4.238/1G`), so both clients use the same route. Rounds 1-2 used the final scheduler
without read gathering; round 3 the final build.

| Round | PDM 1.3.2 | PDM after this change | IDM 6.43 |
|---|---|---|---|
| 1 | 89.3 s (11.20 MiB/s) | **82.8 s (12.08)** | 98.9 s (10.11) |
| 2 | 104.6 s (9.56) | **96.8 s (10.33)** | 130.4 s (7.67) |
| 3 | 90.8 s (11.01) | **72.5 s (13.79)** | 112.2 s (8.91) |
| Mean | 94.9 s (10.59) | **84.0 s (12.07)** | 113.8 s (8.90) |

PDM was fastest in every round: 11% less time than 1.3.2 and 26% less than IDM on average. This path
(about 12 MiB/s) is slower than the user's own line, so it understates the lab gains, where the bottleneck
is per-connection speed rather than the whole path.

**Same path, connection-limited server:** Hetzner's mirror by IPv4 literal (`http://78.46.170.2/1GB.bin`),
which accepts 2 connections per client. PDM after this change: 136.1 s (7.52 MiB/s); 1.3.2: 163.6 s
(6.26 MiB/s). IDM failed both attempts: the server closed the connection on IDM's first, range-less
request, and IDM gave up without retrying ("Cannot download this file").

**Host reachable only over IPv6 from this network** (`speedtest.tele2.net`): PDM after this change
85.5 s and 88.2 s (11.79 MiB/s mean); 1.3.2 104.6 s and 104.8 s (9.78 MiB/s), so 17% less time. IDM
could not connect (IPv4-only name resolution; see the IDM investigation).

**The connection-limit regression and its fix (R5)**, on the Hetzner mirror by host name: the build
before connection admission took 270 s and 294 s with 493 refused requests; with admission, 133.6 s with
14. These runs are not compared with IDM: by host name PDM connects over IPv6 and IDM over IPv4, which
are different routes (IDM: 104.8 s).

---

## Tests

* `DownloadSchedulerTests` (new, using the new `PacedHttpHandler` test server):
  * `AllConnections_OpenImmediately`: 8 connections open within 1 s.
  * `StalledConnection_IsTakenOver_LongBeforeStallTimeout` (stall after 0 bytes, and after 64 KiB):
    completes in seconds with a 60 s watchdog; the plan still tiles the file exactly.
  * `SlowConnection_RemainderIsRedistributed`: a 32 KiB/s connection's 1 MiB range is redistributed.
  * `ConnectionLimitedServer_SettlesOnAcceptedConnections_WithoutRetryStorm`: against a server that
    accepts 2 connections and answers the rest with 429, at most 12 requests are refused.

  The first four fail against the 1.3.2 engine (61 s, 61 s, never reaching 8 connections, 32 s). The
  last fails (36 refused requests) when refusal handling is disabled. All pass with the fix.
* The existing randomized chaos and soak suites (dropped connections, transient errors, ignored ranges,
  per-IP connection limits, repeated pause/resume) were updated for the removed options and accept
  empty segments in the tiling check. They pass unchanged otherwise: byte-identical output and an exact
  plan cover on every seed.
* The chaos suites also exercise read gathering: their server returns reads of random size, so gathered
  buffers are handed over full, part-full, at range ends and after drops. The first version of gathering
  made them 2.6x slower. The cause was reads being chopped into ever-smaller pieces to fill the last
  bytes of a buffer, now prevented by the hand-over rule above. Investigating it also found that
  connection speeds were being sampled from the hand-over cursor, which makes a healthy connection look
  idle between hand-overs and exposed it to being cut off by a takeover; speeds are now sampled on receipt.
* Totals: all 7 test projects pass, 256 tests: PDM.Core.Tests 75, PDM.App.Tests 75,
  PDM.Infrastructure.Tests 28, PDM.Licensing.Tests 41, PDM.Updater.Tests 18, PDM.App.Avalonia.Tests 16,
  PDM.UpdateLauncher.Tests 3. The full solution builds (two pre-existing warnings in Avalonia UI files).

### Also fixed while getting the suite green

`dotnet test PDM.sln`, which CI runs, had been failing since 1.3.2: four popup property tests still
expected the popup's ETA to equal the snapshot's, but 1.3.2 deliberately smooths it. The tests now state
the smoothed contract. Writing them exposed two real display bugs:

* **The popup's downloaded counter and progress bar did not animate.** Interpolation compared elapsed
  milliseconds with an interval stored in 100 ns ticks (5,000,000), so it advanced 10,000x too slowly
  and showed the previous update, about half a second behind. `Interpolation_ReachesLatestSnapshotWithinInterval`
  fails on the old code and passes now.
* **ETAs of a day or more wrapped around** in the download list and the CLI: the TimeSpan `hh` format
  is the hours component, so 30 hours showed as 06:00:00. `FormatEta` now shows total hours (capped at
  99:59:59), with tests for the boundaries.

---

## What was ruled out

* **Socket and TLS layer.** IDM does no socket tuning (no `setsockopt` import). On the lab link PDM's
  WinHTTP stack reached the full line rate (20.5 MiB/s) as soon as it had 8 connections.
* **Periodic dips every 8-9 s** in the lab timelines appear identically for IDM and PDM. They come
  from the lab server, not from either client.
* **Disk throughput.** Writes are decoupled from reads through a bounded queue with 4 parallel overlapped
  writers into a sparse, preallocated file; even before read gathering (R7) that path sustained the full
  lab line rate. R7 was a CPU and buffering problem, not a disk-speed one.
* **Final file assembly.** PDM finalizes in about 0.2-0.3 s after the last byte (verify, then an atomic
  rename). IDM appends its part files, which costs it time on large downloads.

---

## Remaining limitations

* **A server's connection limit is a hard ceiling.** On a server that accepts 2 connections, PDM, 1.3.2
  and IDM all end up at the speed of 2 connections. PDM now gets there with the fewest refused requests,
  but it cannot go faster. `Retry-After` on a 429 is not used for timing the next try; none of the
  servers tested sent one.
* **The last few hundred KB can still land on a slow connection.** A connection that takes over work
  gets a 1.5 s warm-up before its own speed is trusted, and splits below 128 KiB are not made. When the
  takeover connection is itself degraded, the last ~250 KB can take a few seconds (lab C: last 1% at
  about 1.7 MiB/s). Racing a duplicate request for the final piece, as IDM's "alternative connection"
  strings suggest, would remove this; it was left out because the remaining cost is small and the lab
  case is extreme (one in three new connections degraded 30x).
* **Slow connections are relieved at the end, not replaced mid-download.** A degraded connection keeps
  its slot until the other connections run out of work. IDM behaves the same way in scenario C (three
  degraded connections held for 27 s).
* **CPU use is still about 1.3x IDM's per byte** (7.8-8.5 s against 6.3 s for 600 MiB, down from
  20-21.5 s). What remains is mostly `WinHttpHandler` itself: every 8 KiB read is two asynchronous WinHTTP
  calls (query available data, then read it). The handler is kept for its TLS fingerprint (see
  `HttpClientProvider`); replacing it was out of scope.
* **The disk-stall buffer was not tested against a slow disk.** The test machine has only an NVMe SSD.
  That the write queue now holds up to 128 MiB instead of 2 MiB follows from the code (256 chunks of up
  to 512 KiB instead of 8 KiB); its effect on a slow USB drive or HDD was not measured.
* **One extra round trip at the start.** PDM probes with `Range: bytes=0-0` before transferring, where IDM
  starts streaming on its first request. In the desktop app the probe runs when the download is added.
* **Measurement scope.** The lab is a model of a link, not the internet. The real-internet runs come
  from one location, three mirrors and two or three runs each, and per-connection speed on those paths varied by
  a factor of 3 between runs, so treat single real-internet numbers as indicative and the interleaved
  averages as the comparison.
