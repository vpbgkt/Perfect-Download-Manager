# Requirements Document

## Introduction

The Marketing_Website is the public product site for Perfect Download Manager (PDM), served at
`https://perfectdownloadmanager.com`. It exists to do four jobs: sell the download, support
existing users, publish releases, and host browser-extension install links. The site is a
plain static bundle (HTML, CSS, vanilla JavaScript) hosted on Cloudflare Pages, built and
deployed directly from the `website/` subfolder of the PDM GitHub repository on every push to
`main`, with no build step and no server-side logic.

Version 1 of the site ships five pages: `/` (Home), `/download`, `/features`, `/extension`,
and `/support`. Pricing, docs mirror, blog, and R2-hosted downloads are explicitly deferred.

Download links for the MSI and portable zip point at the existing signed S3 objects in the
`pdm-updates-452359090613-aps1` bucket (region `ap-south-1`), and their published SHA-256
checksums are copied from the ECDSA-signed release manifest that the desktop auto-updater
already trusts. A CI check verifies every internal link resolves and every external download
link returns HTTP 200 before the deployment is promoted, so a broken `/download` page cannot
reach production.

## Glossary

- **Marketing_Website**: The full static site served at `perfectdownloadmanager.com`,
  comprising all pages, assets, and configuration in the repository's `website/` folder.
- **Home_Page**: The page served at path `/` (equivalently `/index.html`).
- **Download_Page**: The page served at path `/download` (equivalently `/download/index.html`).
- **Features_Page**: The page served at path `/features`.
- **Extension_Page**: The page served at path `/extension`.
- **Support_Page**: The page served at path `/support`.
- **Site_Page**: Any one of Home_Page, Download_Page, Features_Page, Extension_Page, or
  Support_Page.
- **MSI_Installer**: The signed Windows MSI package published for the current PDM release,
  hosted at a fixed S3 URL under `s3://pdm-updates-452359090613-aps1/`.
- **Portable_Zip**: The signed portable/update zip published for the current PDM release,
  hosted at a fixed S3 URL under `s3://pdm-updates-452359090613-aps1/`.
- **Release_Manifest**: The ECDSA-signed JSON manifest already produced by
  `backend/updates/sign-release.ps1` and uploaded to the same S3 bucket, containing the
  version, download URLs, and SHA-256 hashes for the MSI_Installer and Portable_Zip.
- **Published_Checksum**: A SHA-256 hex string displayed on the Download_Page next to a
  download link, copied verbatim from the Release_Manifest for the current release.
- **Logo_Source**: The multi-resolution icon at `src/PDM.App/Assets/pdm.ico` in the PDM
  repository.
- **Web_Logo_Assets**: The set of PNG derivatives generated from Logo_Source and stored under
  `website/assets/`, comprising favicon-16, favicon-32, header-logo, apple-touch-180, and
  social-preview-1200x630.
- **Deployment_Pipeline**: The Cloudflare Pages project that auto-deploys the `website/`
  subfolder of the repository on every push to `main` and produces preview URLs for pull
  requests.
- **Preview_Deployment**: A Cloudflare Pages deployment produced automatically for a pull
  request, addressable at a unique `*.pages.dev` URL.
- **Production_Deployment**: The Cloudflare Pages deployment that is served at
  `https://perfectdownloadmanager.com`.
- **Link_Checker**: The GitHub Actions job that runs on every pull request and every push to
  `main` and verifies internal and external links on the site.
- **Cloudflare_Web_Analytics**: The Cloudflare-hosted, cookie-free analytics beacon script
  loaded from `static.cloudflareinsights.com`.
- **Third_Party_Origin**: Any origin whose scheme+host+port differs from
  `https://perfectdownloadmanager.com`.
- **Chrome_Web_Store_URL**: The public listing URL for the PDM browser extension on Chrome
  Web Store, of the form `https://chromewebstore.google.com/detail/<extension-id>`.
