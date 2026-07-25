# NativeAOT harness / gate (docs/MIGRATION-AVALONIA-NATIVEAOT.md §5, §10, §11 Phase 1).
#
# Publishes the PDM.Cli console app with NativeAOT and smoke-runs the resulting native binary on a
# clean machine. PDM.Cli drives a real download end-to-end through the *reused core* (HttpClientProvider
# /WinHTTP, RemoteFileInspector, JsonSidecarStateStore's source-gen JSON, DownloadEngine), so a green
# run proves the engine is AOT/trim-clean and that the published binary starts on a clean OS — exactly
# the failure class (missing runtime, R2R crash, Win10 startup) this gate exists to catch.
#
# The publish itself fails the build on any trim/AOT (IL2xxx/IL3xxx) finding because PDM.Cli sets
# TreatWarningsAsErrors + IsAotCompatible, so this script is a real gate, not advisory.
#
# Usage:
#   ./build/aot-harness.ps1                                   # publish + launch smoke (--help), no network
#   ./build/aot-harness.ps1 -Rid win-x64                      # explicit RID
#   ./build/aot-harness.ps1 -SmokeUrl "https://.../2mb.bin"   # additionally run a real download

param(
    [string]$Configuration = "Release",
    [string]$Rid = "win-x64",
    [string]$SmokeUrl = ""
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$project = Join-Path $repo "src/PDM.Cli/PDM.Cli.csproj"

Write-Host "== NativeAOT publish ($Rid, $Configuration) ==" -ForegroundColor Cyan
# PublishAot / InvariantGlobalization / StripSymbols come from PDM.Cli.csproj. A trim/AOT finding
# during ILC compilation returns a non-zero exit and fails this step.
dotnet publish $project -c $Configuration -r $Rid --nologo
if ($LASTEXITCODE -ne 0) { throw "NativeAOT publish failed (see trim/AOT diagnostics above)." }

# Locate the native binary the ILC linker produced.
$publishDir = Join-Path $repo "src/PDM.Cli/bin/$Configuration/net10.0/$Rid/native"
$exeName = if ($Rid -like "win-*") { "pdm.exe" } else { "pdm" }
$exe = Join-Path $publishDir $exeName
if (-not (Test-Path $exe)) { throw "Native binary not found at $exe" }

$sizeMb = "{0:N1}" -f ((Get-Item $exe).Length / 1MB)
Write-Host "Native binary: $exe ($sizeMb MB)" -ForegroundColor Green

# --- Launch smoke test: the AOT binary must start and run managed code on this clean machine. ---
Write-Host "== Launch smoke (--help) ==" -ForegroundColor Cyan
& $exe "--help" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "AOT binary failed to launch (--help exit $LASTEXITCODE)." }
Write-Host "Launch smoke passed." -ForegroundColor Green

# --- Optional real-download smoke: exercises the full engine + WinHTTP path under AOT. ---
if ($SmokeUrl -ne "") {
    Write-Host "== Download smoke ($SmokeUrl) ==" -ForegroundColor Cyan
    $dest = Join-Path ([System.IO.Path]::GetTempPath()) ("pdm-aot-" + [System.Guid]::NewGuid().ToString("N"))
    try {
        & $exe $SmokeUrl $dest --connections 4
        if ($LASTEXITCODE -ne 0) { throw "AOT download smoke failed (exit $LASTEXITCODE)." }
        Write-Host "Download smoke passed." -ForegroundColor Green
    }
    finally {
        if (Test-Path $dest) { Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue }
    }
}

Write-Host ""
Write-Host "AOT harness passed on $Rid." -ForegroundColor Green
