1# PDM Deployment & Release Runbook

The single reference for shipping Perfect Download Manager after code changes. It covers the
**desktop app** (build → installer → signed auto-update), the **marketing website**, the
**browser extension**, and the **admin/reseller portal**.

> TL;DR for a normal desktop release: run **`./build/release.ps1`**. It prompts for the version
> tag, patches every website version marker, builds the NativeAOT dist, signs and uploads the
> update package + MSI + Setup.exe + `downloads.json` to S3, HEAD-verifies every URL is live,
> commits `src/` + `installer/` + `build/` + `backend/` + the patched website files, tags
> `vX.Y.Z`, and pushes both the branch and the tag. Full details in
> [§5 Desktop app release](#5-desktop-app-release-the-main-flow); flags/switches in
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

This is what you run after changing any desktop code (`src/**`, `installer/**`). A release is a
single command:

```powershell
./build/release.ps1                           # prompts for version + release notes
./build/release.ps1 -Version 1.2.3            # non-interactive version
./build/release.ps1 -Version 1.2.3 -ReleaseNotes "Fixed X.`nImproved Y."
./build/release.ps1 -Version 1.3.0-rc.1 -Channel Beta
```

Useful switches when retrying a partially-failed release:

- `-SkipBuild`   — reuse whatever is already in `dist/` (fast retry of the upload/commit steps).
- `-SkipUpload`  — skip the S3 publish (patch website + commit only).
- `-SkipWebsite` — leave `website/index.html` and `website/changelog.html` untouched.
- `-SkipCommit`  — do everything except `git commit` / `git tag` / `git push`.
- `-YesToAll`    — no confirmation prompt before the destructive steps.

What `release.ps1` actually does, in order:

1. **Preflight** — checks `dotnet` / `node` / `aws` / `git` are on PATH, verifies the AWS account
   is `452359090613`, and refuses to proceed if `vX.Y.Z` already exists locally or on origin.
2. **Patch website** — regex-updates `<title>`, the JSON-LD `softwareVersion` and `downloadUrl`,
   every `data-version` span, and the `#dlMsi`/`#dlZip` hrefs in `website/index.html`; prepends a
   new `<section>` for the version in `website/changelog.html`. Idempotent.
3. **Build** — one path only, no runtime prerequisite:
   - `./build/publish-aot-dist.ps1 -Version <v>` — assembles the **NativeAOT** dist at
     `dist/PDM/`: `PDM.exe` (Avalonia head), `pdm-native-host.exe`, `pdm-update.exe`, plus native
     deps (SQLite, Skia, ANGLE, HarfBuzz). All self-contained; no .NET runtime install needed.
   - Then zips `dist/PDM/*` -> `dist/PDM-<v>.zip` (this is the portable + auto-update package).
   - Then `./build/build-installer.ps1 -Version <v>.0` -> `dist/PDM-<v>.0.msi`.
   - Then `./build/build-bundle.ps1 -Version <v>.0` -> `dist/PDM-<v>.0-Setup.exe` (single-file
     wrapper around the MSI; because the payload is already runtime-free, the bootstrapper is a
     familiar-looking Setup.exe rather than a runtime downloader).
4. **Publish to S3** — `sign-release.ps1` signs+uploads the zip and manifest;
   `aws s3 cp` uploads the MSI and Setup.exe; generates + uploads `downloads.json`. Every URL is
   HEAD-checked (must return 200).
5. **Git** — stages **only** `src/`, `installer/`, `build/`, `backend/`, and the two patched
   website files (never `git add .`); a secret-scan on staged files aborts if anything looks like a
   key; commits, tags `vX.Y.Z`, pushes both branch and tags.

The MSI is **unsigned** (no code-signing cert), so Windows SmartScreen shows a
"More info -> Run anyway" prompt on first install. The *auto-updater* is still safe: every
package is ECDSA-signed and SHA-256 verified before it runs.

**Old-flow scripts that no longer exist** (deleted after 1.2.2 to prevent picking the wrong tree):

- `build/publish.ps1` — used to publish the framework-dependent WPF head (`src/PDM.App`).
- `build/publish-avalonia-aot.ps1` — redundant single-project AOT check.

If you ever see either name in a doc or CI, retarget to `build/release.ps1` (releases) or
`build/publish-aot-dist.ps1` (dist assembly only).

`website/assets/js/main.js` still refreshes version/size/links from `downloads.json` at
runtime, but the static hrefs guarantee the buttons work even before JS runs.

### 5.6 What `release.ps1` intentionally does **not** stage in git

`dist/` is gitignored; the MSI/ZIP/Setup.exe live in S3 only. The script never commits any
secret file: `.env*.local`, `firebase-service-account.json`, `*.pem`, `*.pfx`, `*.p12`, `*.key`
are all either gitignored or blocked by the pre-commit secret-scan inside `release.ps1`. If the
scan flags a staged file, the script aborts BEFORE committing so you can un-stage the file and
re-run.

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
./build/release.ps1                    # prompts for version + notes, does the whole flow
./build/release.ps1 -Version 1.2.3     # non-interactive
./build/release.ps1 -Version 1.2.3 -ReleaseNotes "Fixed X.`nImproved Y."
```

That single command: preflights AWS + git, patches every version marker on the website, builds
the NativeAOT dist + zip + MSI + Setup.exe, signs and uploads the update package + installer +
`downloads.json` to S3, HEAD-verifies every URL, commits (`src/` + `installer/` + `build/` +
`backend/` + patched website files), tags `vX.Y.Z`, and pushes both branch and tags. Cloudflare
Pages redeploys the site off the `main` push automatically.

Retrying after a partial failure (all switches):
```powershell
./build/release.ps1 -Version 1.2.3 -SkipBuild            # re-run upload/commit only
./build/release.ps1 -Version 1.2.3 -SkipUpload           # patch website + commit only
./build/release.ps1 -Version 1.2.3 -SkipCommit           # do everything except git
./build/release.ps1 -Version 1.2.3 -YesToAll             # no confirmation prompt
./build/release.ps1 -Version 1.3.0-rc.1 -Channel Beta    # publish to stable/beta/
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
