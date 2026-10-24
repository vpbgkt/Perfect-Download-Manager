# 5. Bugs found while building the fix

The first versions of the new code had mistakes. Each one was caught by a measurement or a test before
the work was finished. They are recorded here because they show which parts of the design are subtle,
and what a future change must not break.

## 1. A takeover could fail the whole download

**What happened.** When a stalled connection's whole range was taken over just as its worker was about
to send its next request, `segment.End` was already below the read cursor. `new RangeHeaderValue(from, to)`
then threw `ArgumentOutOfRangeException` (`to < from`), which is not a transient error, so the download
would have **failed**.

**How it was found.** Code review of the takeover path, before it was ever hit.

**Fix.** `TransferSegmentAsync` reads `segment.End` once into a local and returns immediately when the
read cursor is already past it ("the rest of this range was just handed to another connection"). The
request uses that same snapshot.

## 2. A burst of refusals was counted six times

**What happened.** On a server accepting 2 of 8 connections, the 6 refusals at start-up each doubled the
retry back-off: 8, 16, 32, then the 64 s cap. The first attempt at an extra connection was scheduled
64 s later, after a one-minute download had already finished.

**How it was found.** The lab server's request log for scenario E showed no retry at all after the
initial burst.

**Fix.** Refusals within `max(1 s, 2 x L)` of each other count as one answer; only a refusal outside
such a burst (in practice, of the extra connection) grows the back-off.

## 3. A reconnecting connection was mistaken for a new limit

**What happened.** Late in a download on a 2-connection server, a connection reconnected right after its
previous connection closed; the server had not yet released the old one and answered 429. The engine
lowered its limit to **1** and finished the download on one connection (last 10% at 7.6 instead of
10.3 MiB/s).

**How it was found.** Lab timeline for scenario E, request at 58.7 s.

**Fix.** A refusal lowers the limit only if it is the first refusal ever, part of a burst, or the refusal
of the extra connection that was let in above the limit (`AboveLimit`). Any other refusal is retried
like a transient error.

## 4. Read gathering chopped reads into tiny pieces

**What happened.** The first version of gathering handed a buffer over only when it was exactly full.
The test server returns reads of random size between 1 byte and the space offered, so as the buffer
filled, reads got smaller and smaller (each roughly half of what was left). The chaos test suite became
**2.6 times slower** (25 s to 66 s).

**Why production would rarely see it.** WinHTTP returns exactly 8 KiB and 512 KiB is a multiple of 8 KiB.
But any stream with partial reads would pay for extra tiny reads.

**How it was found.** Test-suite duration jumped from about 25 s to 96 s; timing individual tests pointed
at the chaos suite; disabling gathering (hand-over after every read) brought it back to 25 s.

**Fix.** Hand over when the space left **could not take another read of the size just received**. With
WinHTTP that is "full"; with partial-read streams it stops the chopping.

## 5. Speeds were measured on the wrong counter

**What happened.** After gathering, the scheduler still measured each connection's speed from the read
cursor, which now moves in 512 KiB steps. Sampled between steps (every 500 ms in production, every 20 ms
in the stress tests), a healthy connection looked idle. A near-zero speed made the split formula give the
victim zero bytes, and the takeover then **cancelled a healthy connection**.

**How it was found.** While investigating bug 4. It was not the cause of that slowdown (fixing it alone
changed nothing), but it was a real flaw.

**Fix.** Two changes: speed is sampled from a per-read `Received` counter; and only a connection judged
stalled is ever cut off and cancelled. A delivering connection always keeps at least one byte.

## 6. The lab measurement itself was wrong several times

See the traps table in [02-measurement-method.md](02-measurement-method.md#28-traps-we-fell-into). The
most serious: a benchmark loop that kept running after it was stopped, so two runs shared the server. One
PDM run received 15 requests from an IDM download, and its result (a 33 s "tail") was wrong. Every run
now uses a unique URL, the server rejects anything else, and every log was audited for foreign requests
before its numbers were used.

## Lessons for future changes

* **Separate "what has been read" from "how fast it is arriving".** The first decides where a split may
  start (safety); the second decides whether to split (performance). Mixing them caused bug 5.
* **Only cancel what is genuinely dead.** Cancelling a slow-but-working connection discards its in-flight
  data and costs a new connection.
* **Treat a server's answer as one event, not one per connection** (bug 2), and do not read a transient
  race as a policy (bug 3).
* **Test suites are performance canaries.** A 3x slower test suite was the first sign of bug 4.
* **Audit measurements.** A plausible number from a contaminated run is worse than no number.
