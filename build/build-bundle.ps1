# Builds the WiX Burn bootstrapper (single Setup.exe) that installs the PDM MSI.
#
# Since the Avalonia head is published with NativeAOT (self-contained, runtime-free), the bundle no
# longer downloads or installs the .NET Desktop Runtime - it simply wraps the self-sufficient MSI in
# a familiar single Setup.exe. The MSI alone is also a valid deliverable.
#
# Prerequisites: run build/publish-aot-dist.ps1 then build/build-installer.ps1 first, so
# dist/PDM-<Version>.msi exists.
#
# Usage:
#   ./build/publish-aot-dist.ps1 -Version 1.0.23
#   ./build/build-installer.ps1 -Version 1.0.23.0
#   ./build/build-bundle.ps1 -Version 1.0.23.0
#
# Output: dist/PDM-<Version>-Setup.exe

param(
    [string]$Version = "1.0.0.0"
)

$ErrorActionPreference = "Stop"
$WixVersion = "5.0.2"
$repo = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $repo "installer"
$publishAssets = Join-Path $repo "dist\PDM\Assets"
$msi = Join-Path $repo "dist\PDM-$Version.msi"
$bundleWxs = Join-Path $installer "Bundle.wxs"
$out = Join-Path $repo "dist\PDM-$Version-Setup.exe"

if (-not (Test-Path $msi)) {
    Write-Error "MSI not found: $msi. Run build/publish-aot-dist.ps1 then build/build-installer.ps1 first."
    exit 1
}

Push-Location $repo
try {
    # WiX v5 renamed the Bal extension package to WixToolset.BootstrapperApplications.wixext
    # (the bal: namespace is unchanged).
    dotnet tool run wix -- extension add "WixToolset.BootstrapperApplications.wixext/$WixVersion" 2>$null | Out-Null

    dotnet tool run wix -- build $bundleWxs `
        -ext WixToolset.BootstrapperApplications.wixext `
        -bindpath $installer `
        -bindpath $publishAssets `
        -d "ProductVersion=$Version" `
        -d "MsiPath=$msi" `
        -o $out
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}

if ($code -ne 0) {
    Write-Error "Bundle build failed (exit $code)."
    exit $code
}

Write-Host ""
Write-Host "Bootstrapper built: $out"
Write-Host "Self-contained: no .NET runtime prerequisite. NOTE: unsigned - sign with signtool for release."
