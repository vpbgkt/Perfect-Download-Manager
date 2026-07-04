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

# Ensure the WiX tool is available. Pinned to v5: WiX v7+ requires accepting the paid
# Open Source Maintenance Fee (OSMF) EULA for commercial use; v5 has the same build syntax
# and our Package.wxs uses the v4/v5 schema.
$WixVersion = "5.0.2"
if (-not (Test-Path (Join-Path $repo ".config/dotnet-tools.json"))) {
    Push-Location $repo; dotnet new tool-manifest | Out-Null; Pop-Location
}
Push-Location $repo
dotnet tool uninstall wix 2>$null | Out-Null
dotnet tool install wix --version $WixVersion 2>$null | Out-Null
# WiX UI dialog set + util helpers (used for the standard Welcome/License/InstallDir flow).
dotnet tool run wix -- extension add "WixToolset.UI.wixext/$WixVersion" 2>$null | Out-Null
dotnet tool run wix -- extension add "WixToolset.Util.wixext/$WixVersion" 2>$null | Out-Null
Pop-Location

$installerDir = Join-Path $repo "installer"
Push-Location $repo
dotnet tool run wix -- build $wxs `
    -ext WixToolset.UI.wixext `
    -ext WixToolset.Util.wixext `
    -bindpath $installerDir `
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