- **Edge_Add_Ons_URL**: The public listing URL for the PDM browser extension on Microsoft
  Edge Add-ons, of the form `https://microsoftedge.microsoft.com/addons/detail/<extension-id>`.
- **Sideload_Instructions**: The step-by-step instructions on the Extension_Page for loading
  the unpacked extension from the repository when a store listing is not yet available.
- **Privacy_Policy_URL**: The canonical URL of the mirrored privacy policy on the
  Marketing_Website (`/privacy`) whose content is byte-identical to `PRIVACY.md` at the repo
  root.
- **JavaScript_Disabled_Mode**: The rendering mode of any browser that has JavaScript
  execution disabled by user setting, extension, or environment.
- **Lighthouse_Audit**: A run of Google Lighthouse against a Site_Page using the mobile
  configuration with default throttling.

## Requirements

### Requirement 1: Repository Layout and Static Bundle

**User Story:** As a maintainer, I want the website to live in a dedicated top-level
subfolder of the PDM repository with no build step, so that Cloudflare Pages can serve it
directly and I can review changes in the same pull requests as code changes.

#### Acceptance Criteria

1. THE Marketing_Website SHALL be contained entirely within the `website/` subfolder at the
   root of the PDM repository, alongside the existing `src/`, `docs/`, `browser-extension/`,
   `installer/`, `build/`, `backend/`, and `tests/` folders.
2. THE Marketing_Website SHALL consist only of files with extensions `.html`, `.css`, `.js`,
   `.svg`, `.png`, `.ico`, `.webp`, `.txt`, `.xml`, and `.webmanifest`, plus one
   `_headers` file and one `_redirects` file recognised by Cloudflare Pages.
3. THE Marketing_Website SHALL NOT require any build, bundling, transpilation, or package
   installation step to produce the deployable artefact.
4. THE Deployment_Pipeline SHALL treat the `website/` subfolder as the deployment root
   directory when publishing to Cloudflare Pages.
5. WHERE a JavaScript file is included in the Marketing_Website, THE Marketing_Website SHALL
   load the file with the attribute `defer`.

### Requirement 2: Home Page

**User Story:** As a first-time visitor, I want the Home_Page to explain what PDM is and
give me a one-click path to download it, so that I can decide within a few seconds whether
to install the app.

#### Acceptance Criteria

1. THE Home_Page SHALL be served at path `/` and return HTTP 200 for both `/` and
   `/index.html`.
2. THE Home_Page SHALL include a hero section containing the product name
   "Perfect Download Manager", a one-sentence value proposition, and a primary
   call-to-action link whose visible text begins with "Download".
3. THE primary call-to-action link on the Home_Page SHALL point at the Download_Page path
   `/download`.
4. THE Home_Page SHALL include a summary section listing at least four key features, each
   with a short label and a one-sentence description.
5. THE Home_Page SHALL include at least two screenshot images of the PDM desktop
   application, each served from `website/assets/screenshots/` with a non-empty `alt`
   attribute describing the depicted feature.
6. THE Home_Page SHALL link to Download_Page, Features_Page, Extension_Page, and
   Support_Page from a site-wide navigation element rendered inside a `<nav>` landmark.

### Requirement 3: Download Page

**User Story:** As a user ready to install PDM, I want the Download_Page to give me the
MSI, the portable zip, and matching SHA-256 checksums, so that I can install the app and
verify the file integrity before running it.

#### Acceptance Criteria

1. THE Download_Page SHALL be served at path `/download` and return HTTP 200.
2. THE Download_Page SHALL include exactly one download link whose visible text begins with
   "Download MSI" and whose `href` points at the MSI_Installer S3 URL for the current
   release.
3. THE Download_Page SHALL include exactly one download link whose visible text begins with
   "Download portable" and whose `href` points at the Portable_Zip S3 URL for the current
   release.
4. THE Download_Page SHALL display the Published_Checksum for the MSI_Installer next to the
   MSI download link, rendered as a 64-character lowercase hexadecimal string in a
   monospace element.
