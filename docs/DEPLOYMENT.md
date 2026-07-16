# PDM Deployment & Release Runbook

The single reference for shipping Perfect Download Manager after code changes. It covers the
**desktop app** (build → installer → signed auto-update), the **marketing website**, the
**browser extension**, and the **admin/reseller portal**.

> TL;DR for a normal desktop release: bump the version, run `publish.ps1`,
> `build-installer.ps1`, `sign-release.ps1`, upload the MSI + `downloads.json`, update the
> website version/links, commit, tag. Full copy‑paste block is in
> [§9 Quick reference](#9-quick-reference-typical-desktop-release).

---

## 1. Components & repo layout

| Area | Path | Ships to |
|---|---|---|
| Desktop app (WPF, .NET 10) | `src/PDM.App`, `src/PDM.NativeHost`, `src/PDM.UpdateLauncher`, `src/PDM.Core`, … | S3 (auto-update) + website (MSI) |
| Installer (WiX v5) | `installer/Package.wxs` | S3 `downloads/` |
| Build scripts | `build/*.ps1` | — |
| Release signing | `backend/updates/sign-release.ps1` | S3 `stable/` |
| Update infra (one-time) | `backend/updates/deploy.ps1`, `backend/updates/template.yaml` | AWS CloudFormation |
| Browser extension (MV3) | `browser-extension/chromium`, `build/pack-extension.ps1` | Chrome Web Store |
| Marketing website (static) | `website/`, `wrangler.json`, `build/pack-website.ps1` | Cloudflare (apex domain) |
| Admin/Reseller portal (Next.js) | `admin-portal/`, `admin-portal/deploy/*` | VPS (`seller.` subdomain) |

---

## 2. Prerequisites (build machine)

- **.NET SDK 10** (`dotnet --version` → `10.x`)
- **WiX** — installed automatically as a local dotnet tool by `build-installer.ps1` (pins v5.0.2)
- **Node.js** (used by the release signer, the website tooling, and the portal)
- **AWS CLI**, configured for account **`452359090613`**, region **`ap-south-1`**
  (`aws sts get-caller-identity` should show that account)
- **PowerShell** (all build/release scripts are `.ps1`)
- Git access to `github.com/vpbgkt/Perfect-Download-Manager`

---

## 3. Fixed infrastructure facts

| Thing | Value |
|---|---|
| AWS account / region | `452359090613` / `ap-south-1` |
| Updates S3 bucket (public read, CORS GET \*) | `pdm-updates-452359090613-aps1` |
| Auto-update manifest (signed) | `s3://…/stable/manifest.json` |
| Update/portable package | `s3://…/stable/pdm-<version>.zip` |
| Website MSI | `s3://…/downloads/PDM-<version>.msi` |
| Website download metadata | `s3://…/stable/downloads.json` |
| Release signing key (ECDSA P-256) | SSM SecureString `/pdm/updates/private-key` |
| License signing key | SSM SecureString `/pdm/licensing/private-key` |
| License table | DynamoDB `pdm-licenses` |
| Portal tables | DynamoDB `pdm-portal-*` (7) — see `admin-portal/deploy/dynamodb/` |
| Chrome Web Store extension ID | `phbbcmofdbbojilmcpaghnafpamnocom` |
| Firebase project (portal auth) | `perfect-download-manager` |
| Public site | `https://perfectdownloadmanager.com` (Cloudflare) |
| Portal site | `https://seller.perfectdownloadmanager.com` (VPS) |

**Base URL used in links:**
`https://pdm-updates-452359090613-aps1.s3.ap-south-1.amazonaws.com`

---

## 4. Versioning rules

- App / zip / manifest version: **`X.Y.Z`** (e.g. `1.0.17`).
- MSI `ProductVersion`: **`X.Y.Z.0`** (4-part; WiX requirement).
- **Auto-update triggers only when the manifest `Version` is strictly greater than the
  installed version.** Always bump `X.Y.Z` for every release, or existing users won't update.
- Git tag: **`vX.Y.Z`**.
- Keep the MSI and the portable ZIP on the **same version** so the website is consistent.

---

## 5. Desktop app release (the main flow)

This is what you run after changing any desktop code (`src/**`, `installer/**`). Example uses
version `1.0.18` — substitute your new version.

### 5.1 Build the app payload
```powershell
# From repo root. Produces dist/PDM/ and dist/PDM-1.0.18.zip
./build/publish.ps1 -Version 1.0.18
# Add -SelfContained to bundle the .NET runtime (bigger, no prerequisite on the user's PC).
```
- The UpdateLauncher is always published self-contained single-file.
- The browser extension is **no longer** bundled (it's on the Chrome Web Store).
- `dist/PDM-1.0.18.zip` is both the **portable** download and the **auto-update package**.

### 5.2 Build the MSI installer
```powershell
# Requires 5.1 to have run first. Produces dist/PDM-1.0.18.0.msi
./build/build-installer.ps1 -Version 1.0.18.0
```
The MSI is **unsigned** (no code-signing cert), so Windows SmartScreen shows a
"More info → Run anyway" prompt on first install. The *auto-updater* is still safe: every
package is ECDSA-signed and SHA-256 verified before it runs.

### 5.3 Sign & publish the auto-update (existing users update from here)
```powershell
./backend/updates/sign-release.ps1 -Version 1.0.18 -Channel Stable `
    -ReleaseNotes "What changed in this release."
```
This computes the ZIP's size + SHA-256, signs a manifest with the SSM key, and uploads:
- `s3://pdm-updates-452359090613-aps1/stable/pdm-1.0.18.zip`
- `s3://pdm-updates-452359090613-aps1/stable/manifest.json` (Version `1.0.18`, signed)

Every client on the **Stable** channel with a version `< 1.0.18` will offer the update on its
next "Check for Updates". (Use `-Channel Beta` for a beta ring → `beta/manifest.json`.)

### 5.4 Upload the MSI for the website
`sign-release.ps1` publishes the ZIP but not the MSI, so upload it explicitly:
```powershell
aws s3 cp dist/PDM-1.0.18.0.msi `
    s3://pdm-updates-452359090613-aps1/downloads/PDM-1.0.18.msi `
    --content-type "application/x-msi" --region ap-south-1
```

### 5.5 Publish `downloads.json` (drives the website buttons)
Get the exact byte sizes and write the metadata file:
```powershell
$msi = (Get-Item dist/PDM-1.0.18.0.msi).Length
$zip = (Get-Item dist/PDM-1.0.18.zip).Length
@{
  version           = "1.0.18"
  msiUrl            = "https://pdm-updates-452359090613-aps1.s3.ap-south-1.amazonaws.com/downloads/PDM-1.0.18.msi"
  msiSizeBytes      = $msi
  portableZipUrl    = "https://pdm-updates-452359090613-aps1.s3.ap-south-1.amazonaws.com/stable/pdm-1.0.18.zip"
  portableSizeBytes = $zip
} | ConvertTo-Json | Set-Content dist/downloads.json -NoNewline

aws s3 cp dist/downloads.json `
    s3://pdm-updates-452359090613-aps1/stable/downloads.json `
    --content-type "application/json" --cache-control "public, max-age=300" --region ap-south-1
Remove-Item dist/downloads.json
```

### 5.6 Point the website at the new version
Edit `website/index.html`:
- Both `<span data-version>…</span>` → `1.0.18` (hero eyebrow + download heading).
- `<title>` version → `1.0.18`.
- `#dlMsi` `href` → `…/downloads/PDM-1.0.18.msi`
- `#dlZip` `href` → `…/stable/pdm-1.0.18.zip`
- SoftwareApplication JSON-LD (`<script type="application/ld+json">` in `<head>`):
  `softwareVersion` → `1.0.18` and `downloadUrl` → `…/downloads/PDM-1.0.18.msi`.

`website/assets/js/main.js` still refreshes version/size/links from `downloads.json` at
runtime, but the static hrefs guarantee the buttons work even before JS runs.

### 5.7 Verify everything is live
```powershell
$b = "https://pdm-updates-452359090613-aps1.s3.ap-south-1.amazonaws.com"
"$b/stable/manifest.json","$b/stable/pdm-1.0.18.zip","$b/downloads/PDM-1.0.18.msi","$b/stable/downloads.json" |
  ForEach-Object { "{0}  {1}" -f (Invoke-WebRequest $_ -Method Head -UseBasicParsing).StatusCode, $_ }
```
All should return `200`.

### 5.8 Commit source + tag (never commit `dist/` binaries)
```powershell
git add src/ installer/ build/ website/index.html
git commit -m "release: PDM 1.0.18 — <summary>"
git tag v1.0.18
git push
git push --tags
```
> `dist/` is gitignored; the MSI/ZIP live in S3 only. Do **not** commit `.env.local`,
> `admin-portal/firebase-service-account.json`, or any key.

---

## 6. Marketing website deploy (Cloudflare)

The site is static (`website/`), served by Cloudflare Workers Static Assets. Config:
`wrangler.json` (root) → `assets.directory = ./website`.

**Deploy options:**
- **Git-connected (current setup):** push to the branch Cloudflare builds from → it deploys
  automatically. If Cloudflare tracks `main`, merge your branch first.
- **CLI:** `npx wrangler deploy` (needs a Cloudflare API token).
- **Drag-and-drop:** `./build/pack-website.ps1` → upload `dist/pdm-website-<ver>.zip` in the
  dashboard (Workers & Pages → Create → Upload assets).

Notes:
- Security/cache headers come from `website/_headers`.
- The S3 downloads work independently of the site deploy — the buttons resolve to S3 URLs.
- Use `wrangler.json` (not `.jsonc`); a second config file causes a Cloudflare warning/conflict.

---

## 7. Browser extension release (Chrome Web Store)

```powershell
# 1. Bump "version" in browser-extension/chromium/manifest.json
# 2. Pack a store-ready zip (files at archive root)
./build/pack-extension.ps1            # or -Version 1.2.6
# 3. Upload dist/pdm-extension-<ver>.zip at
#    https://chrome.google.com/webstore/devconsole
```
The published extension ID is permanent (`phbbcmofdbbojilmcpaghnafpamnocom`) and is
pre-authorised by the app on startup, so users just click **Add to Chrome** — no sideloading.
Chrome, Edge, and Brave all install from the Chrome Web Store.

---

## 8. Admin / Reseller portal (`admin-portal/`)

### 8.1 Local dev (no AWS, no Resend)
`admin-portal/.env.local` with `PORTAL_LOCAL_DEV=1` uses an in-memory store + a seeded admin,
OTP disabled. Then:
```powershell
cd admin-portal
npm install
npm run dev        # http://localhost:3000
npm test           # 239 property/unit tests
```

### 8.2 Real AWS mode
1. Create the tables (idempotent, create-only):
   `./admin-portal/deploy/dynamodb/create-tables.ps1`
2. Seed a super_admin:
   `./admin-portal/deploy/dynamodb/seed-admin.ps1 -Uid <firebaseUid> -Email <email>`
   (reseller test login: `seed-reseller-login.ps1 -Uid … -Email … -ResellerAccountId …`)
3. In `.env.local` set `PORTAL_LOCAL_DEV=0`. Remove `PORTAL_DISABLE_OTP=1` to require the
   email-OTP factor (needs a valid `RESEND_API_KEY` + verified sender).
4. AWS creds come from the machine's configured profile (or `AWS_ACCESS_KEY_ID/SECRET`).

### 8.3 Production (VPS at `seller.perfectdownloadmanager.com`)
- Build & run: `npm run build` then `npm run start` (Node 24).
- Reverse proxy / TLS: `admin-portal/deploy/nginx.conf` (HTTPS-only).
- Process supervision: `admin-portal/deploy/pdm-portal.service` (systemd).
- Least-privilege IAM: `admin-portal/deploy/iam-policy.json`.
- Add `seller.perfectdownloadmanager.com` to Firebase → Authentication → Authorized domains.

---

## 9. Quick reference (typical desktop release)

```powershell
$V = "1.0.18"                       # app version
$MV = "$V.0"                        # MSI ProductVersion

./build/publish.ps1 -Version $V
./build/build-installer.ps1 -Version $MV
./backend/updates/sign-release.ps1 -Version $V -Channel Stable -ReleaseNotes "…"

aws s3 cp "dist/PDM-$MV.msi" "s3://pdm-updates-452359090613-aps1/downloads/PDM-$V.msi" `
    --content-type "application/x-msi" --region ap-south-1

$msi = (Get-Item "dist/PDM-$MV.msi").Length
$zip = (Get-Item "dist/PDM-$V.zip").Length
@{ version=$V
   msiUrl="https://pdm-updates-452359090613-aps1.s3.ap-south-1.amazonaws.com/downloads/PDM-$V.msi"
   msiSizeBytes=$msi
   portableZipUrl="https://pdm-updates-452359090613-aps1.s3.ap-south-1.amazonaws.com/stable/pdm-$V.zip"
   portableSizeBytes=$zip } | ConvertTo-Json | Set-Content dist/downloads.json -NoNewline
aws s3 cp dist/downloads.json "s3://pdm-updates-452359090613-aps1/stable/downloads.json" `
    --content-type "application/json" --cache-control "public, max-age=300" --region ap-south-1
Remove-Item dist/downloads.json

# then edit website/index.html versions+hrefs, commit src/ + website, tag vX.Y.Z, push,
# and redeploy the website (Cloudflare).
```

---

## 10. Rollback

- **Auto-update:** re-run `sign-release.ps1` for the *previous good* version but with a
  **higher** version number (e.g. re-tag `1.0.16` content as `1.0.19`) — clients only move
  forward. You cannot "downgrade" via the manifest by lowering the version.
- **Website download:** re-point `downloads.json` + the `index.html` hrefs to a prior
  `PDM-<old>.msi` / `pdm-<old>.zip` that still exist in S3, and redeploy the site.
- **Website content:** revert the commit and redeploy (or roll back the Cloudflare deployment
  in the dashboard).

---

## 11. One-time infrastructure (already done — for reference / disaster recovery)

- **Update bucket + signing key:** `./backend/updates/deploy.ps1` (creates the S3 bucket via
  CloudFormation and generates the ECDSA signing key in SSM; prints the public key to embed in
  the client as `LicensingConfig.UpdatePublicKeyBase64`). `-RotateKeys` replaces the key
  (invalidates all previously signed manifests — clients need the new public key baked in).
- **Licensing backend:** `backend/licensing/` (DynamoDB `pdm-licenses` + activate/validate/
  trial Lambdas + API Gateway).
- **Portal tables:** `admin-portal/deploy/dynamodb/create-tables.ps1`.

---

## 12. Security notes

- **Never commit secrets.** Gitignored: `admin-portal/.env.local`, `admin-portal/*.env`,
  `admin-portal/firebase-service-account.json`, `dist/`, `*.pem`.
- The MSI is unsigned — get an EV/OV code-signing certificate and `signtool` the MSI + EXEs to
  remove the SmartScreen prompt for public distribution.
- Signing keys live only in SSM SecureString and are fetched at use-time; they are never
  written to git, logs, or client responses.
- If a key or token is ever exposed, rotate it (Firebase service account, Resend API key,
  and — with `deploy.ps1 -RotateKeys` — the update signing key).
