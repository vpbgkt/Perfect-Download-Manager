# 1. IDM investigation

IDM 6.43 build 16 (`C:\Program Files (x86)\Internet Download Manager\IDMan.exe`, 32-bit) was studied
three ways: its binary (static), its behaviour against a server that logs every request (dynamic), and its
own per-download log files. Nothing was patched, injected or decompiled.

> **About rea.** The task suggested using the `rea` reverse-engineering toolkit. Its native-binary
> analysis needs Ghidra 12.1 with JDK 21 (or IDA or Hopper), and none of these were installed on the test
> machine. Instead of installing them, the questions that mattered (which network APIs IDM uses, how it
> schedules connections) were answered with the two small scripts in [`tools/`](tools/) and with
> black-box observation, which turned out to be the more informative of the two for scheduling
> behaviour. Decompilation-level detail would need Ghidra and rea to be set up.

## 1.1 Static analysis

### Is it packed?

```sh
node research/tools/petriage.mjs "C:\Program Files (x86)\Internet Download Manager\IDMan.exe" "ws2|wininet|winhttp"
```

Five ordinary sections (`.text`, `.rdata`, `.data`, `.rsrc`, `.reloc`) with entropy between 5.2 and 6.6.
Packed or encrypted code typically sits near 8. **Not packed**, so strings and imports can be trusted.

### Which network APIs does it use?

The normal import table has no Winsock, WinINet or WinHTTP at all. They are **delay-loaded**, and the
Winsock functions are imported **by ordinal**:

```
[delay] WS2_32.dll (23): #15, #112, #6, #1, #2, #13, #7, #3, #23, #10, #4, #18, #151, #19, #11, #111, #16, #14, #9, #52, #8, #115, #116
[delay] WININET.dll (7): GetUrlCacheEntryInfoW, InternetCrackUrlA, InternetCanonicalizeUrlA, ...
```

Mapped through the standard WS2_32 ordinal table, the ordinals are: `ntohs`, `WSASetLastError`,
`getsockname`, `accept`, `bind`, `listen`, `getsockopt`, `closesocket`, `socket`, `ioctlsocket`,
`connect`, `select`, `__WSAFDIsSet`, `send`, `inet_addr`, `WSAGetLastError`, `recv`, `ntohl`, `htons`,
`gethostbyname`, `htonl`, `WSAStartup`, `WSACleanup`.

What this tells us:

* **IDM implements HTTP and FTP itself over raw sockets.** Its strings include `Send GET...`,
  `Recv transfer encoding chunked`, SOCKS4/5 handshakes and FTP commands. WinINet is used only for URL
  helpers and cookies, and WinHTTP only for proxy discovery (`WinHttpGetProxyForUrl`,
  `WinHttpGetIEProxyConfigForCurrentUser`, resolved at run time).
* **TLS** goes through Windows Schannel/SSPI (`AcquireCredentialsHandle`, `InitializeSecurityContext`,
  `EncryptMessage`, `DecryptMessage`), with OpenSSL (`libssl.dll`) as an alternative.
* **No socket tuning.** Ordinal 21, `setsockopt`, is **not** imported. IDM never sets `SO_RCVBUF`,
  `SO_SNDBUF` or `TCP_NODELAY`; it relies on Windows receive-window auto-tuning like every other
  client. So whatever makes IDM fast, it is not socket options. This ruled out a whole class of
  speculative fixes before any code was written.
* **IPv4 only.** Names are resolved with `gethostbyname`, which can only return IPv4 addresses (it
  predates IPv6). This later explained a real-world failure (section 1.4).
* Sockets are non-blocking (`ioctlsocket`) and multiplexed with `select`: a classic single-threaded
  event loop over many connections.

### How is the engine structured?

IDM's error messages name its own classes and methods:

```sh
node research/tools/strgrep.mjs IDMan.exe "(ChunksList|Connection)[A-Za-z]*::" 300
```

| String | What it implies |
|---|---|
| `ChunksList::FindMaxFreeChunk()` | When a connection is free, it looks for the largest unfinished chunk |
| `ChunksList::NeedNewConnection()` | Run on a timer: the connection count is maintained continuously, not decided once |
| `Connection::OnChangeBounds()` | A running connection's end is moved back when another connection takes part of its range |
| `ChunksList::AddAlternative / CheckAlternative / ApplyAlternative`, "Add alternative connection (%ld) for connection %ld" | IDM can race a second connection against a slow one and keep the faster |
| "Connection timed out, restarting..." | Dead connections are restarted |
| "Optional connections, connecting..." | Extra connections beyond the first are opened speculatively |
| "Download complete, appending all downloaded parts into one file..." | Each connection writes its own part file; they are joined at the end |
| `MaxConnectionsNumber` (registry) | Connection count setting; the default is 8 |

## 1.2 Dynamic observation