5. THE Download_Page SHALL display the Published_Checksum for the Portable_Zip next to the
   portable download link, rendered as a 64-character lowercase hexadecimal string in a
   monospace element.
6. FOR EACH download link on the Download_Page, THE Published_Checksum shown next to the
   link SHALL equal the SHA-256 value recorded for the same artefact in the current
   Release_Manifest.
7. THE Download_Page SHALL list the minimum system requirements as
   "Windows 10 (x64) or Windows 11 (x64)" and ".NET runtime is bundled — no separate
   install is required".
8. THE Download_Page SHALL include install instructions covering the interactive MSI flow
   and the silent-install command `msiexec /i PDM-<version>.msi /qn`.
9. THE Download_Page SHALL include a section titled "Upgrading from an earlier version"
   describing that PDM's built-in auto-updater handles subsequent releases and pointing
   users to `Check for Updates` in the app.
10. WHEN a request is made to the MSI_Installer S3 URL published on the Download_Page,
    THE responding server SHALL return HTTP 200.
11. WHEN a request is made to the Portable_Zip S3 URL published on the Download_Page,
    THE responding server SHALL return HTTP 200.

### Requirement 4: Features Page

**User Story:** As a prospective user comparing download managers, I want a detailed
Features_Page with screenshots, so that I can see what PDM does before I install it.

#### Acceptance Criteria

1. THE Features_Page SHALL be served at path `/features` and return HTTP 200.
2. THE Features_Page SHALL document at least six PDM capabilities in separate sections,
   covering multi-connection downloading, resume-after-interruption, category-based
   organisation, quiet-hours scheduling, browser integration, and system-tray operation.
3. FOR EACH capability section on the Features_Page, THE Features_Page SHALL include at
   least one screenshot image with a non-empty `alt` attribute describing the depicted
   feature.
4. THE Features_Page SHALL include a call-to-action link to the Download_Page path
   `/download` at the end of the page.

### Requirement 5: Extension Page

**User Story:** As a Chrome, Edge, or Brave user, I want the Extension_Page to give me a
one-click install path when the extension is published to a store, and clear sideload
instructions until then, so that I can enable browser integration without hunting through
docs.

#### Acceptance Criteria

1. THE Extension_Page SHALL be served at path `/extension` and return HTTP 200.
2. WHERE the Chrome_Web_Store_URL is configured for the current release, THE
   Extension_Page SHALL include a link whose visible text begins with
   "Install for Chrome" and whose `href` equals the Chrome_Web_Store_URL.
3. WHERE the Edge_Add_Ons_URL is configured for the current release, THE Extension_Page
   SHALL include a link whose visible text begins with "Install for Edge" and whose `href`
   equals the Edge_Add_Ons_URL.
4. WHERE the Chrome_Web_Store_URL is NOT configured for the current release, THE
   Extension_Page SHALL display the Sideload_Instructions covering how to enable
   Developer mode and load the unpacked extension from the PDM installation folder.
5. WHERE the Edge_Add_Ons_URL is NOT configured for the current release, THE
   Extension_Page SHALL display the Sideload_Instructions covering how to enable
   Developer mode in Edge and load the unpacked extension from the PDM installation
   folder.
6. THE Extension_Page SHALL state that PDM for Windows must be installed before the
   extension is used and link to the Download_Page path `/download`.
7. THE Extension_Page SHALL link to `docs/BROWSER-EXTENSION.md` in the PDM GitHub
   repository for advanced setup and troubleshooting.

### Requirement 6: Support Page

**User Story:** As a user who has hit a problem, I want the Support_Page to point me at
the right issue tracker, a short FAQ, and the privacy policy, so that I can find help
without emailing anyone.

#### Acceptance Criteria

1. THE Support_Page SHALL be served at path `/support` and return HTTP 200.
2. THE Support_Page SHALL include a link whose visible text is "Report an issue on GitHub"
   and whose `href` equals
   `https://github.com/vpbgkt/Perfect-Download-Manager/issues`.
