# Builds the WiX Burn bootstrapper (setup .exe) that auto-installs the .NET 10 Desktop Runtime if
# missing, then installs the framework-dependent PDM MSI.
#
# Prerequisites: run build/publish.ps1 (framework-dependent, NO -SelfContained) then
# build/build-installer.ps1 first, so dist/PDM-<Version>.msi exists.
#
# Usage:
#   ./build/publish.ps1 -Version 1.0.23
#   ./build/build-installer.ps1 -Version 1.0.23.0
#   ./build/build-bundle.ps1 -Version 1.0.23.0
#
# Output: dist/PDM-<Version>-Setup.exe  (~40 MB; the runtime is downloaded on demand, not embedded)

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

$redistDir = Join-Path $installer "redist"
$runtimeExe = Join-Path $redistDir "windowsdesktop-runtime-win-x64.exe"
$payloadWxs = Join-Path $installer "runtime-payload.generated.wxs"
$channelUrl = "https://aka.ms/dotnet/10.0/windowsdesktop-runtime-win-x64.exe"

if (-not (Test-Path $msi)) {
    Write-Error "MSI not found: $msi. Run build/publish.ps1 (framework-dependent) then build/build-installer.ps1 first."
    exit 1
}

New-Item -ItemType Directory -Path $redistDir -Force | Out-Null

# Resolve the aka.ms channel URL to its immutable, versioned target so the pinned hash always matches
# exactly what Burn downloads at install time (the aka.ms URL drifts to newer patches, which would
# fail Burn's hash verification). Rebuild the bundle to pick up a newer runtime.
Write-Host "Resolving .NET 10 Desktop Runtime URL ..."
$resolvedUrl = $null
try {
    $resp = Invoke-WebRequest -Uri $channelUrl -Method Head -MaximumRedirection 5 -UseBasicParsing
    $base = $resp.BaseResponse
    # Windows PowerShell (5.1) exposes the final URL as ResponseUri; newer PS uses RequestMessage.
    if ($base.PSObject.Properties.Name -contains 'ResponseUri' -and $base.ResponseUri) {
        $resolvedUrl = $base.ResponseUri.AbsoluteUri
    } elseif ($base.RequestMessage -and $base.RequestMessage.RequestUri) {
        $resolvedUrl = $base.RequestMessage.RequestUri.AbsoluteUri
    }
} catch {
    $resolvedUrl = $null
}
if ([string]::IsNullOrWhiteSpace($resolvedUrl) -or $resolvedUrl -like "*aka.ms*") {
    Write-Warning "Could not resolve aka.ms to an immutable URL; using the channel URL. The bundle's pinned"
    Write-Warning "hash will only match until Microsoft ships a newer .NET 10 patch - rebuild the bundle then."
    $resolvedUrl = $channelUrl
}
Write-Host "  $resolvedUrl"

if (-not (Test-Path $runtimeExe)) {
    Write-Host "Downloading runtime ..."
    Invoke-WebRequest -Uri $resolvedUrl -OutFile $runtimeExe -UseBasicParsing
}

Push-Location $repo
try {
    # WiX v5 renamed the Bal extension package to WixToolset.BootstrapperApplications.wixext
    # (the bal: namespace is unchanged).
    dotnet tool run wix -- extension add "WixToolset.BootstrapperApplications.wixext/$WixVersion" 2>$null | Out-Null
    dotnet tool run wix -- extension add "WixToolset.Util.wixext/$WixVersion" 2>$null | Out-Null

    # Generate the remote payload (hash + size), pinned to the resolved immutable URL.
    dotnet tool run wix -- burn remotepayload $runtimeExe -du $resolvedUrl -packagetype exe -o $payloadWxs
    if ($LASTEXITCODE -ne 0) { throw "remotepayload generation failed" }

    [xml]$payload = Get-Content $payloadWxs
    $pp = $payload.ExePackage.ExePackagePayload
    $runtimeHash = $pp.Hash
    $runtimeSize = $pp.Size
    $runtimeName = $pp.Name

    if ([string]::IsNullOrWhiteSpace($runtimeHash) -or [string]::IsNullOrWhiteSpace($runtimeSize)) {
        throw "Could not read runtime Hash/Size from $payloadWxs"
    }

    dotnet tool run wix -- build $bundleWxs `
        -ext WixToolset.BootstrapperApplications.wixext `
        -ext WixToolset.Util.wixext `
        -bindpath $installer `
        -bindpath $publishAssets `
        -d "ProductVersion=$Version" `
        -d "MsiPath=$msi" `
        -d "RuntimeName=$runtimeName" `
        -d "RuntimeUrl=$resolvedUrl" `
        -d "RuntimeHash=$runtimeHash" `
        -d "RuntimeSize=$runtimeSize" `
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
Write-Host "It downloads the .NET 10 Desktop Runtime on demand if missing, then installs PDM."
Write-Host "NOTE: unsigned, and the runtime auto-install must be verified on a clean (no-.NET) machine."
