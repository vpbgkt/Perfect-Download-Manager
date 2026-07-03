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

## Layer 1 — Unforgeable licenses (the strongest protection)

Entitlements ride on a **server-signed token**, not a local flag.

- The licensing server (AWS Lambda) holds an **ECDSA P-256 private key** in SSM Parameter Store
  (SecureString, KMS-encrypted). It never leaves AWS.
- On activation/validation the server returns a token: `base64url(claims).base64url(signature)`,
  where the claims include the license key, the machine fingerprint, and a short expiry.
- The client embeds only the **public key** and verifies the signature locally
  (`LicenseTokenVerifier`). It also checks the signed fingerprint matches this machine and the
  token has not expired.

Consequence: an attacker **cannot mint a valid license** without the server's private key.
Returning `valid: true` from a patched network layer does nothing — there is no signed token, so
verification fails. This is the same model Keygen and other serious licensing systems use.

What patching *can* still do: bypass the check entirely (e.g. force `IsFunctional = true`). We
raise the cost of that with Layers 2–4, but cannot make it impossible on the client.

## Layer 2 — Machine binding & short-lived tokens

- Tokens are bound to a hardware fingerprint (Windows machine GUID + system volume serial,
  SHA-256; raw identifiers are never stored or transmitted).
- A copied `license.dat` will not validate on another machine (fingerprint mismatch).
- Tokens are short-lived (server TTL, default 14 days). The client must re-validate online
  periodically; a revoked or moved license stops working after at most one TTL + grace window.
- Offline tolerance is exactly the token TTL + grace — long enough for outages, short enough to
  enforce revocation.

## Layer 3 — Tamper detection

- **Key-swap detection**: the embedded public key is pinned by SHA-256 (`LicensingConfig.PublicKeyHash`).
  If an attacker replaces the key with their own (to sign their own tokens), `TamperGuard`
  detects the mismatch at startup and disables activation (falls back to trial-only) rather than
  trusting attacker-signed tokens.
- **Debugger detection**: `TamperGuard.IsDebuggerPresent()` detects managed and native debuggers
  (`IsDebuggerPresent`, `CheckRemoteDebuggerPresent`). Used as friction, not a hard gate, to avoid
  penalising legitimate power users.
- **At-rest protection**: the local license record is encrypted with Windows DPAPI (current-user
  scope + static entropy), so the trial start and token cannot be trivially edited on disk.

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