3. THE Support_Page SHALL include an FAQ section with at least five question-and-answer
   pairs covering install failures, missing browser extension capture, license activation,
   auto-update failure, and uninstall.
4. THE Support_Page SHALL include a link whose visible text is "Privacy policy" and whose
   `href` equals the Privacy_Policy_URL.
5. THE Marketing_Website SHALL serve the Privacy_Policy_URL (`/privacy`) with content whose
   Markdown-rendered text is byte-identical to `PRIVACY.md` at the repo root.

### Requirement 7: Logo and Web-Ready Asset Generation

**User Story:** As a designer, I want web-ready image variants generated from the existing
PDM icon, so that the site renders a crisp logo in browser tabs, home screens, and social
share previews.

#### Acceptance Criteria

1. THE Web_Logo_Assets SHALL be generated from the Logo_Source at
   `src/PDM.App/Assets/pdm.ico` and committed under `website/assets/`.
2. THE Web_Logo_Assets SHALL include `favicon-16.png` at 16 by 16 pixels,
   `favicon-32.png` at 32 by 32 pixels, `apple-touch-icon.png` at 180 by 180 pixels,
   `logo-header.png` at 512 by 512 pixels, and `social-preview.png` at 1200 by 630 pixels.
3. EACH Site_Page SHALL declare `favicon-16.png` and `favicon-32.png` via `<link
   rel="icon">` elements in the document head.
4. EACH Site_Page SHALL declare `apple-touch-icon.png` via a `<link rel="apple-touch-icon">`
   element in the document head.
5. EACH Site_Page SHALL declare `social-preview.png` as the `og:image` value via a
   `<meta property="og:image">` element in the document head.

### Requirement 8: Progressive Enhancement without JavaScript

**User Story:** As a user with JavaScript disabled by policy or by choice, I want every
page to remain fully usable, so that I can still read information and start a download.

#### Acceptance Criteria

1. WHILE JavaScript_Disabled_Mode is active, THE Home_Page SHALL render all textual content,
   navigation links, and download call-to-action links with their normal styling and
   layout.
2. WHILE JavaScript_Disabled_Mode is active, THE Download_Page SHALL render all download
   links, Published_Checksum values, and install instructions with their normal styling and
   layout.
3. WHILE JavaScript_Disabled_Mode is active, THE Features_Page, Extension_Page, and
   Support_Page SHALL render all textual content, links, and images with their normal
   styling and layout.
4. WHILE JavaScript_Disabled_Mode is active, THE Marketing_Website SHALL allow navigation
   between every Site_Page using anchor elements without depending on any JavaScript event
   handler.

### Requirement 9: Lighthouse Performance and Accessibility Budget

**User Story:** As the site owner, I want each page to meet a strict Lighthouse budget, so
that visitors get a fast, accessible experience regardless of device.

#### Acceptance Criteria

1. FOR EACH Site_Page, A Lighthouse_Audit run against the Production_Deployment SHALL
   report a Performance score of 90 or higher.
2. FOR EACH Site_Page, A Lighthouse_Audit run against the Production_Deployment SHALL
   report an Accessibility score of 90 or higher.
3. EACH Site_Page SHALL declare a `<title>` element containing between 10 and 70
   characters.
4. EACH Site_Page SHALL declare a `<meta name="description">` element with a `content`
   attribute containing between 50 and 160 characters.
5. EACH Site_Page SHALL define exactly one `<h1>` element.
6. FOR EACH `<img>` element on any Site_Page, THE element SHALL declare a non-empty `alt`
   attribute when the image is content, and an empty `alt=""` attribute when the image is
   decorative.

### Requirement 10: Third-Party Request Discipline

**User Story:** As a privacy-conscious visitor, I want the site to make no third-party
requests other than the analytics beacon and the download URLs I click, so that browsing
the site does not leak my identity to advertisers or trackers.

#### Acceptance Criteria

1. WHEN a Site_Page is loaded on the Production_Deployment, THE Marketing_Website SHALL
   issue outbound network requests only to
   `https://perfectdownloadmanager.com` and
   `https://static.cloudflareinsights.com`.
