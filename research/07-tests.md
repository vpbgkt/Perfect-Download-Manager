# 7. Tests

## Running them

```sh
dotnet test PDM.sln -c Debug                      # everything; this is what CI runs
dotnet test tests/PDM.Core.Tests --filter "FullyQualifiedName~DownloadSchedulerTests"
dotnet test tests/PDM.Core.Tests --filter "FullyQualifiedName~DownloadEngineStressTests"
```

All 7 test projects pass, 256 tests:

| Project | Tests |
|---|---|
| PDM.Core.Tests | 75 |
| PDM.App.Tests | 75 |
| PDM.Licensing.Tests | 41 |
| PDM.Infrastructure.Tests | 28 |
| PDM.Updater.Tests | 18 |
| PDM.App.Avalonia.Tests | 16 |
| PDM.UpdateLauncher.Tests | 3 |

## New: scheduler regression tests

[`DownloadSchedulerTests`](../tests/PDM.Core.Tests/DownloadSchedulerTests.cs) uses a new in-memory test
server, [`PacedHttpHandler`](../tests/PDM.TestSupport/PacedHttpHandler.cs), which serves each data request
at a chosen speed, can make a request go silent after a given number of bytes (socket left open), and can
refuse requests with 429 beyond a connection limit. It also records the most responses open at once, when
that was first reached, and how many requests it refused.

Each test was run against the code **without** the fix it covers, to prove it detects the problem:

| Test | What it checks | Without the fix |
|---|---|---|
| `AllConnections_OpenImmediately` | 8 connections open within 1 s | Never reaches 8 (1.3.2) |
| `StalledConnection_IsTakenOver_LongBeforeStallTimeout(0)` | A connection that never sends a byte is taken over in seconds, with a 60 s watchdog; the plan still tiles the file | 61 s (1.3.2) |
| `StalledConnection_IsTakenOver_LongBeforeStallTimeout(65536)` | Same, for a connection that stalls after 64 KiB | 61 s (1.3.2) |
| `SlowConnection_RemainderIsRedistributed` | A 32 KiB/s connection's 1 MiB range is redistributed | 32 s (1.3.2) |
| `ConnectionLimitedServer_SettlesOnAcceptedConnections_WithoutRetryStorm` | Against a 2-connection server, at most 12 requests are refused | 36 refused (refusal handling disabled) |

Time bounds are deliberately loose (several times the expected duration), so they only fail when the
behaviour is missing, not on a busy build machine.

## Changed: chaos and soak tests

[`DownloadEngineStressTests`](../tests/PDM.Core.Tests/DownloadEngineStressTests.cs) drive the engine with a
hostile server (dropped connections, transient errors, ignored ranges, connection limits, random read
sizes, repeated pause and resume) on fixed seeds and assert that the file is byte-identical and that the
plan tiles the file exactly once. Changes:

* Removed the options that no longer exist (`InitialConnections`, `RampUpInterval`, `MinSplitDuration`).
* `RefusedConnectionRetryDelay` set to 5 ms, like the other delays in these tests, so the 503s the chaos
  server injects do not make the suite wait seconds. A constant rather than a random value, so the random
  sequence that each fixed seed produces is unchanged.
* The tiling check skips empty segments (a range taken over before its connection delivered a byte).

These suites also exercise read gathering: random read sizes make buffers get handed over full, part-full,
at the end of a range and after dropped connections.

## Changed: popup property tests

Four FsCheck property tests in
[`DownloadPopupViewModelPropertyTests`](../tests/PDM.App.Tests/DownloadPopupViewModelPropertyTests.cs) had
been failing since 1.3.2, so `dotnet test PDM.sln` (and therefore CI) was red. They expected the popup's
ETA to equal each snapshot's raw ETA, but 1.3.2 deliberately smooths the ETA over the speed history.
The failures were confirmed to be pre-existing by running them against the original engine code. The tests
now state the real contract:

| Old property | New property |
|---|---|
| ETA text equals the snapshot's ETA | For the first snapshot a popup receives, the ETA is remaining bytes / speed, or "—" when it cannot be estimated or is a day or more |
| A null ETA shows "—", otherwise a time | The ETA text is always "—" or `hh:mm:ss`, and an unknown size always shows "—" |
| Display reflects the snapshot, including ETA | Connections and downloaded amount reflect it once the interpolation has settled; the ETA follows the first-snapshot rule |
| Most recent snapshot wins, including ETA | Connections and downloaded amount follow the latest snapshot; the ETA is checked for form only, because it is smoothed by design |

Two tests were added: `Interpolation_ReachesLatestSnapshotWithinInterval` and
`FormatEta_ShowsTotalHours_CappedAt99` (with a placeholder test for unknown ETAs). Both cover real bugs;
see [08-display-fixes.md](08-display-fixes.md).

## What is not covered by automated tests

* Real network behaviour (latency, real TLS, real servers): covered by the lab and real-internet
  measurements in [06-results.md](06-results.md), which are manual.
* Disk stalls: no test injects a slow disk, and none was available to measure.
* CPU use: measured manually.