IDM was driven from the command line (`IDMan.exe /d <url> /p <folder> /f <name> /n`) against the lab
server described in [02-measurement-method.md](02-measurement-method.md), which logs every request with
its `Range` header, timing and outcome. Request pattern from scenario A (clean 20 MiB/s link, 600 MiB):

```
  t      socket  range requested                  MiB sent
  0.00s  s1      (no Range: plain GET)            78.75  closed early
  0.25s  s2      bytes=235470-629145599            0.00   (range check, closed at once)
  0.28s  s3      bytes=314696374-629145599        76.44  closed early
  0.51s  s4      bytes=471932727-629145599        77.16  closed early
  0.51s  s5      bytes=157900538-314696437        76.97  closed early
  2.41s  s6..s9  four more, each half of the largest remaining chunk
 30.69s  s10..   end game: pieces of 1.5 MiB, 0.69, 0.28, 0.25 ... down to ~132 KB
```

Observed rules:

| Aspect | IDM 6.43 | PDM 1.3.2 |
|---|---|---|
| First request | Plain GET from byte 0; data flows immediately and the response doubles as the probe | Separate `bytes=0-0` probe, then data |
| Ramp-up | Every new connection takes **half of the largest unfinished chunk**; 4 connections at 0.5 s, 8 at 2.4 s | Fixed plan of 8 x 75 MiB; one connection added every 2 s; 8 reached at 14.8 s |
| Ranges | Open-ended (`start-EOF`); the connection stops reading at its current bound and closes | Closed (`start-end`) |
| Connection reuse | None: one request per TCP connection | Keep-alive reuse through WinHTTP |
| End of download | Keeps splitting down to about 130-170 KB pieces; 7-8 connections busy until the last second | Two splits in total, then idle connections quit; finished on one connection |
| Dead connection | Abandoned after about 17-18 s | Abandoned after 60 s |
| Refused connection (429) | Retried in pairs at roughly 4, 8 and 12 s intervals | Retried with normal back-off, then retired |
| Final file | Appends per-connection part files | One preallocated sparse file, renamed at the end |

The essential lesson: **IDM's advantage is scheduling.** It gets all its connections working within
about 2 seconds and keeps every one of them busy until the last second by repeatedly halving whatever
work remains.

### Where IDM is weaker

The same scenarios also showed where IDM struggles, which set the bar higher than "copy IDM":

* **Degraded connections** (scenario C, every third new connection limited to 100 KB/s): IDM never
  replaced a slow connection mid-download and ended with all 8 slots on slow connections, taking
  89-131 s for a download the fixed PDM finishes in 37 s.
* **Connection-limited servers** (scenario E): IDM sent 23-43 refused requests where the fixed PDM
  sends 9-10.

## 1.3 IDM's own logs

IDM writes a log per download at
`%APPDATA%\IDM\DwnlData\<user>\<name>_<id>\<name>_<id>.log`, with one line per connection event (`C0:`,
`C1:` ...). These logs were the fastest way to explain IDM's real-world failures. Example (a connection
refused at the TCP level):

```
C0:gethost
C0:Found 90.130.70.73
C0:Connecting...
C0:Checking connect, socket = 1124
C0:Except fds set. Error code = 10060
...
Cannot download the file because of timeout
Details: Cannot connect to speedtest.tele2.net:80
```

## 1.4 Real-world behaviours found

1. **IPv4-only failure.** From the test network, `speedtest.tele2.net` was reachable only over IPv6
   (`curl -4` timed out, `curl -6` worked). IDM, resolving with `gethostbyname`, tried the IPv4 address
   six times, timing out with WSAETIMEDOUT each time, and gave up. PDM, whose WinHTTP stack is dual-stack,
   downloaded the file normally.
2. **No retry after a closed first request.** On a Hetzner mirror reached by IPv4 address, the server
   closed the connection on IDM's first, range-less GET (probably a per-client limit still counting
   earlier connections). IDM logged "Connection has been closed by server" and stopped with "Cannot
   download this file" on two separate attempts, minutes apart. PDM retries in this situation.

## 1.5 What we took from IDM, and what we did differently

| Taken from IDM | Done differently |
|---|---|
| Open all connections right away | Keep-alive reuse and closed ranges (cheaper per split than a new TCP and TLS connection) |
| Keep every connection busy to the end | Split by **expected finish time**, not by bytes, so a slow connection's range is relieved first |
| Split down to small pieces at the end | A split must save more than one measured request round trip, which stops pointless churn |
| Restart dead connections | Detect "blocked on the server" precisely, and hand the range over instead of waiting for a timeout |
| Space out retries of refused connections | Lower the connection limit to what the server accepts, and probe one extra connection with a doubling back-off |
| (IDM appends part files) | Keep PDM's single preallocated file; no join step at the end |
