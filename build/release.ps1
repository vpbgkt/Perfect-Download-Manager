#requires -Version 5.1
<#
.SYNOPSIS
    Single-command PDM release: patch website versions, build, publish to S3, commit & push.

.DESCRIPTION
    One script that runs the full "manual" release documented in docs/DEPLOYMENT.md. Prompts for
    the version tag (and release notes) if not supplied, updates every version marker on the
    marketing site, builds the app / MSI / bootstrapper Setup.exe, signs and uploads the
    auto-update package, uploads the installers, publishes downloads.json, verifies every S3
    URL is live, then commits + tags + pushes to GitHub.

    Idempotent — safe to re-run for the same version if a previous run failed part-way (the S3
    uploads overwrite the same keys; website patches are no-ops when the version already
    matches). The git tag step is the only non-idempotent gate: it fails if the tag exists,
    which is deliberate.

    Nothing is committed or pushed before all builds and uploads succeed, so a failure in the
    middle leaves the repo unchanged (only dist/ artefacts remain, which is gitignored).

.PARAMETER Version
    App version in X.Y.Z form (e.g. "1.2.2"). Required.

.PARAMETER ReleaseNotes
    Human-readable release notes. Prompted if omitted (multi-line; blank line to finish).
    Goes into the signed update manifest and the website changelog.

.PARAMETER Channel
    Update channel: "Stable" (default) or "Beta". Beta releases publish under stable/beta/ and
    the website is NOT touched (only stable releases update index.html + changelog).

.PARAMETER SkipBuild        Reuse artefacts already in dist/ (for retrying an upload/commit).
.PARAMETER SkipUpload       Skip the S3 publish (dry deploy of website + commit).
.PARAMETER SkipWebsite      Do not modify website/index.html or website/changelog.html.
.PARAMETER SkipCommit       Do not run git commit / tag / push. Website + S3 are still updated.
.PARAMETER YesToAll         Do not prompt for confirmation before the destructive steps.

.EXAMPLE
    ./build/release.ps1                          # prompts for version + release notes
    ./build/release.ps1 -Version 1.2.2
    ./build/release.ps1 -Version 1.2.2 -ReleaseNotes "Selection-driven toolbar; seat release."
    ./build/release.ps1 -Version 1.3.0-rc.1 -Channel Beta
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$ReleaseNotes,
    [ValidateSet("Stable", "Beta")][string]$Channel = "Stable",
    [switch]$SkipBuild,
    [switch]$SkipUpload,
    [switch]$SkipWebsite,
    [switch]$SkipCommit,
    [switch]$YesToAll
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

# --- Fixed infra facts (from docs/DEPLOYMENT.md §3) -----------------------------------------
$Region       = "ap-south-1"
$ExpectedAcct = "452359090613"
$BucketName   = "pdm-updates"
$BaseUrl      = "https://pdm-updates-$ExpectedAcct-aps1.s3.$Region.amazonaws.com"

