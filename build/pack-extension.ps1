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
foreach ($required in @("manifest.json", "background.js", "theme.js",
                        "popup.html", "popup.css", "popup.js",
                        "options.html", "options.css", "options.js",
                        # The setup page is the whole onboarding path for users who install the
                        # extension before the desktop app. Shipping without it would leave the
                        # install-time tab and the fallback nudge pointing at a 404.
                        "welcome.html", "welcome.css", "welcome.js",
                        "icons/icon16.png", "icons/icon32.png",
                        "icons/icon48.png", "icons/icon128.png")) {
    $p = Join-Path $srcDir $required
    if (-not (Test-Path $p)) { throw "Missing required file: $required" }
}

if (Test-Path $out) { Remove-Item $out -Force }

# Files at the zip root, entry names with forward slashes. Windows PowerShell's Compress-Archive
# stores "icons\icon16.png" (backslash), which the zip format does not allow and which a store
# upload can reject or unpack with missing icons, so build the archive entry by entry instead.
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$srcRoot = (Resolve-Path $srcDir).Path.TrimEnd('\') + '\'
$zip = [System.IO.Compression.ZipFile]::Open($out, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($file in Get-ChildItem $srcDir -Recurse -File) {
        $entryName = $file.FullName.Substring($srcRoot.Length).Replace('\', '/')
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip, $file.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    }
} finally {
    $zip.Dispose()
}

$size = [math]::Round((Get-Item $out).Length / 1KB, 1)
Write-Host ""
Write-Host "Chrome Web Store submission package:"
Write-Host "  File:    $out"
Write-Host "  Size:    $size KB"
Write-Host "  Version: $($manifest.version)"
Write-Host ""
Write-Host "Upload this file at https://chrome.google.com/webstore/devconsole"
Write-Host "See docs/EXTENSION-PUBLISHING.md for the full submission checklist and listing text."
