# Downloads the pinned 7-Zip console engine (7z.exe + 7z.dll, x64) and its license into
# third-party/7-zip/, ready to be bundled into the app by publish-aot-dist.ps1.
#
# PDM extracts downloaded archives (ZIP/RAR/7z/tar...) by driving this console engine as a hidden
# child process (no 7-Zip UI). Bundling means users never need to install 7-Zip separately.
#
# 7-Zip is free software: 7z.exe/7z.dll are LGPL-2.1; the RAR extraction code within is under the
# unRAR license (extraction permitted; creating a RAR compressor is not). The License.txt shipped
# alongside satisfies the "provide the license text" obligation, and 7z.dll stays a loose,
# replaceable file (LGPL requirement).
#
# Usage:
#   ./build/fetch-7zip.ps1                 # fetch pinned version
#   ./build/fetch-7zip.ps1 -Force          # re-download even if present

param(
    # Pinned 7-Zip version (matches the "latest stable" chosen for the release train).
    [string]$Version = "2409",
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $repo "third-party/7-zip"
$exe = Join-Path $dest "7z.exe"
$dll = Join-Path $dest "7z.dll"

if ((Test-Path $exe) -and (Test-Path $dll) -and -not $Force) {
    Write-Host "7-Zip already present in $dest (use -Force to re-download)." -ForegroundColor Green
    return
}

New-Item -ItemType Directory -Path $dest -Force | Out-Null

$installerUrl = "https://www.7-zip.org/a/7z$Version-x64.exe"
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) "7z$Version-x64.exe"

Write-Host "Downloading $installerUrl ..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $installerUrl -OutFile $tmp -UseBasicParsing

# Locate an existing 7z to unpack the installer (the installer is itself a 7-Zip SFX).
$existing7z = @(
    (Join-Path $env:ProgramFiles "7-Zip\7z.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "7-Zip\7z.exe")
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $existing7z) {
    throw "Need an existing 7-Zip (Program Files) to unpack the installer. Install 7-Zip once, or extract 7z.exe/7z.dll/License.txt from $tmp manually into $dest."
}

Write-Host "Extracting 7z.exe, 7z.dll, License.txt ..." -ForegroundColor Cyan
& $existing7z e $tmp "-o$dest" "7z.exe" "7z.dll" "License.txt" -y | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to unpack 7-Zip installer (exit $LASTEXITCODE)." }

Remove-Item $tmp -Force -ErrorAction SilentlyContinue

if (-not (Test-Path $exe) -or -not (Test-Path $dll)) {
    throw "Expected 7z.exe and 7z.dll in $dest after extraction."
}

$verExe = (Get-Item $exe).VersionInfo.FileVersion
Write-Host "7-Zip fetched to $dest (7z.exe $verExe)" -ForegroundColor Green