# --- Helpers --------------------------------------------------------------------------------
function Say([string]$msg, [string]$c = "Cyan") { Write-Host $msg -ForegroundColor $c }
function Ok ([string]$msg) { Write-Host "  [ok] $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "  [!!] $msg" -ForegroundColor Yellow }
function Die ([string]$msg) { Write-Host "  [XX] $msg" -ForegroundColor Red; exit 1 }
function Check-Exit([string]$what) { if ($LASTEXITCODE -ne 0) { Die "$what failed (exit $LASTEXITCODE)" } }

function Confirm-Or-Abort([string]$prompt) {
    if ($YesToAll) { return }
    $ans = Read-Host "$prompt [y/N]"
    if ($ans -notmatch '^(y|yes)$') { Die "Aborted by user." }
}

# ============================================================================================
# 1. INPUTS
# ============================================================================================
Say "==> PDM release" "Magenta"

if (-not $Version) { $Version = Read-Host "Version tag (X.Y.Z, e.g. 1.2.2)" }
$Version = $Version.Trim().TrimStart("v")
if ($Version -notmatch '^\d+\.\d+\.\d+(-[A-Za-z0-9\.]+)?$') {
    Die "Version '$Version' must be X.Y.Z (optionally with -pre.N)."
}
$MsiVersion = "$Version.0"                                   # 4-part for WiX
$Tag        = "v$Version"

if (-not $ReleaseNotes -and -not $SkipUpload) {
    Say "Release notes (one per line, blank line to finish; goes into the signed manifest and the site changelog):"
    $lines = @()
    while ($true) {
        $l = Read-Host "  "
        if ([string]::IsNullOrWhiteSpace($l)) { break }
        $lines += $l
    }
    $ReleaseNotes = ($lines -join "`n").Trim()
}
if (-not $ReleaseNotes) { $ReleaseNotes = "Bug fixes and improvements." }

Say ""
Say "Version:       $Version   (MSI $MsiVersion, tag $Tag)"
Say "Channel:       $Channel"
Say "Release notes: $(($ReleaseNotes -split "`n")[0])$(if (($ReleaseNotes -split "`n").Count -gt 1) { ' ...' })"
Confirm-Or-Abort "Proceed?"

# ============================================================================================
# 2. PREFLIGHT
# ============================================================================================
Say ""
Say "==> Preflight" "Magenta"

foreach ($tool in @("dotnet", "node", "aws", "git")) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Die "$tool is not on PATH." }
    Ok "$tool present"
}

# AWS account/region check (avoids publishing to the wrong account by accident).
$acct = (aws sts get-caller-identity --query Account --output text 2>&1).Trim()
if ($acct -ne $ExpectedAcct) { Die "AWS account is $acct, expected $ExpectedAcct." }
Ok "AWS account $acct / region $Region"

# Git — make sure the tag doesn't already exist locally OR on origin (won't overwrite history).
if (-not $SkipCommit) {
    git rev-parse -q --verify "refs/tags/$Tag" *> $null
    if ($LASTEXITCODE -eq 0) { Die "Tag $Tag already exists locally. Delete it or pick a new version." }
    $remoteTag = git ls-remote --tags origin "refs/tags/$Tag" 2>$null
    if ($remoteTag) { Die "Tag $Tag already exists on origin. Pick a new version." }
    Ok "Tag $Tag is free (local + origin)"
}

$Bucket = "$BucketName-$ExpectedAcct-aps1"
$StableDl = "$BaseUrl/downloads"
$ChannelPrefix = $Channel.ToLower()

