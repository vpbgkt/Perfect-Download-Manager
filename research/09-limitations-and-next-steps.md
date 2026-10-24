# 9. Limitations and next steps

## Known limitations

| Limitation | Impact | Possible next step |
|---|---|---|
| **A server's connection limit is a hard ceiling.** | On a server that accepts 2 connections, every client gets the speed of 2 connections. PDM gets there with the fewest refused requests but cannot go faster. | Use `Retry-After` on 429 responses to time the next attempt; none of the servers tested sent it. |
| **The last few hundred KB can land on a slow connection.** | A connection taking over work gets a 1.5 s warm-up before its own speed is trusted, and splits below 128 KiB are not made. If that connection is itself degraded, the last ~250 KB can take a few seconds (lab C: last 1% at 1.7 MiB/s). | Race a duplicate request for the final piece and keep whichever finishes first, as IDM's "alternative connection" strings suggest. Needs write-accounting changes, because two connections would write the same range. |
| **Slow connections are only relieved at the end.** | A degraded connection keeps its slot until the others run out of work. IDM behaves the same. | Restart a connection that stays far below the typical speed for several seconds while others are healthy. |
| **CPU is still about 1.3 times IDM's per byte** (7.8-8.5 s against 6.3 s for 600 MiB). | Not a speed limit (the engine moves 567-584 MiB/s on loopback), but more battery use on laptops. | Most of what remains is `WinHttpHandler`: two asynchronous WinHTTP calls per 8 KiB read. The handler is kept for its TLS fingerprint. Calling WinHTTP directly with larger reads (`WinHttpReadDataEx`, Windows 11) could remove much of it. |
| **The disk-stall buffer was not tested against a slow disk.** | That the write queue now holds up to 128 MiB instead of 2 MiB follows from the code and the measured read size; its effect on a USB drive or hard disk was not measured. | Measure with a slow external drive, or add a test hook to `DiskWriteQueue` that delays writes. |
| **One extra round trip at the start.** | PDM probes with `Range: bytes=0-0` before transferring; IDM streams from its first request. | In the desktop app the probe runs when the download is added, so the user rarely waits for it. Could be removed by streaming the probe response. |
| **Measurement scope.** | The lab is a model of a link. The real-internet runs come from one location, three mirrors and two or three runs each, and per-connection speed varied by a factor of 3 between runs. | Run the same comparison from other networks, especially the users' own, and against the servers they actually download from. |

## Things to watch after release

* **Servers that object to 8 connections in other ways** than 429/503 (for example by resetting
  connections or answering 403). These still go through the old path: retries, then retirement and a
  smaller next round. If such servers turn up, they may need the same admission treatment.
* **Segment count growth.** Repeated splitting is capped at `initial + max(32, 16 x MaxConnections)`, at
  most 512 segments. A download paused and resumed many times on a slow server could approach the cap,
  after which splitting stops.
* **The free plan** limits downloads to 2 connections. Speed comparisons with IDM must use a licensed
  build, or they measure the licence limit, not the engine.

## How to repeat the measurements

1. Build the command-line client: `dotnet publish src/PDM.Cli -c Release -o out/cli`.
2. Follow [02-measurement-method.md](02-measurement-method.md#25-running-a-comparison) for each scenario,
   with a fresh `--path` per run, interleaving clients.
3. Verify every file with `labserver.mjs --verify` and check the analyser's `rejectedForeignRequests` is 0.
4. For real servers, use IPv4-literal URLs when comparing with IDM.