2. THE Marketing_Website SHALL load Cloudflare_Web_Analytics only from
   `https://static.cloudflareinsights.com/beacon.min.js`.
3. THE Marketing_Website SHALL NOT include any `<script>` element whose `src` attribute
   references a Third_Party_Origin other than `https://static.cloudflareinsights.com`.
4. THE Marketing_Website SHALL NOT include any `<link rel="stylesheet">` element whose
   `href` attribute references a Third_Party_Origin.
5. THE Marketing_Website SHALL NOT include any `<iframe>` element whose `src` attribute
   references a Third_Party_Origin.
6. THE Marketing_Website SHALL NOT set any `Cookie` header on responses and SHALL NOT
   include any JavaScript that writes to `document.cookie`.
7. WHEN a user activates a download link on the Download_Page, THE Marketing_Website SHALL
   navigate the browser directly to the S3 URL for the MSI_Installer or Portable_Zip
   without any intermediate redirect or tracking hop.

### Requirement 11: HTTPS and Transport Security

**User Story:** As the site owner, I want the Production_Deployment to be HTTPS-only and
HSTS-preload eligible, so that the site cannot be downgraded to plaintext.

#### Acceptance Criteria

1. THE Production_Deployment SHALL be reachable only over HTTPS on
   `perfectdownloadmanager.com` and `www.perfectdownloadmanager.com`.
2. WHEN a request is made to `http://perfectdownloadmanager.com/<path>` for any `<path>`
   served by the Marketing_Website, THE Deployment_Pipeline SHALL respond with an HTTP
   permanent redirect (status 301 or 308) to
   `https://perfectdownloadmanager.com/<path>`.
3. WHEN a request is made to `https://www.perfectdownloadmanager.com/<path>`, THE
   Deployment_Pipeline SHALL respond with an HTTP permanent redirect to
   `https://perfectdownloadmanager.com/<path>`.
4. THE Marketing_Website SHALL send a `Strict-Transport-Security` response header with
   value `max-age=31536000; includeSubDomains; preload` on every response.
5. THE Marketing_Website SHALL send a `Content-Security-Policy` response header on every
   HTML response that restricts `script-src` to `'self'` and
   `https://static.cloudflareinsights.com`, restricts `style-src` to `'self'`, restricts
   `img-src` to `'self' data:`, and restricts `frame-ancestors` to `'none'`.
6. THE Marketing_Website SHALL send an `X-Content-Type-Options: nosniff` response header
   on every response.
7. THE Marketing_Website SHALL send a `Referrer-Policy: strict-origin-when-cross-origin`
   response header on every response.

### Requirement 12: Cloudflare Web Analytics

**User Story:** As the site owner, I want privacy-friendly, cookie-free page-view
analytics, so that I can measure traffic without tracking individuals.

#### Acceptance Criteria

1. EACH Site_Page SHALL include exactly one `<script>` element that loads
   `https://static.cloudflareinsights.com/beacon.min.js`.
2. THE Cloudflare_Web_Analytics `<script>` element SHALL be marked `defer` and SHALL carry
   a `data-cf-beacon` attribute containing the analytics site token.
3. THE Marketing_Website SHALL NOT include any other analytics, telemetry, or advertising
   script.

### Requirement 13: Deployment Pipeline

**User Story:** As a maintainer, I want every push to `main` to auto-deploy the site and
every pull request to produce a preview URL, so that changes ship without manual steps and
reviewers can see the running site before merge.

#### Acceptance Criteria

1. WHEN a commit is pushed to the `main` branch of the PDM repository, THE
   Deployment_Pipeline SHALL produce a new Production_Deployment of the `website/`
   subfolder within 10 minutes.
2. WHEN a pull request that modifies any file under `website/` is opened or updated,
   THE Deployment_Pipeline SHALL produce a Preview_Deployment addressable at a unique
   `*.pages.dev` URL and SHALL post that URL as a status check or comment on the pull
   request.
