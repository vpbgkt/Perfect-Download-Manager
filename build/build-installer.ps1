# Builds the MSI installer with WiX v5.
#
# Prerequisite: run build/publish.ps1 first to produce dist/PDM.
# Installs the WiX dotnet tool on first run.
#
# Usage:
#   ./build/publish.ps1
#   ./build/build-installer.ps1 -Version 1.0.0.0

param(
    [string]$Version = "1.0.0.0"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$publishDir = Join-Path $repo "dist/PDM"
$wxs = Join-Path $repo "installer/Package.wxs"
$msi = Join-Path $repo "dist/PDM-$Version.msi"

if (-not (Test-Path (Join-Path $publishDir "PDM.exe"))) {
    Write-Error "Run build/publish.ps1 first (dist/PDM/PDM.exe not found)."
    exit 1
}

# Ensure the WiX tool is available.
if (-not (Test-Path (Join-Path $repo ".config/dotnet-tools.json"))) {
    Push-Location $repo; dotnet new tool-manifest | Out-Null; Pop-Location
}
Push-Location $repo
dotnet tool install wix 2>$null | Out-Null
dotnet tool run wix -- extension add WixToolset.UI.wixext 2>$null | Out-Null
Pop-Location

Push-Location $repo
dotnet tool run wix -- build $wxs `
    -d "PublishDir=$publishDir" `
    -d "ProductVersion=$Version" `
    -o $msi
$code = $LASTEXITCODE
Pop-Location

if ($code -ne 0) {
    Write-Error "WiX build failed (exit $code)."
    exit $code
}

Write-Host "Installer built: $msi"
Write-Host "NOTE: unsigned. Sign with signtool before public distribution."
