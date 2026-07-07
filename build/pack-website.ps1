# Packs the marketing site into a drag-and-drop zip for Cloudflare Pages direct upload.
#
# Cloudflare Pages "Upload assets" and Workers "Direct upload" both expect the site files
# at the ROOT of the archive - not inside a top-level folder. Compress-Archive with the
# wildcard source (Join-Path $src "*") gives us exactly that.
#
# Usage:
#   ./build/pack-website.ps1
#   ./build/pack-website.ps1 -Version 1.0.0    # override the filename suffix

param(
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repo "website"
$dist = Join-Path $repo "dist"
New-Item -ItemType Directory -Path $dist -Force | Out-Null

# Belt-and-suspenders: fail loudly if any required file is missing rather than shipping a
# half-built zip that Cloudflare would then reject.
$required = @(
    "index.html",
    "privacy.html",
    "404.html",
    "_headers",
    "robots.txt",
    "sitemap.xml",
    "assets/css/styles.css",
    "assets/js/main.js",
    "assets/img/favicon.ico",
    "assets/img/favicon-16.png",
    "assets/img/favicon-32.png",
    "assets/img/logo-48.png",
    "assets/img/logo-128.png",
    "assets/img/apple-touch-icon.png",
    "assets/img/og-image.png"
)
foreach ($rel in $required) {
    $p = Join-Path $src $rel
    if (-not (Test-Path $p)) { throw "Missing required file: website/$rel" }
}

if (-not $Version) {
    # Try to read the current PDM version from the extension manifest so the zip
    # filename tracks the shipped release.
    $manifest = Get-Content (Join-Path $repo "browser-extension/chromium/manifest.json") -Raw | ConvertFrom-Json
    $Version = $manifest.version
}

$out = Join-Path $dist "pdm-website-$Version.zip"
if (Test-Path $out) { Remove-Item $out -Force }

# Build a staging folder so we can drop files we do NOT want in the zip (README.md - dev docs,
# hidden .kiro folder, etc.) without touching the source tree.
$staging = Join-Path $dist "_website-pack"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Path $staging -Force | Out-Null

Copy-Item -Path (Join-Path $src "*") -Destination $staging -Recurse -Force

# README.md is for developers, not visitors. Cloudflare would still serve it as /README.md
# which is fine but noisy. Strip it.
Remove-Item (Join-Path $staging "README.md") -Force -ErrorAction SilentlyContinue

Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $out -CompressionLevel Optimal
Remove-Item $staging -Recurse -Force

$sizeKB = [math]::Round((Get-Item $out).Length / 1KB, 1)
Write-Host ""
Write-Host "Cloudflare drag-and-drop package:"
Write-Host "  File:   $out"
Write-Host "  Size:   $sizeKB KB"
Write-Host ""
Write-Host "Upload steps:"
Write-Host "  1. Cloudflare dashboard -> Workers & Pages -> Create -> Upload assets"
Write-Host "     (or the 'Upload your static files' option on the Create screen)"
Write-Host "  2. Project name: pdm-website (any name works; you can rename later)"
Write-Host "  3. Drop the zip file above onto the upload area."
Write-Host "  4. After deploy, bind the custom domain perfectdownloadmanager.com"
Write-Host "     under the project's Domains and Routes settings."
