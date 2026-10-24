# Download engine research (October 2026)

This folder explains **why** PDM's download engine was changed after 1.3.2, **how** the problems were
found, **what** the new code does, and **how** the result was measured. It is written for developers who
will maintain the engine and for reviewers who want to check the reasoning, not just the outcome.

The short version is in [docs/DOWNLOAD-ENGINE-PERFORMANCE.md](../docs/DOWNLOAD-ENGINE-PERFORMANCE.md).
This folder is the long version: the evidence, the dead ends, and the design decisions.

## The problem in one paragraph

Users reported that PDM 1.3.2 downloaded at 13-16 MB/s where IDM reached 18-20 MB/s on the same file, that
its speed dipped and recovered constantly, and that it crawled at KB/s between 90% and 99%. Measured on a
reproducible lab link and on real servers, all of this came from **how the engine decided how many
connections to run and what each one worked on**. It was not the network stack, the disk, or the
final file assembly. Fixing it exposed one capability PDM lacked (respecting servers that cap
connections per client), and a separate write-path inefficiency that tripled CPU use.

## Reading order

| # | Document | What it answers |
|---|---|---|
| 1 | [IDM investigation](01-idm-investigation.md) | What IDM actually does, from its binary, from watching it on an instrumented server, and from its own logs |
| 2 | [How it was measured](02-measurement-method.md) | The lab link, the scenarios, the real-internet method, and the measurement traps we hit |
| 3 | [Root causes](03-root-causes.md) | The seven problems found in 1.3.2 (R1-R7), each with the evidence that established it |
| 4 | [Implementation](04-implementation.md) | A walkthrough of the new code: the design, the invariants that keep it correct, and alternatives that were rejected |
| 5 | [Bugs found while building it](05-bugs-found-during-implementation.md) | Mistakes in the first versions of the fix, how measurement exposed them, and what changed |
| 6 | [Results](06-results.md) | All the numbers: lab, real internet, CPU and memory |
| 7 | [Tests](07-tests.md) | New and changed tests, which ones fail on the old code, how to run them |
| 8 | [Display fixes](08-display-fixes.md) | Two UI bugs found while making the test suite pass again |
| 9 | [Limitations and next steps](09-limitations-and-next-steps.md) | What is still not as good as it could be, and what we would try next |

## Files changed

| File | Change |
|---|---|
| `src/PDM.Core/Downloading/DownloadWorker.cs` | The scheduler: connection start-up, takeover of slow and stalled ranges, connection admission, read gathering |
| `src/PDM.Core/Downloading/DiskWriteQueue.cs` | Resume-offset accounting kept across retries |
| `src/PDM.Core/Models/DownloadOptions.cs` | Options removed, defaults changed, one option added (see [Implementation](04-implementation.md#options)) |
| `src/PDM.App.Core/ViewModels/DownloadPopupViewModel.cs` | Popup progress interpolation unit fix |
| `src/PDM.App.Core/Formatting.cs`, `src/PDM.Cli/Program.cs` | ETA formatting past 24 hours |
| `tests/PDM.Core.Tests/DownloadSchedulerTests.cs` (new) | Regression tests for the scheduler behaviour |
| `tests/PDM.TestSupport/PacedHttpHandler.cs` (new) | Test server with per-request speed, stalls and a connection limit |
| `tests/PDM.Core.Tests/DownloadEngineStressTests.cs` | Updated for removed options and empty segments |
| `tests/PDM.App.Tests/*` | Popup property tests updated to the 1.3.2 smoothing contract; ETA formatting tests |
| `tools/netlab/` (new) | The lab server and analyser used for every lab measurement |

## Tools in this folder

| Script | Purpose |
|---|---|
| [`tools/petriage.mjs`](tools/petriage.mjs) | Lists a Windows executable's sections (with entropy) and its normal and delay-loaded imports |
| [`tools/strgrep.mjs`](tools/strgrep.mjs) | Searches ASCII and UTF-16 strings in a binary with a regular expression |
| [`tools/nicsampler.ps1`](tools/nicsampler.ps1) | Samples the network adapters' received-byte counters every 250 ms, for client-agnostic real-internet timelines |

The lab server and log analyser live in [`tools/netlab/`](../tools/netlab/).

## Terms used throughout

* **Segment**: a byte range of the file assigned to one connection. Segments are split while the
  download runs.
* **Victim / thief**: when a free connection takes over part of another connection's range, the
  connection losing work is the victim and the one taking it is the thief.
* **Read cursor**: how many bytes of a segment have been handed to the disk writer (`_liveBytes`).
* **Durable offset**: how many bytes of a segment have actually been written to disk, contiguously from
  its start (`DownloadSegment.BytesDownloaded`). This is the resume point.
* **Round**: one pass of the worker pool. Normally a download is a single round; a new round starts only
  when connections retire or the plan collapses to a single stream.
* **MiB/s**: 1,048,576 bytes per second. User-facing numbers quoted as "MB/s" come from the UI and are close
  to MiB/s.
