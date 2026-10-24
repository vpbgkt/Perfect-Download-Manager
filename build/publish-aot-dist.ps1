# Assembles the runtime-free distribution folder for the NativeAOT Windows build. Publishes the
# Avalonia head + native host + update launcher without a .NET runtime dependency, so the
# installer needs no runtime bundling/downloading. This is the ONLY publish path we ship - a real
# release should always go through build/release.ps1, which calls this script and adds the zip,
# MSI, Setup.exe, S3 upload, git commit + tag + push.
#
# Produces dist/PDM/ containing:
#   PDM.exe                 - Avalonia desktop head, NativeAOT self-contained
#   pdm-native-host.exe     - browser native-messaging host, NativeAOT self-contained
#   pdm-update.exe          - update launcher, NativeAOT (trimmed single-file without the C++ tools)
#   <native deps>           - e_sqlite3.dll, Skia/HarfBuzz, ANGLE, etc. (from the AOT publish)
#   Assets/pdm.ico          - loose icon for the installer + shortcuts (Avalonia embeds it, so it
#                             is copied here explicitly for WiX)
#
# Usage:
#   ./build/publish-aot-dist.ps1 -Version 1.2.3

param(
    [string]$Configuration = "Release",
    [string]$Rid = "win-x64",
    [string]$Version = "1.0.0",

    # Authenticode code signing (C3 real anti-tamper anchor). When -CertThumbprint is supplied, the
    # three shipped executables are signed with signtool after publish. Signing is what makes the
    # runtime self-integrity check (TamperGuard.VerifySelfIntegrity) meaningful: any post-sign patch
    # — including swapping the embedded licensing key — invalidates the signature. Leave blank for
    # unsigned dev builds (the self-integrity check then reports "Unsigned" and does not punish).
    [string]$CertThumbprint = "",
    [string]$TimestampUrl = "http://timestamp.digicert.com",

    # Build the trimmed self-contained fallback even when the C++ linker is available.
    [switch]$NoAot
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $repo "dist"
$appOut = Join-Path $dist "PDM"

# NativeAOT links with the MSVC linker (Visual Studio or Build Tools, "Desktop development with C++"
# workload). Without it the publish fails, and an untrimmed self-contained build (~106 MB installer)
# is not an acceptable substitute. Fall back to an IL-trimmed self-contained build instead: same
# runtime-free layout, no VC++ redistributable needed (only the UCRT, part of Windows 10+).
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"
$hasLinker = (Test-Path $vswhere) -and
    [bool](& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
$useAot = $hasLinker -and -not $NoAot
if ($useAot) {
    # The ILCompiler's linker lookup calls vswhere.exe by bare name; a fresh Build Tools install does not
    # put it on PATH, and the "not recognized" message then ends up in the linker command line.
    $env:PATH = "$(Split-Path $vswhere -Parent);$env:PATH"
} else {
    Write-Host "MSVC linker not found (or -NoAot): building trimmed self-contained instead of NativeAOT." -ForegroundColor Yellow
}
$trimmed = @("--self-contained", "true", "-p:PublishAot=false", "-p:PublishTrimmed=true",
             "-p:InvariantGlobalization=true", "-p:DebugType=none")
$singleFile = @("-p:PublishSingleFile=true", "-p:IncludeNativeLibrariesForSelfExtract=true",
                "-p:EnableCompressionInSingleFile=true")

if (Test-Path $appOut) { Remove-Item $appOut -Recurse -Force }
New-Item -ItemType Directory -Path $appOut -Force | Out-Null

function Publish-AndLocate([string]$project, [string]$tfm, [string[]]$extraArgs) {
    Write-Host "Publishing $project ..." -ForegroundColor Cyan
    # Route publish output to the host (not the pipeline) so only the resolved path is returned.
    dotnet publish $project -c $Configuration -r $Rid -p:Version=$Version --nologo @extraArgs 2>&1 |
        ForEach-Object { Write-Host $_ }
    if ($LASTEXITCODE -ne 0) { throw "publish failed for $project" }
    return Join-Path (Split-Path $project -Parent) "bin/$Configuration/$tfm/$Rid/publish"
}

# The Avalonia head targets a versioned Windows TFM; the console helpers target plain net10.0-windows.
$appTfm = "net10.0-windows10.0.19041.0"
$helperTfm = "net10.0-windows"

# 1) Avalonia desktop head - NativeAOT, self-contained, runtime-free (the base of the dist).
$appArgs = if ($useAot) {
    @("-p:PublishAot=true", "-p:InvariantGlobalization=true", "-p:StripSymbols=true", "-p:PublishReadyToRun=false")
} else {
    $trimmed + @("-p:PublishReadyToRun=false", "-p:PublishDocumentationFiles=false")
}
$appPublish = Publish-AndLocate (Join-Path $repo "src/PDM.App.Avalonia/PDM.App.Avalonia.csproj") $appTfm $appArgs
Copy-Item (Join-Path $appPublish "*") $appOut -Recurse -Force

# 2) Browser native-messaging host - NativeAOT self-contained (trimmed single-file in the fallback).
$hostArgs = if ($useAot) { @("-p:PublishAot=true", "-p:InvariantGlobalization=true", "-p:StripSymbols=true") } else { $trimmed + $singleFile }
$hostPublish = Publish-AndLocate (Join-Path $repo "src/PDM.NativeHost/PDM.NativeHost.csproj") $helperTfm $hostArgs
Copy-Item (Join-Path $hostPublish "pdm-native-host.exe") $appOut -Force

# 3) Update launcher - self-contained single-file (the orchestrator copies just this exe to %TEMP%,
#    so it must stand alone). A NativeAOT exe is a single standalone file too (~2 MB, no trim/AOT warnings).
#    The fallback is a trimmed single-file (~11 MB); untrimmed, as up to 1.3.2, it carried the whole runtime (~36 MB).
$launcherArgs = if ($useAot) {
    @("-p:PublishAot=true", "-p:PublishSingleFile=false", "-p:InvariantGlobalization=true", "-p:StripSymbols=true")
} else { $trimmed + $singleFile }
$launcherPublish = Publish-AndLocate (Join-Path $repo "src/PDM.UpdateLauncher/PDM.UpdateLauncher.csproj") $helperTfm `
    $launcherArgs
Copy-Item (Join-Path $launcherPublish "pdm-update.exe") $appOut -Force

# Debugger/diagnostics-only runtime files and unused alternate GCs: never loaded by the shipped app
# (they serve attached debuggers, crash-dump creation and DOTNET_GCName). Not present in an AOT publish.
foreach ($diag in @("createdump.exe", "mscordbi.dll", "mscordaccore.dll", "mscordaccore_*.dll",
                    "Microsoft.DiaSymReader.Native.*.dll", "clrgc.dll", "clrgcexp.dll", "*.xml")) {
    Get-ChildItem $appOut -Filter $diag -File | Remove-Item -Force
}

# Remove any stray launcher side-files the earlier copies may have introduced (baked into the exe).
foreach ($stale in @("pdm-update.dll", "pdm-update.deps.json", "pdm-update.runtimeconfig.json", "pdm-update.pdb")) {
    $p = Join-Path $appOut $stale
    if (Test-Path $p) { Remove-Item $p -Force }
}

# 4) Loose app icon for the installer icon + Start Menu/Desktop shortcuts. Avalonia embeds pdm.ico as
#    an avares resource, so it is not emitted as a loose file by the publish; copy it explicitly.
$assets = Join-Path $appOut "Assets"
New-Item -ItemType Directory -Path $assets -Force | Out-Null
Copy-Item (Join-Path $repo "src/PDM.App.Avalonia/Assets/pdm.ico") (Join-Path $assets "pdm.ico") -Force

# 4b) Bundle the 7-Zip console engine (7z.exe + 7z.dll) used for headless archive extraction
#     (the "Extract and open" feature). Fetched on demand into third-party/7-zip if absent, then
#     shipped under tools/7-zip so the installer's recursive harvest picks it up. The app resolves
#     this bundled copy first (SevenZipArchiveExtractor), falling back to a system 7-Zip in dev.
$sevenZipSrc = Join-Path $repo "third-party/7-zip"
if (-not (Test-Path (Join-Path $sevenZipSrc "7z.exe"))) {
    Write-Host "7-Zip binaries missing; fetching..." -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot "fetch-7zip.ps1")
}
$sevenZipOut = Join-Path $appOut "tools/7-zip"
New-Item -ItemType Directory -Path $sevenZipOut -Force | Out-Null
foreach ($f in @("7z.exe", "7z.dll", "License.txt")) {
    $srcFile = Join-Path $sevenZipSrc $f
    if (Test-Path $srcFile) { Copy-Item $srcFile (Join-Path $sevenZipOut $f) -Force }
}
Write-Host "Bundled 7-Zip engine -> tools/7-zip" -ForegroundColor Green

# 5) Authenticode-sign the shipped executables (C3 anchor). Only runs when a cert thumbprint is
#    supplied; otherwise the dist is left unsigned for local/dev use.
if ($CertThumbprint -ne "") {
    $signtool = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if (-not $signtool) {
        throw "signtool.exe not found on PATH. Install the Windows SDK, or omit -CertThumbprint to skip signing."
    }

    $toSign = @("PDM.exe", "pdm-native-host.exe", "pdm-update.exe") |
        ForEach-Object { Join-Path $appOut $_ } |
        Where-Object { Test-Path $_ }

    Write-Host "Signing $($toSign.Count) executables (SHA-256, RFC-3161 timestamp)..." -ForegroundColor Cyan
    foreach ($f in $toSign) {
        & $signtool.Source sign /sha1 $CertThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 /q $f
        if ($LASTEXITCODE -ne 0) { throw "signtool failed for $f" }
    }
    Write-Host "Signed: $($toSign -join ', ')" -ForegroundColor Green
} else {
    Write-Host "No -CertThumbprint supplied; dist left UNSIGNED (self-integrity check will report Unsigned)." -ForegroundColor Yellow
}

$exe = Join-Path $appOut "PDM.exe"
$sizeMb = "{0:N1}" -f ((Get-Item $exe).Length / 1MB)
$totalMb = "{0:N1}" -f ((Get-ChildItem $appOut -Recurse | Measure-Object -Property Length -Sum).Sum / 1MB)
Write-Host ""
Write-Host "Runtime-free dist assembled: $appOut" -ForegroundColor Green
Write-Host "  PDM.exe: $sizeMb MB   total payload: $totalMb MB"
