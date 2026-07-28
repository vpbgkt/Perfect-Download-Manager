# PDM Security & Anti-Tamper Model

This document describes the measures that protect Perfect Download Manager against
reverse engineering, license forgery, tampering, and cracking — and, honestly, their limits.

## The honest reality of client-side protection

PDM runs entirely on the user's machine. Any check the client performs, a sufficiently
determined attacker with a debugger and time can eventually locate and patch. This is true of
**every** locally-installed commercial application, including IDM itself. There is no client-side
technique that makes a native/managed desktop app uncrackable.

Our strategy therefore is **defense in depth**: make forging a *legitimate* license
cryptographically impossible, and make *patching out* the checks expensive and fragile — enough
that casual cracking fails, automated tools don't work out of the box, and each new release
breaks existing patches. Where the real value can be kept server-side, it is.

## Layer 1 — Unforgeable licenses + signed entitlements (the strongest protection)

Entitlements ride on a **server-signed token**, not a local flag.

- The licensing server (AWS Lambda) holds an **ECDSA P-256 private key** in SSM Parameter Store
  (SecureString, KMS-encrypted). It never leaves AWS.
- On activation/validation the server returns a token: `base64url(claims).base64url(signature)`,
  where the claims include the license key, the machine fingerprint, a short expiry, and the
  **numeric entitlements** `maxConn` / `maxParallel`.
- The client embeds only the **public key** and verifies the signature locally
  (`LicenseTokenVerifier`). It also checks the signed fingerprint matches this machine and the
  token has not expired.

**Signed entitlements (C1).** The premium download throughput (per-download connection count and
simultaneous-download count) is derived from the *signed numbers in the token* — not from a local
`IsFunctional` boolean. Those numbers only exist inside a token this server signed, so forcing a
status flag on a patched client cannot fabricate premium throughput; the free/expired tier resolves
to fixed throttled defaults. This closes the "flip one boolean to unlock everything" gap: there is
no single boolean to flip, and the value an attacker would need is cryptographically gated.

Consequence: an attacker **cannot mint a valid license** without the server's private key, and
cannot conjure premium entitlements by patching a flag. Returning `valid: true` from a patched
network layer does nothing — there is no signed token, so verification fails.

## Layer 2 — Machine binding, short-lived tokens & anti-rollback

- Tokens are bound to a hardware fingerprint anchored on the **SMBIOS firmware UUID** (read from
  firmware via `GetSystemFirmwareTable`) plus the Windows machine GUID, SHA-256'd; raw identifiers
  are never stored or transmitted. The firmware UUID resists the spoofing/reset tricks that a
  registry-only or volume-serial fingerprint is vulnerable to.
- A copied `license.dat` will not validate on another machine (fingerprint mismatch).
- Tokens are short-lived (server TTL, default 14 days). The client must re-validate online
  periodically; a revoked or moved license stops working after at most one TTL + grace window.
- **Clock-rollback guard (H3):** a persisted monotonic watermark (`MaxSeenUtc`) means trial/token
  expiry is evaluated against `max(systemClock, watermark)`, so winding the system clock back
  cannot extend a trial or revive an expired token.

## Layer 3 — Tamper detection

- **Key-swap detection (C2):** a fixed **canary token**, signed by the licensing *private* key at
  key-generation time (`admin/generate-canary.mjs`), is embedded in the client and verified at
  startup with the embedded public key. If an attacker swaps the public key for their own to sign
  forged tokens, the canary no longer verifies and activation is disabled. Unlike a self-referential
  SHA pin (which an attacker recomputes for their own key), producing a valid canary requires the
  server's private key.
- **Authenticode self-integrity (C3):** `TamperGuard.VerifySelfIntegrity()` verifies the running
  executable's signature via `WinVerifyTrust`. On a **signed** release, any post-sign modification —
  including swapping the embedded key or patching a check — invalidates the signature; the app then
  quietly degrades to the free tier (after a randomized, decoupled delay, so the response is hard to
  locate). An unsigned dev build reports "Unsigned" and is never punished.
- **Debugger detection:** `TamperGuard.IsDebuggerPresent()` detects managed and native debuggers.
  Runs in a background monitor as friction/telemetry, not a hard gate, to avoid penalising power
  users.
- **At-rest protection:** the local license record is encrypted with Windows DPAPI (current-user
  scope + static entropy), so the trial start and token cannot be trivially edited on disk.
- **DLL search-path hardening (M2):** the app and the update launcher call
  `SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_DEFAULT_DIRS)` and clear the CWD from the loader
  path before any native dependency resolves, defeating DLL-planting/search-order hijacks against
  the per-user install and the `%TEMP%`-hosted launcher.

## Layer 4 — Raising the analysis bar

- **Release builds strip symbols** (`Directory.Build.props`: no PDB, optimized, deterministic).
- **Obfuscation** (`build/obfuscate.ps1` + `build/obfuscar.xml`): the security-sensitive
  `PDM.Licensing` assembly can be obfuscated (private-member renaming, control-flow obfuscation,
  string hiding) while preserving its public API. The WPF UI assembly is intentionally not
  obfuscated because XAML data-binding resolves member names as strings at runtime.
- **`SuppressIldasm`** attribute is added during obfuscation.

To enable for a release:
```powershell
dotnet build -c Release
./build/obfuscate.ps1
```

## Operational security

- The signing **private key exists only in AWS SSM**; the repository contains only the public key
  and API URL, which are safe to publish.
- All backend SQL/DynamoDB access is parameterized; API Gateway enforces throttling
  (20 burst / 10 rps) to blunt brute-force and abuse.
- The activation endpoint enforces a per-license **activation cap** with a conditional DynamoDB
  update, so a single key cannot be spread across unlimited machines.
- **Per-IP trial rate limiting (M1):** `/trial` is throttled per source IP via a DynamoDB
  fixed-window counter (default 20/hour, TTL-cleaned) to blunt fingerprint-rotation trial farming.
  Fails open so a limiter error never blocks a legitimate trial.
- **Update anti-rollback (M4):** the client records the highest update version it has been offered
  and rejects a later validly-signed but *older* manifest (a MITM replaying a stale release to
  suppress a security update).
- **Code signing:** `build/publish-aot-dist.ps1 -CertThumbprint <hash>` Authenticode-signs the
  three shipped executables; this is the anchor that makes the runtime self-integrity check
  meaningful.
- Rotating the signing key (`deploy.ps1 -RotateKeys`) invalidates all existing tokens; update the
  embedded public key + pinned hash and ship a new build.

## What we deliberately do NOT claim

- We do **not** claim the app is uncrackable. It is not; nothing client-side is.
- We do claim: licenses cannot be **forged**, copied licenses do **not** transfer between machines,
  revocation **propagates**, and casual/automated cracking is **defeated** while each release
  invalidates prior patches.

## Recommended future hardening (optional)

- Move a genuinely valuable, server-only capability behind the license (e.g. a cloud feature) so
  that a cracked client loses real functionality, not just a flag.
- Commercial anti-tamper/packer (e.g. a hardened .NET protector) for higher-value releases.
- Code signing (see docs/REMAINING-WORK.md) to establish OS-level trust and prevent silent binary
  modification warnings.