# ============================================================================================
# 3. WEBSITE VERSION PATCHING
# ============================================================================================
# Do this BEFORE the build so a broken patch fails fast (nothing has been pushed anywhere yet).
if (-not $SkipWebsite -and $Channel -eq "Stable") {
    Say ""
    Say "==> Patch website ($Version)" "Magenta"

    $index = Join-Path $repo "website/index.html"
    if (-not (Test-Path $index)) { Die "website/index.html not found." }
    # Read as UTF-8 explicitly. Windows PowerShell 5.1's Get-Content -Raw defaults to the ANSI
    # codepage (Windows-1252) for BOM-less files. Since our website files are BOM-less UTF-8,
    # Get-Content would mis-decode every multi-byte character (bytes get treated as CP1252 code
    # points), and the WriteAllText below would then re-encode them as UTF-8 -> classic double-
    # encoding mojibake ("Ãƒâ€šÃ‚Â·" for "·", etc). Always read with an explicit UTF-8 encoding.
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    $html = [System.IO.File]::ReadAllText($index, $utf8NoBom)

    # Byte-for-byte version markers documented in DEPLOYMENT.md §5.6. The patterns are anchored on
    # stable attribute markers so they cannot accidentally match unrelated text.
    $newTitle = 'Perfect Download Manager ' + $Version + ' — Free Download Manager (PDM) for Windows'
    $html = [regex]::Replace($html, '<title>[^<]*</title>', "<title>$newTitle</title>")
    $html = [regex]::Replace($html, '("softwareVersion":\s*")[^"]+(")', "`${1}$Version`${2}")
    $html = [regex]::Replace($html,
        '("downloadUrl":\s*")https://pdm-updates-[^"]+/downloads/PDM-[^"]+\.msi(")',
        "`${1}$StableDl/PDM-$Version.msi`${2}")
    $html = [regex]::Replace($html, '(<span[^>]*\bdata-version[^>]*>)[^<]+(</span>)', "`${1}$Version`${2}")
    $html = [regex]::Replace($html,
        '(id="dlMsi"[^>]*\bhref=")https://pdm-updates-[^"]+/downloads/PDM-[^"]+\.msi(")',
        "`${1}$StableDl/PDM-$Version.msi`${2}")
    $html = [regex]::Replace($html,
        '(id="dlZip"[^>]*\bhref=")https://pdm-updates-[^"]+/stable/pdm-[^"]+\.zip(")',
        "`${1}$BaseUrl/stable/pdm-$Version.zip`${2}")

    # UTF-8 without BOM, LF endings preserved.
    [System.IO.File]::WriteAllText($index, $html, $utf8NoBom)
    Ok "index.html patched"

    # Changelog: prepend a new section (only if this version is not already recorded). Built as
    # plain string joins (no here-strings) so the script stays syntactically robust across
    # PowerShell versions and terminal encodings.
    $changelog = Join-Path $repo "website/changelog.html"
    if (Test-Path $changelog) {
        # Same UTF-8-explicit read as index.html above; do NOT use Get-Content on BOM-less HTML.
        $cl = [System.IO.File]::ReadAllText($changelog, $utf8NoBom)
        $escVersion = [regex]::Escape($Version)
        if ($cl -match ('<h2>\s*' + $escVersion + '\s*</h2>')) {
            Warn ("changelog.html already has an entry for " + $Version + " - leaving it alone.")
        } else {
            $today = (Get-Date -Format "yyyy-MM-dd")

            function _htmlEncode([string]$s) {
                return $s.Replace('&','&amp;').Replace('<','&lt;').Replace('>','&gt;').Replace('"','&quot;')
            }
            $noteLines = @()
            foreach ($ln in ($ReleaseNotes -split "(?:\r\n|\r|\n)")) {
                $trimmed = $ln.Trim()
                if ($trimmed) { $noteLines += ('                <li>' + (_htmlEncode $trimmed) + '</li>') }
            }
            if (-not $noteLines) { $noteLines = @('                <li>Bug fixes and improvements.</li>') }
            $notesHtml = ($noteLines -join [Environment]::NewLine)

            $nl = [Environment]::NewLine
            $section = ''
            $section += '        <section>' + $nl
            $section += '            <h2>' + $Version + '</h2>' + $nl
            $section += '            <p class="release-date">' + $today + '</p>' + $nl
            $section += '            <p><em>Latest stable</em></p>' + $nl
            $section += '            <ul>' + $nl
            $section += $notesHtml + $nl
            $section += '            </ul>' + $nl
            $section += '        </section>' + $nl + $nl

            # Drop the "Latest stable" marker from the previous top section so we don't have two.
            $cl = [regex]::Replace($cl, '<p><em>Latest stable</em></p>\s*', '', 1)
            $inserted = [regex]::Replace($cl, '(<section>)', ($section + '$1'), 1)
            if ($inserted -eq $cl) {
                Warn "Could not find an insertion point in changelog.html; skipped."
            } else {
                [System.IO.File]::WriteAllText($changelog, $inserted, [System.Text.UTF8Encoding]::new($false))
                Ok ("changelog.html: added section for " + $Version)
            }
        }
    }
} elseif ($Channel -eq "Beta") {
    Say ""
    Warn "Beta channel — skipping website patch (only Stable updates the site)."
}

# ============================================================================================
# 4. BUILD
# ============================================================================================
$dist = Join-Path $repo "dist"
$zipPath   = Join-Path $dist "PDM-$Version.zip"
$msiPath   = Join-Path $dist "PDM-$MsiVersion.msi"
$setupPath = Join-Path $dist "PDM-$MsiVersion-Setup.exe"

