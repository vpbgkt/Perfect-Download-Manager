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
    # PublishReadyToRun precompiles our assemblies to native code (R2R), so the .NET runtime does
    # far less JIT work during cold start. This is a meaningful chunk of the "app takes 3-4s to
    # open" gap versus IDM; it stays framework-dependent (the shared runtime is already R2R).
    dotnet publish $project -c $Configuration -r $rid -o $appOut `
        -p:Version=$Version -p:PublishReadyToRun=true --nologo @scArgs
    if ($LASTEXITCODE -ne 0) { throw "publish failed for $project" }
}

# The launcher is always published self-contained single-file, regardless of the caller's
# -SelfContained switch. That switch controls whether the main app bundles the runtime;
# the launcher NEEDS to be self-contained single-file so the orchestrator can copy just
# pdm-update.exe to %TEMP% and run it. Framework-dependent single-file still requires
# pdm-update.runtimeconfig.json alongside the exe, which defeats the temp-copy trick.
function PublishLauncher($project) {
    Write-Host "Publishing $project (self-contained single-file) ..."
    dotnet publish $project -c $Configuration -r $rid -o $appOut `
        -p:Version=$Version --nologo `
        --self-contained true `
        -p:PublishSingleFile=true `
        -p:IncludeNativeLibrariesForSelfExtract=true `
        -p:IncludeAllContentForSelfExtract=true `
        -p:EnableCompressionInSingleFile=true
    if ($LASTEXITCODE -ne 0) { throw "publish failed for $project" }
}

# All three executables land in the same folder so the native host and updater sit next to PDM.exe.
Publish (Join-Path $repo "src/PDM.App/PDM.App.csproj")
Publish (Join-Path $repo "src/PDM.NativeHost/PDM.NativeHost.csproj")
PublishLauncher (Join-Path $repo "src/PDM.UpdateLauncher/PDM.UpdateLauncher.csproj")

# The launcher's self-contained single-file publish sometimes leaves stray extracted files
# (pdm-update.dll, pdm-update.deps.json, pdm-update.runtimeconfig.json) alongside the exe
# because the earlier framework-dependent PDM.App publish wrote them into $appOut. Remove
# them - they are baked into pdm-update.exe now and having stale copies alongside can
# confuse the .NET host at runtime.
foreach ($stale in @("pdm-update.dll", "pdm-update.deps.json", "pdm-update.runtimeconfig.json", "pdm-update.pdb")) {
    $p = Join-Path $appOut $stale
    if (Test-Path $p) { Remove-Item $p -Force }
}

# Copy the app icon alongside the exe so the installer can reference it as ARPPRODUCTICON.
$assets = Join-Path $appOut "Assets"
New-Item -ItemType Directory -Path $assets -Force | Out-Null
Copy-Item (Join-Path $repo "src/PDM.App/Assets/pdm.ico") (Join-Path $assets "pdm.ico") -Force

# The browser extension is now published on the Chrome Web Store and is NO LONGER bundled
# with the installer. The in-app Browser Setup wizard simply opens the store listing
# ("Add to Chrome/Edge/Brave"); the store extension ID is pre-authorised on startup, so there
# is no developer-mode load-unpacked flow and nothing to ship on disk. This trims the payload.

$zip = Join-Path $dist "PDM-$Version.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $appOut "*") -DestinationPath $zip
Write-Host ""
Write-Host "Published to: $appOut"
Write-Host "Update/portable package: $zip"
