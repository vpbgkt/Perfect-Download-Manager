# 8. Display fixes

Two user-visible bugs outside the engine were found while making the popup property tests pass again.

## 8.1 The popup's downloaded counter did not animate

**Where.** [`DownloadPopupViewModel`](../src/PDM.App.Core/ViewModels/DownloadPopupViewModel.cs), the
"downloaded" text and progress bar.

**Intended behaviour (1.3.2).** The engine reports progress every 500 ms. A 60 frames-per-second timer
interpolates between the previous and the latest snapshot so the counter moves smoothly, like IDM's.

**The bug.** The time since the last snapshot was measured with `Environment.TickCount64`, which is in
**milliseconds**, but the interval it was compared with was `TimeSpan.FromMilliseconds(500).Ticks`, which
is in **100-nanosecond ticks** (5,000,000). The interpolation fraction grew by about 0.0001 per snapshot,
so the counter sat on the *previous* snapshot's value, about half a second behind, and barely moved.

```csharp
// before
private long _intervalTicks = TimeSpan.FromMilliseconds(500).Ticks;    // 5,000,000
long elapsed = Environment.TickCount64 - _snapshotTicks;               // milliseconds
double t = Math.Clamp((double)elapsed / _intervalTicks, 0, 1);         // ~0

// after
private readonly long _intervalMs = 500;
long elapsedMs = Environment.TickCount64 - _snapshotAtMs;
double t = Math.Clamp((double)elapsedMs / _intervalMs, 0, 1);
```

The fields were renamed so that their unit is part of their name.

**Test.** `Interpolation_ReachesLatestSnapshotWithinInterval` applies two snapshots 10 MiB apart, checks
that the display has not jumped straight to the second, waits 600 ms and checks that it has arrived.
With the old interval value it still showed the first value after 600 ms.

## 8.2 ETAs of a day or more wrapped around

**Where.** [`Formatting.FormatEta`](../src/PDM.App.Core/Formatting.cs), used by the main download list,
and the CLI's progress line ([`Program.cs`](../src/PDM.Cli/Program.cs)).

**The bug.** `TimeSpan.ToString(@"hh\:mm\:ss")` formats the **hours component** (0-23), not the total
hours. An ETA of 30 hours (for example 50 GB at 500 KB/s) showed as `06:00:00`; exactly one day showed as
`00:00:00`. The popup avoided it only because it hides ETAs of a day or more.

**The fix.** Format total hours, capped at 99:59:59 as before:

```csharp
if (value.TotalHours >= 100) return "99:59:59";
return string.Create(CultureInfo.InvariantCulture,
    $"{(int)value.TotalHours:00}:{value.Minutes:00}:{value.Seconds:00}");
```

**Test.** `FormatEta_ShowsTotalHours_CappedAt99` covers 0 s, 3 min 15 s, 1 h, 23:59:59, exactly 24 h,
30 h, 99:59:59, 100 h and far beyond.