if (-not $SkipBuild) {
    Say ""
    Say "==> Build (NativeAOT publish -> zip -> installer -> bootstrapper)" "Magenta"

    # NativeAOT, runtime-free dist assembler for the Avalonia head. This is the ONLY publish
    # path we ship. The old framework-dependent publish.ps1 (WPF head) has been deleted so we
    # cannot accidentally cut a release from the wrong tree again.
    & (Join-Path $PSScriptRoot "publish-aot-dist.ps1") -Version $Version
    Check-Exit "publish-aot-dist.ps1"
    $distPdm = Join-Path $dist "PDM"
    if (-not (Test-Path (Join-Path $distPdm "PDM.exe"))) {
        Die "publish-aot-dist.ps1 did not produce dist/PDM/PDM.exe."
    }
    Ok "publish-aot-dist.ps1 -> $distPdm"

    # Assemble the update/portable zip from the runtime-free dist. Files sit at the archive
    # root so the launcher can unpack straight over the install directory.
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Compress-Archive -Path (Join-Path $distPdm "*") -DestinationPath $zipPath -CompressionLevel Optimal
    if (-not (Test-Path $zipPath)) { Die "Failed to create $zipPath." }
    Ok "zipped -> $zipPath"

    & (Join-Path $PSScriptRoot "build-installer.ps1") -Version $MsiVersion
    Check-Exit "build-installer.ps1"
    if (-not (Test-Path $msiPath)) { Die "Expected $msiPath was not produced." }
    Ok "build-installer.ps1 -> $msiPath"

    & (Join-Path $PSScriptRoot "build-bundle.ps1") -Version $MsiVersion
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $setupPath)) {
        Warn "build-bundle.ps1 did not produce $setupPath. Continuing without the Setup.exe wrapper."
        $setupPath = $null
    } else {
        Ok "build-bundle.ps1 -> $setupPath"
    }
} else {
    Say ""
    Warn "SkipBuild set — reusing dist/ artefacts."
    if (-not (Test-Path $zipPath)) { Die "$zipPath missing; cannot skip build." }
    if (-not (Test-Path $msiPath)) { Die "$msiPath missing; cannot skip build." }
    if (-not (Test-Path $setupPath)) { Warn "$setupPath missing; skipping Setup.exe upload."; $setupPath = $null }
}