3. THE Production_Deployment SHALL be reachable at `https://perfectdownloadmanager.com`
   using the domain-apex CNAME/ALIAS configured in Cloudflare DNS.
4. IF a Production_Deployment build fails, THEN THE Deployment_Pipeline SHALL leave the
   previously successful Production_Deployment serving traffic and SHALL report the
   failure on the associated commit.

### Requirement 14: Pre-Deploy Link Verification

**User Story:** As a maintainer, I want CI to fail the build before deploy when any
internal link is broken or any external download URL does not return HTTP 200, so that a
broken `/download` page cannot reach production.

#### Acceptance Criteria

1. THE Link_Checker SHALL run as a GitHub Actions workflow on every pull request and every
   push to `main` that modifies any file under `website/`.
2. THE Link_Checker SHALL parse every HTML file under `website/` and extract every `href`
   value from `<a>` elements and every `src` value from `<img>`, `<script>`, and `<link>`
   elements.
3. FOR EACH extracted link whose value starts with `/` or is a relative path, THE
   Link_Checker SHALL verify that the corresponding file exists under `website/`.
4. FOR EACH extracted link whose value matches the MSI_Installer S3 URL or the
   Portable_Zip S3 URL, THE Link_Checker SHALL issue an HTTP HEAD request to the URL and
   SHALL treat the check as successful only when the response status is 200.
5. FOR EACH extracted link whose host equals `github.com` and whose path begins with
   `/vpbgkt/Perfect-Download-Manager`, THE Link_Checker SHALL issue an HTTP HEAD request
   and SHALL treat the check as successful only when the response status is 200 or 301.
6. IF the Link_Checker finds any internal link with no corresponding file under
   `website/`, THEN THE Link_Checker SHALL exit with a non-zero status code and SHALL
   list every unresolved link in the workflow output.
7. IF the Link_Checker finds any external download link that returns a status other than
   200, THEN THE Link_Checker SHALL exit with a non-zero status code and SHALL list every
   failing URL and its observed status in the workflow output.
8. WHEN the Link_Checker exits with a non-zero status code on a push to `main`, THE
   Deployment_Pipeline SHALL NOT publish a new Production_Deployment for that commit.

### Requirement 15: Checksum Consistency with Release Manifest

**User Story:** As a security-conscious user, I want the checksums shown on the Download_Page
to match the ones the app's auto-updater already verifies, so that the site cannot silently
publish a mismatched artefact.

#### Acceptance Criteria

1. WHEN the Marketing_Website is built for deploy, THE build step SHALL fetch the current
   Release_Manifest from S3 and emit the MSI_Installer and Portable_Zip Published_Checksum
   values into the Download_Page.
2. IF the SHA-256 of the artefact at the MSI_Installer S3 URL differs from the value
   recorded in the Release_Manifest, THEN THE Link_Checker SHALL exit with a non-zero
   status code and SHALL name the mismatched artefact in the workflow output.
3. IF the SHA-256 of the artefact at the Portable_Zip S3 URL differs from the value
   recorded in the Release_Manifest, THEN THE Link_Checker SHALL exit with a non-zero
   status code and SHALL name the mismatched artefact in the workflow output.

### Requirement 16: Out-of-Scope Paths

**User Story:** As a maintainer, I want the site to explicitly not serve pricing, docs
mirror, or blog paths in v1, so that link checkers, sitemap generators, and reviewers all
agree on the shipped surface.

#### Acceptance Criteria

1. WHEN a request is made to `/pricing`, `/pricing/`, `/blog`, `/blog/`, `/docs`, or
   `/docs/` on the Production_Deployment, THE Marketing_Website SHALL respond with HTTP
   404.
2. THE Marketing_Website SHALL NOT include any `<a>` element whose `href` value resolves
   to `/pricing`, `/blog`, or `/docs`.
3. THE Marketing_Website SHALL NOT include any server-side scripting, API endpoint, or
   Cloudflare Worker binding in v1.
