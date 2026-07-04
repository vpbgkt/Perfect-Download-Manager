# Publishes PDM into a distributable folder and a zip package.
#
# The zip doubles as the auto-update package the UpdateLauncher consumes. Produces:
#   dist/PDM/              - the app + native host + update launcher
#   dist/PDM-<version>.zip - zipped package for updates/portable distribution
#
# Usage:
#   ./build/publish.ps1                      # framework-dependent (needs .NET 10 runtime)
#   ./build/publish.ps1 -SelfContained       # bundles the runtime (larger, no prerequisite)

param(
    [string]$Configuration = "Release",
    [string]$Version = "1.0.0",
    [switch]$SelfContained
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $repo "dist"
$appOut = Join-Path $dist "PDM"

if (Test-Path $appOut) { Remove-Item $appOut -Recurse -Force }
New-Item -ItemType Directory -Path $appOut -Force | Out-Null

$rid = "win-x64"
$scArgs = if ($SelfContained) { @("--self-contained", "true", "-p:PublishSingleFile=false") } else { @("--self-contained", "false") }

function Publish($project) {
    Write-Host "Publishing $project ..."
    dotnet publish $project -c $Configuration -r $rid -o $appOut `
        -p:Version=$Version --nologo @scArgs
    if ($LASTEXITCODE -ne 0) { throw "publish failed for $project" }
}

# All three executables land in the same folder so the native host and updater sit next to PDM.exe.
Publish (Join-Path $repo "src/PDM.App/PDM.App.csproj")
Publish (Join-Path $repo "src/PDM.NativeHost/PDM.NativeHost.csproj")
Publish (Join-Path $repo "src/PDM.UpdateLauncher/PDM.UpdateLauncher.csproj")

# Copy the app icon alongside the exe so the installer can reference it as ARPPRODUCTICON.
$assets = Join-Path $appOut "Assets"
New-Item -ItemType Directory -Path $assets -Force | Out-Null
Copy-Item (Join-Path $repo "src/PDM.App/Assets/pdm.ico") (Join-Path $assets "pdm.ico") -Force

$zip = Join-Path $dist "PDM-$Version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $appOut "*") -DestinationPath $zip
Write-Host ""
Write-Host "Published to: $appOut"
Write-Host "Update/portable package: $zip"