# ============================================================================================
# 5. PUBLISH TO S3
# ============================================================================================
if (-not $SkipUpload) {
    Say ""
    Say "==> Publish to S3 ($Bucket)" "Magenta"

    # 5a. Sign + upload the update zip and manifest. This step also makes the update visible to
    #     already-installed clients on the chosen channel.
    & (Join-Path $repo "backend/updates/sign-release.ps1") `
        -Version $Version -Channel $Channel -ReleaseNotes $ReleaseNotes -Region $Region
    Check-Exit "sign-release.ps1"
    Ok "Signed manifest + zip uploaded to $ChannelPrefix/"

    # 5b. Website installer downloads. Idempotent overwrite.
    aws s3 cp $msiPath "s3://$Bucket/downloads/PDM-$Version.msi" `
        --content-type "application/x-msi" --region $Region | Out-Null
    Check-Exit "aws s3 cp msi"
    Ok "MSI uploaded → $StableDl/PDM-$Version.msi"

    if ($setupPath) {
        aws s3 cp $setupPath "s3://$Bucket/downloads/PDM-$Version-Setup.exe" `
            --content-type "application/octet-stream" --region $Region | Out-Null
        Check-Exit "aws s3 cp setup"
        Ok "Setup.exe uploaded → $StableDl/PDM-$Version-Setup.exe"
    }

    # 5c. downloads.json — the version/size/href source of truth the site reads at runtime.
    if ($Channel -eq "Stable") {
        $msiBytes = (Get-Item $msiPath).Length
        $zipBytes = (Get-Item $zipPath).Length
        $downloads = [ordered]@{
            version           = $Version
            msiUrl            = "$StableDl/PDM-$Version.msi"
            msiSizeBytes      = $msiBytes
            portableZipUrl    = "$BaseUrl/stable/pdm-$Version.zip"
            portableSizeBytes = $zipBytes
        }
        $downloadsPath = Join-Path $dist "downloads.json"
        $downloads | ConvertTo-Json | Set-Content $downloadsPath -NoNewline -Encoding utf8
        aws s3 cp $downloadsPath "s3://$Bucket/stable/downloads.json" `
            --content-type "application/json" --cache-control "public, max-age=300" --region $Region | Out-Null
        Check-Exit "aws s3 cp downloads.json"
        Remove-Item $downloadsPath -Force
        Ok "downloads.json published"
    }

    # 5d. Verify every URL is live (HEAD requests, no body).
    Say ""
    Say "==> Verify S3 URLs" "Magenta"
    $urls = @(
        "$BaseUrl/$ChannelPrefix/manifest.json",
        "$BaseUrl/$ChannelPrefix/pdm-$Version.zip",
        "$StableDl/PDM-$Version.msi"
    )
    if ($setupPath) { $urls += "$StableDl/PDM-$Version-Setup.exe" }
    if ($Channel -eq "Stable") { $urls += "$BaseUrl/stable/downloads.json" }

    foreach ($u in $urls) {
        try {
            $r = Invoke-WebRequest $u -Method Head -UseBasicParsing -TimeoutSec 30
            if ($r.StatusCode -eq 200) { Ok "200  $u" } else { Warn "$($r.StatusCode)  $u" }
        } catch {
            Warn "FAIL $u  ($($_.Exception.Message))"
        }
    }
}

# ============================================================================================
# 6. GIT COMMIT + TAG + PUSH
# ============================================================================================
if (-not $SkipCommit) {
    Say ""
    Say "==> Git commit / tag / push" "Magenta"

    # Only source + installer + build scripts + CI + the patched marketing pages. Never
    # `git add .` (would sweep in dist/, secrets, junk). `.github/` is included so a workflow tweak
    # travels with the release commit - historically it was omitted, and a CI-yaml fix that pointed
    # at a deleted script was silently left out of a release. `docs/` is deliberately NOT included:
    # documentation edits are committed on their own cadence, and blanket-staging docs/ would sweep
    # in untracked personal notes.
    $paths = @("src/", "installer/", "build/", "backend/", ".github/")
    if ($Channel -eq "Stable" -and -not $SkipWebsite) {
        $paths += "website/index.html"
        if (Test-Path (Join-Path $repo "website/changelog.html")) { $paths += "website/changelog.html" }
    }
    git add -- @paths
    Check-Exit "git add"

    # Refuse to commit if any suspicious file slipped through (belt-and-suspenders).
    $risky = git diff --cached --name-only | Select-String -Pattern '\.pfx$|\.p12$|\.pem$|\.key$|\.env|firebase-service-account'
    if ($risky) {
        Warn "The staged changes include something that looks like a secret:"
        $risky | ForEach-Object { Write-Host "    $_" -ForegroundColor Yellow }
        Die "Aborted before commit. Un-stage the file(s) above and try again."
    }

    $staged = git diff --cached --name-only
    if (-not $staged) {
        Warn "Nothing to commit. Tagging the current HEAD as $Tag."
    } else {
        $summary = ($ReleaseNotes -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
        if (-not $summary) { $summary = "bug fixes and improvements" }
        $msg = "release: PDM $Version - $summary"
        git commit -m $msg
        Check-Exit "git commit"
        Ok "committed: $msg"
    }

    git tag $Tag
    Check-Exit "git tag"
    Ok "tagged $Tag"

    git push
    Check-Exit "git push"
    git push --tags
    Check-Exit "git push --tags"
    Ok "pushed to origin (branch + tags)"
}

Say ""
Say "==> Done: PDM $Version published on $Channel channel." "Green"
Say "    Cloudflare will redeploy the site on the push it just received." "DarkGray"
