# 2. How it was measured

Every claim in this research comes from a measurement that can be repeated. This document describes the
lab link, the scenarios, the real-internet method, and the traps that produced wrong numbers along the way.

## 2.1 Why a lab link

Real internet speed changes from minute to minute; per-connection speed on the same route varied by a
factor of 3 between runs during this work. That noise hides differences of 10-20%. The lab link removes
it, and it can also produce the rare conditions (a dead connection, a server with a connection limit)
on demand.

## 2.2 The lab server

[`tools/netlab/labserver.mjs`](../tools/netlab/labserver.mjs) is a Node.js HTTP/1.1 server with full
`Range` and `If-Range` support. It emulates a link with these settings:

| Option | Meaning | Value used |
|---|---|---|
| `--link` | Line capacity shared by all connections (a first-in, first-out "virtual time" pacer) | 20 MiB/s |
| `--perconn` | Ceiling for each TCP connection, modelling TCP window / round-trip limits or server throttling | 3 MiB/s |
| `--ramp` | Seconds for a new connection to climb from 10% to full speed (TCP slow start) | 1 s |
| `--connlat` | Extra delay before the first response on a new connection (TCP and TLS handshakes) | 150 ms |
| `--reqlat` | Delay before every response (request round trip) | 50 ms |
| `--jitter` | Each connection's speed re-drawn every 500 ms within plus or minus this fraction | scenario B |
| `--slowevery`, `--slowrate` | Every Nth new connection is capped at this speed | scenario C |
| `--stallevery`, `--stallafter` | Every Nth new connection stops sending after this many bytes, socket left open | scenario D |
| `--maxconns` | Requests arriving while this many responses are open get `429 Too Many Requests` | scenario E |
| `--path` | The only URL path served; anything else gets 404 and is logged | a new one per run |

Why 3 MiB/s per connection and 20 MiB/s in total: with these numbers one connection cannot fill the line,
which is exactly the situation where a download manager earns its keep. It is also the situation the users
reported: IDM reached 18-20 MB/s and 1.3.2 reached 13-16 MB/s. The lab reproduced those figures
(IDM 18.8, 1.3.2 15.1 MiB/s) before any change was made, which is the evidence that the model is
realistic enough.

**Content and verification.** Byte `o` of the file is `BLOCK[o mod 1 MiB] XOR (floor(o / 1 MiB) & 0xFF)`,
where `BLOCK` is a fixed pseudo-random megabyte. Any range can be generated on the fly, and
`labserver.mjs --verify <file>` checks a finished download byte by byte. Every lab run in this research
was verified this way.

**What is logged.** One JSON line per connection opened and closed, per request (range, status, user
agent), per finished response (bytes sent, duration, whether the client closed early), and every 250 ms an
aggregate tick (open connections, open responses, bytes sent).

## 2.3 The analyser

[`tools/netlab/analyze.mjs`](../tools/netlab/analyze.mjs) turns a log into:

* total time from the first request to the last byte, and the times at which 50%, 90% and 99% of the
  file had been sent;
* speed overall, over the first 90%, over the last 10% and over the last 1%. These isolate the
  end-of-download slowdown users reported;
* the steady-state coefficient of variation of the 1-second speed (from second 3 to the 90% mark), as a
  measure of stability;
* a per-second timeline with the number of open responses, and the list of requests with their ranges.

Because time is measured **on the server**, PDM and IDM are timed by the same clock, regardless of how
each client reports progress.

## 2.4 Scenarios

| Scenario | Added to the base link | What it represents |
|---|---|---|
| A clean | nothing | A healthy server on a fast home line |
| B noisy | `--jitter 0.5` | Cross traffic and TCP's normal speed sawtooth |
| C degraded | `--slowevery 3 --slowrate 102400` | A bad route or overloaded CDN node for some connections |
| D stalled | `--stallevery 4 --stallafter 20971520` | A connection that stays open but stops sending |
| E limited | `--maxconns 2 --perconn 5242880` | A file host or mirror that allows 2 connections per client |

## 2.5 Running a comparison

```sh
node tools/netlab/labserver.mjs --port 8765 --path runA1.bin --size 629145600 \
     --link 20971520 --perconn 3145728 --ramp 1 --log runA1.jsonl
pdm http://127.0.0.1:8765/runA1.bin out --connections 8
#   or: "C:\Program Files (x86)\Internet Download Manager\IDMan.exe" /d http://127.0.0.1:8765/runA1.bin /p out /f runA1.bin /n
node tools/netlab/labserver.mjs --size 629145600 --verify out/<file>
node tools/netlab/analyze.mjs runA1.jsonl --timeline --ranges 40
```

Clients were **interleaved** (PDM, IDM, PDM, IDM ...) rather than run in blocks, so slow drift of the
machine affects every client equally.

## 2.6 Real-internet method

The lab cannot show everything; the connection-limit problem (R5) was found only on a real server. Real
downloads used 1 GiB or 1000 MiB public test files from mirrors that support ranges.

* **Timing for any client.** IDM writes into its own temporary folder, so the size of the output file
  cannot be watched. Instead [`tools/nicsampler.ps1`](tools/nicsampler.ps1) samples the received-byte
  counters of all network adapters every 250 ms during a run. That gives the same kind of timeline for
  every client.
* **Same route for both clients.** PDM's WinHTTP prefers IPv6 when a host has it; IDM can only use IPv4.
  By host name the two clients therefore took **different routes** to the same server, which makes a
  comparison meaningless. Same-route comparisons used an IPv4-literal URL (for example
  `http://129.143.4.238/1G`), which forces both onto the same path.
* **Integrity.** Every completed file was hashed (SHA-256) and compared across clients.
* **Diagnostics.** To see why a real download misbehaved, a small harness ran the real engine with the
  real WinHTTP handler wrapped in a logging `DelegatingHandler`, recording every request's range, status,
  time to headers, bytes delivered, read count and how the body ended. That is how the 429 storm (R5)
  and the 8 KiB read size (R7) were discovered.

## 2.7 CPU and memory

CPU time (`Process.TotalProcessorTime`) and peak working set were sampled for a 600 MiB scenario-A
download. CPU time on the test machine varied by up to 50% between identical runs, so builds being
compared were **alternated run by run**, three runs each.

## 2.8 Traps we fell into

These produced wrong numbers at some point. Each was caught by a check that disagreed, and fixed in the
method before any result was used.

| Trap | Symptom | Fix |
|---|---|---|
| Git Bash rewrites arguments that look like paths (`/d` became a drive path) | IDM silently did nothing | Disable path conversion (`MSYS_NO_PATHCONV=1`) when calling IDM |
| A background benchmark loop survived being stopped | Two loops ran at once; one PDM run received 15 requests from IDM | Every run gets a unique URL path; the server answers 404 to anything else and logs it; every log is audited for foreign requests |
| Interrupted IDM downloads kept retrying | About 125 refused requests per second hitting the lab server | Removed the stale entries from IDM; unique paths make such retries harmless |
| Calling `IDMan.exe /d` when IDM was not running | The call became IDM itself and never returned | Hand-off is started in the background |
| IDM "Download complete" dialogs left open | IDM ignored the next command-line hand-off | Close IDM's dialogs before each run |
| Host names with IPv6 | PDM and IDM on different routes | IPv4-literal URLs for comparisons |
| A flag given twice (`--perconn` in the base settings and in scenario E) | The first value won, so one "scenario E" ran at 3 MiB/s, not 5 | The server now uses the last occurrence; results reported for both variants |
| CPU noise | Single CPU measurements differed by 50% | Alternate builds, report ranges |
