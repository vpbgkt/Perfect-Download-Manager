# Editions: Community and Premium

From 1.5.0 PDM ships **one installer for everyone**. Without a licence key it runs as
**PDM Community**; with a valid Premium key it shows **Premium**. The older model (14-day trial,
then a reduced free tier) is still in the code behind one switch, so it can be brought back.

## What users get

| | Community (no key) | Premium (valid key) |
|---|---|---|
| Features | All | All |
| Connections per download | Up to 8 (default 8) | Signed licence value, never less than Community; uncapped licences get the full setting range (1-64) |
| Simultaneous downloads | User setting (default 3) | Same, never less than Community |
| Time limit | None | Licence period |
| Sidebar badge | **Community** · "Join the PDM channel" (opens the WhatsApp channel) | **Premium** · "Licensed to *name*" (opens licence details) |
| Upgrade pop-ups, speed notices | None | None |
| Contacts the licence server | Never (no trial anchor) | Activation and periodic re-validation |

When a Premium licence ends, is revoked, moves to another PC or cannot be re-validated after the
grace period, PDM **continues as Community** and the warning bar says why (with a "License
details" button). Deactivating the key clears the message. During the offline grace period the
install stays Premium.

The WhatsApp channel link (`SupportLinks.WhatsAppChannelUrl`) is on the Community badge, in the
License window ("PDM channel") and in the **⋯** menu ("PDM channel on WhatsApp").

## How it works in the code

| Piece | File | Role |
|---|---|---|
| The switch | `src/PDM.Licensing/ProductEdition.cs` | `EditionPolicy.Current` = `Community` or `Trial` |
| Tiers | `src/PDM.Licensing/LicenseService.cs` (`LicenseEntitlements`) | `Community` (8 connections), `Free` (Trial edition: 2 connections, 1 download), `Full`, `AtLeast()` floor |
| Status | `src/PDM.Licensing/LicenseStatus.cs` | `Community` is used only by the Community edition; `Trial` / `Expired` / `Invalid` only by the Trial edition (`Invalid` also reports a failed activation attempt) |
| Decision | `LicenseService.BuildSnapshot` / `BuildLicensedSnapshot` / `Unlicensed` | Turns the stored licence + edition into a snapshot (status, message, entitlements) |
| Enforcement | `src/PDM.App.Core/AppHost.cs` (`ApplyLicenseConnectionPolicy`) → `DownloadManager` caps | The only place limits reach the download engine |
| Settings cap | `SettingsViewModel(…, connectionCap)` | The connections box offers at most the plan's cap |
| Badge and bar | `LicenseBannerViewModel`, `MainWindow.axaml` (plan tag) | Which badge shows, its caption, the warning bar |
| License window | `LicenseViewModel`, `LicenseWindow.axaml` | Plan description, key entry, channel button |
| Trial-edition messaging | `MainWindow.axaml.cs` ("Free plan" toasts), `DownloadPopupViewModel.IsLimitedPlan` | Only shown when `AppHost.IsLimitedMode` (never in Community) |

`LicenseService.Edition` defaults to `EditionPolicy.Current`; tests set it explicitly, so both
editions stay tested whichever one ships:
`tests/PDM.Licensing.Tests/LicenseServiceTests.cs` (Trial edition and shared licence paths),
`tests/PDM.Licensing.Tests/CommunityEditionTests.cs`, `tests/PDM.App.Tests/PlanDisplayTests.cs`.

The licence backend (`backend/licensing/`) and the portal are the same for both editions; the
`/trial` endpoint is simply not called by Community builds.

## Switching back to the trial model (removing Community)

1. In `src/PDM.Licensing/ProductEdition.cs` set
   `public const ProductEdition Current = ProductEdition.Trial;`
2. Update the public text that describes Community, then search for "Community" and "8
   connections" to catch the rest:
   - `website/index.html`: hero line, comparison table, install steps, pricing card
   - `website/alternatives/internet-download-manager/index.html`: "Time Limit" row and connection rows
   - `website/features/index.html`, `website/faq/index.html`,
     `website/blog/speed-up-downloads-windows.html`, `website/blog/free-idm-alternative-windows.html`,
     `website/blog/how-multi-threaded-downloading-works.html`
   - `README.md` (Community Edition section), `docs/USER-GUIDE.md` (first launch, settings, activation)
3. Run the tests (`dotnet test PDM.sln`): all of them must still pass.
4. Release with a **higher version** (`./build/release.ps1`, see [DEPLOYMENT.md](DEPLOYMENT.md)).

What existing users then see: the trial window is measured from the install's first launch
(`LicenseRecord.FirstLaunchUtc`, recorded in Community too) or from the server trial anchor, so
anyone who installed more than 14 days earlier goes **straight to the reduced Free tier**. If they
should get a fresh trial instead, that needs a small code change (for example resetting the
trial start once when the edition changes); decide that before releasing.

Premium licences are unaffected by the switch, except that the "never less than Community" floor
no longer applies: a licence minted with low signed caps (`maxConn` / `maxParallel`) gets exactly
those caps again.

## Removing the Trial model for good (optional)

If Community is permanent, the Trial-only code can be deleted: `ProductEdition.Trial`, the trial
branch of `BuildSnapshot`, `ResolveTrialWindow`, `EnsureTrialAnchorAsync`, `TrialClaims` and its
verifier method, `LicenseEntitlements.Free`, the "Free plan" toasts in `MainWindow.axaml.cs`, the
popup's `IsLimitedPlan` notice, the trial-edition tests, and the `/trial` Lambda in
`backend/licensing/`. Keep `LicenseStatus` values stable (they are compared, not stored, but
renumbering gains nothing). Not done yet, deliberately, so the switch above keeps working.

## Premium licences

Keys are created in the admin portal or with `backend/licensing/admin/create-license.mjs`. The
signed token carries the owner name (shown on the badge), the licence period, and optional caps
(`maxConn`, `maxParallel`; 0 = no cap). Licences that existed before 1.5.0 keep working and show
Premium; any that were minted with free-tier caps are raised to the Community level by the floor.
