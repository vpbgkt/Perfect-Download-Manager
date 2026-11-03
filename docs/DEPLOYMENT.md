# Deployment guide

How to ship Perfect Download Manager (PDM). Written from the 1.4.0 release (2026-10-24), which
was done exactly this way.

| You changed... | Do this |
|---|---|
| The desktop app (`src/`, `installer/`) | [§3 Release the desktop app](#3-release-the-desktop-app) |
| The browser extension (`browser-extension/`) | [§4 Release the browser extension](#4-release-the-browser-extension) |
| Only the website (`website/`) | Push to `main`; Cloudflare deploys it ([§5](#5-website)) |
| The admin / reseller portal (`admin-portal/`) | [§6 Admin / reseller portal](#6-admin--reseller-portal) |

A desktop release is **one command** on a prepared machine:

```powershell
./build/release.ps1 -Version 1.4.1 -ReleaseNotes "Fixed X`nImproved Y" -YesToAll
```

It builds the installer, publishes it, and makes existing users see **"Update now"** in the app.

---

## 1. What is deployed where

All files are served from one public S3 bucket:
`https://pdm-updates-452359090613-aps1.s3.ap-south-1.amazonaws.com` (written `<S3>` below).

| What | Built by | Published to | Used by |
|---|---|---|---|
| `PDM-<v>-Setup.exe` (installer, ~20 MB) | `build-bundle.ps1` | `<S3>/downloads/` | Website download button |
| `PDM-<v>.msi` (same install, plain MSI) | `build-installer.ps1` | `<S3>/downloads/` | Website, IT admins |
| `pdm-<v>.zip` (portable app **and** update package) | `release.ps1` | `<S3>/stable/` | Website "portable", auto-update |
| `manifest.json` (signed: version, zip URL, SHA-256, notes) | `sign-release.ps1` | `<S3>/stable/` | Auto-update in installed apps |
| `downloads.json` (version, links, sizes) | `release.ps1` | `<S3>/stable/` | Website (refreshes the buttons) |
| Website | `website/` | Cloudflare, on push to `main` | perfectdownloadmanager.com |
| Browser extension zip | `pack-extension.ps1` | Chrome Web Store (by hand) | Chrome, Edge, Brave |

What ships inside the app (`dist/PDM/`, 11 files): `PDM.exe` (the app), `pdm-native-host.exe`
(browser-extension bridge), `pdm-update.exe` (applies updates), native libraries (Skia, ANGLE,
HarfBuzz, SQLite), `Assets/pdm.ico` and `tools/7-zip/`. All three executables are **NativeAOT**:
users need no .NET runtime and no Visual C++ redistributable (only the Universal C runtime that
every Windows 10/11 has).

---

## 2. Prepare a release machine (once)

| Tool | Install | Check |
|---|---|---|
| .NET 10 SDK | https://dotnet.microsoft.com/download (system-wide installer) | `dotnet --list-sdks` shows `10.x` |
| Visual Studio Build Tools 2022, C++ workload (NativeAOT linker) | see below | `release.ps1` checks it |
| Node.js 18+ | https://nodejs.org | `node --version` |
| AWS CLI v2, logged in to account `452359090613`, region `ap-south-1` | https://aws.amazon.com/cli/ | `aws sts get-caller-identity` shows `452359090613` |
| Git with push access to `github.com/vpbgkt/Perfect-Download-Manager` | | `git push --dry-run` |

Build Tools, from an **administrator** terminal:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

WiX (the installer builder) needs no install: it is a local dotnet tool (`dotnet-tools.json`,
v5.0.2) that the build scripts restore themselves. 7-Zip is downloaded by `fetch-7zip.ps1` on
first build.

The Visual C++ *Redistributable* is not the same thing as the Build Tools and is not enough.
Without the Build Tools, `release.ps1` stops at preflight; that is intended, because the
fallback build (`publish-aot-dist.ps1 -NoAot`) makes a larger installer (~26 MB) that starts in
~3 s instead of ~0.3 s.

---

## 3. Release the desktop app

### 3.1 Before you run it

1. **Pick the version.** Always higher than the live one (`X.Y.Z`); see [§8](#8-versions).
   Installed apps only update to a strictly higher version.
2. **Commit everything first, on `main`, and push.** `release.ps1` commits only `src/`,
   `installer/`, `build/`, `backend/`, `.github/` and the two website files it edits.
   `CHANGELOG.md`, `docs/`, `tests/` and `browser-extension/` must already be committed.
   ```powershell
   git checkout main; git pull
   git status            # must be clean
   ```
3. **Update `CHANGELOG.md`** with a section for the version (part of step 2).
4. **Run the tests:**
   ```powershell
   dotnet test PDM.sln
   node --test --test-force-exit browser-extension/tests/background.test.js
   ```
5. **Write the release notes**: one line per change, plain ASCII (no `→`, `•`, emoji).
   They appear in the app's update window and on the website changelog.

### 3.2 Run it

```powershell
./build/release.ps1 -Version 1.4.1 -ReleaseNotes "Line one`nLine two" -YesToAll
```

Without `-Version` / `-ReleaseNotes` it asks for them; without `-YesToAll` it asks before
publishing. It takes about 5-10 minutes. It prints progress after each stage and ends with
`==> Done: PDM <v> published on Stable channel.`

What it does, in order (nothing reaches users until stage 4):

| # | Stage | Details |
|---|---|---|
| 1 | Preflight | `dotnet`, `node`, `aws`, `git` present; C++ build tools present; AWS account is `452359090613`; tag `v<v>` does not exist locally or on GitHub |
| 2 | Patch website | `website/index.html`: title, version labels, download links. `website/changelog.html`: new section from the release notes |
| 3 | Build | `publish-aot-dist.ps1` → `dist/PDM/`; zip → `dist/PDM-<v>.zip`; `build-installer.ps1` → `dist/PDM-<v>.0.msi`; `build-bundle.ps1` → `dist/PDM-<v>.0-Setup.exe` |
| 4 | Publish | `backend/updates/sign-release.ps1` uploads the zip, signs `manifest.json` with the key in AWS SSM and uploads it (**this is the moment existing users are offered the update**); then MSI, Setup.exe and `downloads.json`; then checks every URL returns 200 |
| 5 | Git | Commit `release: PDM <v> - <first note line>`, tag `v<v>`, push branch and tags. Cloudflare deploys the website from the push |

### 3.3 Check the release

```powershell
$v = "1.4.1"; $base = "https://pdm-updates-452359090613-aps1.s3.ap-south-1.amazonaws.com"
(Invoke-RestMethod "$base/stable/manifest.json").Version      # -> 1.4.1
(Invoke-RestMethod "$base/stable/downloads.json").version     # -> 1.4.1
foreach ($u in "downloads/PDM-$v-Setup.exe", "downloads/PDM-$v.msi", "stable/pdm-$v.zip") {
    "{0}  {1}" -f (Invoke-WebRequest "$base/$u" -Method Head -UseBasicParsing).StatusCode, $u }
git ls-remote --tags origin "v$v"                             # tag is on GitHub
```

Then open https://perfectdownloadmanager.com (1-2 minutes after the push): the version label,
the download buttons and the changelog should show the new version.

### 3.4 How existing users get the update

On every start the app downloads `<S3>/stable/manifest.json`, checks its ECDSA signature
against the public key built into the app, and compares versions. If the manifest is newer, the
sidebar shows **"Update now"**; the update window shows the release notes. The app then
downloads the zip, checks its SHA-256 against the manifest, closes, and `pdm-update.exe`
replaces the program files and restarts PDM.

- Users on 1.3.2 or later get 1.4.x this way (tested for 1.3.2 → 1.4.0).
- The app refuses a manifest older than one it has already seen (anti-rollback), so you can
  never push users *back* to an old version; see [§7 Rollback](#7-rollback).

### 3.5 If something goes wrong

| Symptom | Cause and fix |
|---|---|
| `Visual Studio Build Tools ... not installed` | Install them ([§2](#2-prepare-a-release-machine-once)) |
| `AWS account is ..., expected 452359090613` | Log in with the right AWS profile: `aws sts get-caller-identity` |
| `Tag vX.Y.Z already exists` | That version was already released or tagged. Check `(Invoke-RestMethod "$base/stable/manifest.json").Version`. If it is live, you are done; otherwise use a new version, or release with `-SkipCommit` and tag by hand |
| Fails during **Build** | Nothing was published. Fix the error and run the same command again |
| Fails during **Publish** | Fix the cause, then re-run with `-SkipBuild` (reuses `dist/`; uploads overwrite the same files) |
| Fails during **Git** | Everything is live. Commit/tag/push by hand: `git add website/index.html website/changelog.html; git commit -m "release: PDM <v>"; git tag v<v>; git push; git push origin v<v>` |
| `sign-release.ps1 failed` | Usually AWS access to SSM parameter `/pdm/updates/private-key`. Check `aws ssm get-parameter --name /pdm/updates/private-key --with-decryption --region ap-south-1 --query Parameter.Name` |

Switches for retries: `-SkipBuild` (reuse `dist/`), `-SkipUpload` (no S3), `-SkipWebsite` (do not
edit the website), `-SkipCommit` (no git), `-YesToAll` (no prompt), `-Channel Beta` (publish to
`<S3>/beta/` for users who chose the Beta channel; the website is not touched).

The installer is **not code-signed** yet, so Windows SmartScreen shows "Windows protected your PC
→ More info → Run anyway" on first install. Updates are not affected: they are verified by the
signed manifest and SHA-256. See [§9](#9-code-signing-when-you-have-a-certificate).

---

## 4. Release the browser extension

1. Bump `"version"` in `browser-extension/chromium/manifest.json` and add a section to
   `browser-extension/CHANGELOG.md`.
2. Run the tests: `node --test --test-force-exit browser-extension/tests/background.test.js`
3. Pack it: `./build/pack-extension.ps1` → `dist/pdm-extension-<version>.zip` (files at the zip
   root, forward-slash paths, as the store requires).
4. Upload the zip at https://chrome.google.com/webstore/devconsole (extension ID
   `phbbcmofdbbojilmcpaghnafpamnocom`) and submit for review. Edge and Brave users install from
   the Chrome Web Store too. Store listing text and the review checklist:
   [EXTENSION-PUBLISHING.md](EXTENSION-PUBLISHING.md).
5. Commit and push the version bump.

The extension and the app talk through `pdm-native-host.exe`; keep new extension features
backward compatible with the app version users already have, and the other way round.

---

## 5. Website

`website/` is static, served by Cloudflare (`wrangler.json` → `assets.directory = ./website`).
**Every push to `main` deploys it**, usually within 1-2 minutes. Headers come from
`website/_headers`. `release.ps1` edits the version and links for you; for other changes just
edit, commit and push. The download buttons point at S3, so they work independently of the site.

Fallback if the git connection ever breaks: `npx wrangler deploy` (needs a Cloudflare API token).

---

## 6. Admin / reseller portal

A Next.js app in `admin-portal/`, meant for its own server (nginx + systemd). **It is not
deployed at the moment and has no domain yet**: when you deploy it, set `server_name` in
`admin-portal/deploy/nginx.conf` (currently the placeholder `portal.example.com`). It is
deployed separately from the desktop app. Setup, local
development, environment variables and the database scripts are in
[admin-portal/README.md](../admin-portal/README.md); the production files are
`admin-portal/deploy/nginx.conf`, `pdm-portal.service`, `portal.env.example` and
`iam-policy.json`.

```powershell
cd admin-portal
npm ci
npm test
npm run build      # then on the server: npm run start, behind nginx
```

---

## 7. Rollback

- **Bad app release:** release the last good code again with a **higher** version number (for
  example the 1.4.0 code as 1.4.2). Installed apps only move forward.
- **Website download buttons:** point `downloads.json` and the links in `website/index.html` at
  older files (all old versions stay in S3), then push.
- **Website content:** revert the commit and push, or roll back the deployment in Cloudflare.

---

## 8. Versions

| Where | Format | Example |
|---|---|---|
| App, zip, manifest, `-Version` | `X.Y.Z` | `1.4.0` |
| MSI / Setup.exe file name and `ProductVersion` | `X.Y.Z.0` (WiX needs 4 parts) | `PDM-1.4.0.0.msi` |
| Files in S3 | `X.Y.Z` | `downloads/PDM-1.4.0.msi` |
| Git tag | `vX.Y.Z` | `v1.4.0` |
| Browser extension | its own `X.Y.Z` in its manifest | `1.3.1` |

---

## 9. Code signing (when you have a certificate)

Not done yet; buy an OV or EV code-signing certificate to remove the SmartScreen warning (EV is
trusted immediately, OV builds reputation over time). Once it is in the Windows certificate
store:

- `publish-aot-dist.ps1 -CertThumbprint <sha1>` signs `PDM.exe`, `pdm-native-host.exe` and
  `pdm-update.exe`. `release.ps1` does not pass a thumbprint yet; add a `-CertThumbprint`
  parameter to it and forward it.
- `build/sign.ps1 -Thumbprint <sha1> -Paths dist/PDM-<v>.0.msi,dist/PDM-<v>.0-Setup.exe` signs
  the installers (sign the MSI before `build-bundle.ps1` wraps it).
- `build/new-dev-signing-cert.ps1` makes a self-signed certificate for testing the pipeline only.

---

## 10. Reference

### Build scripts (`build/`)

| Script | Purpose |
|---|---|
| `release.ps1` | The release: everything in [§3](#3-release-the-desktop-app) |
| `publish-aot-dist.ps1` | Builds `dist/PDM/` (NativeAOT; `-NoAot` for the trimmed fallback) |
| `build-installer.ps1` | `dist/PDM/` → MSI (WiX, `installer/Package.wxs`) |
| `build-bundle.ps1` | MSI → `Setup.exe` (WiX Burn, `installer/Bundle.wxs`) |
| `fetch-7zip.ps1` | Downloads the bundled 7-Zip into `third-party/7-zip/` |
| `pack-extension.ps1` | Browser extension → store zip |
| `aot-harness.ps1` | CI check that the app still builds and downloads with NativeAOT |
| `sign.ps1`, `new-dev-signing-cert.ps1` | Code signing ([§9](#9-code-signing-when-you-have-a-certificate)) |

### Fixed infrastructure

| Thing | Value |
|---|---|
| AWS account / region | `452359090613` / `ap-south-1` |
| Update bucket (public read) | `pdm-updates-452359090613-aps1` |
| Update signing key (ECDSA P-256) | SSM SecureString `/pdm/updates/private-key`; public key in `LicensingConfig.UpdatePublicKeyBase64` |
| License signing key | SSM SecureString `/pdm/licensing/private-key` |
| License table | DynamoDB `pdm-licenses` |
| Portal tables | DynamoDB `pdm-portal-*`, created by `admin-portal/deploy/dynamodb/create-tables.ps1` |
| Chrome Web Store extension ID | `phbbcmofdbbojilmcpaghnafpamnocom` |
| Website | https://perfectdownloadmanager.com (Cloudflare) |

### One-time infrastructure (already created)

- **Update bucket and signing key:** `backend/updates/deploy.ps1` (CloudFormation
  `backend/updates/template.yaml`). `-RotateKeys` makes a new key; every installed app then
  rejects updates until it gets a build with the new public key, so do not rotate casually.
- **Licensing backend:** `backend/licensing/deploy.ps1` (DynamoDB + Lambda + API Gateway);
  `node backend/licensing/verify-deployment.mjs` checks it.

### Secrets

Never commit secrets. Keys live only in AWS SSM and are fetched when used; `release.ps1` refuses
to commit files that look like keys (`*.pem`, `*.pfx`, `*.key`, `.env*`). `dist/` is gitignored.
If a key leaks, rotate it.
