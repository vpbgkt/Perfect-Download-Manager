# Builds a Chrome Web Store-ready zip of the PDM browser extension.
#
# The zip must contain the extension files at the ROOT of the archive (no top-level
# directory), otherwise Chrome Web Store rejects the upload. Compress-Archive with a
# wildcard source achieves this. Output lands in dist/ next to the PDM installers.
#
# Usage:
#   ./build/pack-extension.ps1
#   ./build/pack-extension.ps1 -Version 1.0.9   # override the version stamped in the filename

param(
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$srcDir = Join-Path $repo "browser-extension/chromium"
$manifest = Get-Content (Join-Path $srcDir "manifest.json") -Raw | ConvertFrom-Json

if (-not $Version) { $Version = $manifest.version }

$distDir = Join-Path $repo "dist"
New-Item -ItemType Directory -Path $distDir -Force | Out-Null
$out = Join-Path $distDir "pdm-extension-$Version.zip"

# Sanity checks that catch the two most common Chrome Web Store rejections:
# missing icons, and manifest.json not at archive root.
foreach ($required in @("manifest.json", "background.js", "popup.html", "popup.js",
                        "icons/icon16.png", "icons/icon48.png", "icons/icon128.png")) {
    $p = Join-Path $srcDir $required
    if (-not (Test-Path $p)) { throw "Missing required file: $required" }
}

if (Test-Path $out) { Remove-Item $out -Force }

# -Path with a trailing wildcard places file contents at the zip root, exactly what CWS wants.
Compress-Archive -Path (Join-Path $srcDir "*") -DestinationPath $out -CompressionLevel Optimal

$size = [math]::Round((Get-Item $out).Length / 1KB, 1)
Write-Host ""
Write-Host "Chrome Web Store submission package:"
Write-Host "  File:    $out"
Write-Host "  Size:    $size KB"
Write-Host "  Version: $($manifest.version)"
Write-Host ""
Write-Host "Upload this file at https://chrome.google.com/webstore/devconsole"
Write-Host "See docs/EXTENSION-PUBLISHING.md for the full submission checklist and listing text."
