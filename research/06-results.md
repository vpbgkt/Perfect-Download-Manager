# 6. Results

Every lab download was verified byte for byte, and every lab log was checked for requests from another
client. "n" is the number of runs averaged; different clients' runs were interleaved. "PDM now" is the
final code. Scenarios are described in [02-measurement-method.md](02-measurement-method.md#24-scenarios).

## Lab: average speed and total time

| Scenario | PDM 1.3.2 | PDM now | IDM 6.43 |
|---|---|---|---|
| A clean | 15.24 MiB/s (39.4 s), n=2 | **19.56 (30.7 s)**, n=3 | 18.98 (31.6 s), n=3 |
| B noisy | 14.72 (40.8 s), n=2 | **19.50 (30.8 s)**, n=2 | 18.99 (31.6 s), n=3 |
| C degraded | 2.31 (260.0 s), n=1 | **16.32 (36.8 s)**, n=2 | 5.55 (110.8 s; 89-131 s), n=3 |
| D stalled | 7.36 (81.6 s), n=2 | **18.37 (32.7 s)**, n=2 | 17.90 (33.5 s), n=3 |
| E limited, 5 MiB/s per connection | 9.88 (60.7 s), n=1 | 9.85 (60.9 s), n=2 | 9.30 (64.5 s), n=1 |
| E limited, 3 MiB/s per connection | 5.95 (100.8 s), n=1 | 5.96 (100.7 s), n=2 | 5.77 (104.0 s), n=1 |

The line's capacity is about 20.5 MiB/s, so A and B are now within 5% of the maximum possible. On a
connection-limited server (E) every client is held to the same 2 connections; PDM ties 1.3.2 within
noise and stays ahead of IDM.

## Lab: the end of the download

Speed over the last 10% / last 1% of the bytes, the "crawls near 99%" symptom.

| Scenario | PDM 1.3.2 | PDM now | IDM 6.43 |
|---|---|---|---|
| A clean | 10.03 / 3.23 | **20.99 / 35.61** | 18.69 / 12.52 |
| B noisy | 10.03 / 5.12 | **19.27 / 16.81** | 18.15 / 10.85 |
| C degraded | 0.35 / 0.10 | **9.43 / 1.70** | 1.00 / 0.80 |
| D stalled | 1.31 / 3.38 | 18.62 / **14.83** | **19.04** / 12.64 |
| E limited (5 MiB/s) | 9.83 / 8.97 | 9.83 / **10.83** | 8.39 / 6.04 |

A figure above the line rate means several connections were still delivering those final bytes together.
In D, IDM is marginally faster over the last 10% and PDM over the last 1%.

## Lab: ramp-up, stability, politeness

| Measure | PDM 1.3.2 | PDM now | IDM 6.43 |
|---|---|---|---|
| Line speed (>= 18 MiB/s for a full second) first reached, scenario A | 11-12 s | **1-2 s** | 3-4 s |
| Steady-state variation of 1-second speed (coefficient of variation), A / B | 27.7% / 26.1% | 9.0% / 8.6% | 8.1% / 8.5% |
| Refused requests, scenario E (5 MiB/s) | 6 | 9-10 | 23 |
| Refused requests, scenario E (3 MiB/s) | 6 | 9 | 43 |

The remaining 8-9% variation is the same for both clients and comes from the lab server. The build
before connection admission sent 142 refused requests in scenario E.

## CPU and memory

600 MiB at 20 MiB/s (scenario A). Builds were alternated run by run because CPU time on this machine
varies by up to 50% between identical runs.

| Build | CPU time | Peak working set |
|---|---|---|
| PDM 1.3.2 | 14.2-22.3 s (n=3) | 52 MB |
| New scheduler, before read gathering | 20.1-21.5 s (n=3) | 52 MB |
| **PDM now** | **7.8-8.5 s** (n=3) | 56-57 MB |
| IDM 6.43 | 6.3 s (n=1) | 44 MB (35 MB idle) |

Unthrottled loopback, 1 GiB:

| Build | Speed | CPU |
|---|---|---|
| New scheduler, before read gathering | 388 MiB/s | 14.3 s |
| **PDM now** | **567-584 MiB/s** | 3.6-4.1 s |
| IDM 6.43 | 409 MiB/s | not measured |

## Real internet

One machine and network, about 200 ms from these European mirrors. "Wall" time runs from starting the
client to the finished file and includes start-up for both clients (PDM's command-line client: process
start and probe; IDM: command-line hand-off and joining its part files). All completed downloads of a
file had the same SHA-256.

### Same route, no connection limit

BelWü mirror by IPv4 literal (`http://129.143.4.238/1G`, 1000 MiB). Rounds 1-2 used the new scheduler
before read gathering; round 3 the final build.

| Round | PDM 1.3.2 | PDM now | IDM 6.43 |
|---|---|---|---|
| 1 | 89.3 s (11.20 MiB/s) | **82.8 s (12.08)** | 98.9 s (10.11) |
| 2 | 104.6 s (9.56) | **96.8 s (10.33)** | 130.4 s (7.67) |
| 3 | 90.8 s (11.01) | **72.5 s (13.79)** | 112.2 s (8.91) |
| Mean | 94.9 s (10.59) | **84.0 s (12.07)** | 113.8 s (8.90) |

PDM was fastest in every round: 11% less time than 1.3.2 and 26% less than IDM on average. This route is
limited as a whole to about 12 MiB/s, below the users' own line, so it shows less of the lab's gain, which
comes from making several slow connections add up.

### Same route, server allowing 2 connections

Hetzner mirror by IPv4 literal (`http://78.46.170.2/1GB.bin`): PDM now 136.1 s (7.52 MiB/s); 1.3.2 163.6 s
(6.26 MiB/s). IDM failed both attempts (the server closed IDM's first request; IDM did not retry).

### Host reachable only over IPv6 from this network

`speedtest.tele2.net`: PDM now 85.5 s and 88.2 s (11.79 MiB/s mean); 1.3.2 104.6 s and 104.8 s
(9.78 MiB/s), 17% less time. IDM could not connect (IPv4-only name resolution).

### The connection-limit problem and its fix

Hetzner mirror by host name (PDM over IPv6): the build before connection admission took 270 s and 294 s,
with 493 refused requests; with admission it took 133.6 s with 14. Not compared with IDM, which used a
different route (IPv4): 104.8 s.

## What the user should see

| Reported symptom | Result |
|---|---|
| Speed drops during downloads | All connections work from the start; disk stalls are buffered up to 128 MiB instead of 2 MiB |
| Speed unstable | Lab variation down from 27.7% to 9.0%, the same as IDM |
| KB/s near 90-99% | Last 1% at 35.6 MiB/s on a clean link (was 3.2); 1.7 MiB/s in the worst lab case (was 0.10) |
| 13-16 MB/s vs IDM's 18-20 MB/s | 19.56 MiB/s against IDM's 18.98 on the lab link that reproduced the complaint |
