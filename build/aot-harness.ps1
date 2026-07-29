# NativeAOT harness / gate (docs/MIGRATION-AVALONIA-NATIVEAOT.md §5, §10, §11 Phase 1).
#
# Publishes PDM.AotHarness with NativeAOT and runs the resulting native binary on a clean machine.
# The harness references and exercises the whole reused non-UI stack — Core (download engine + JSON
# source-gen), Infrastructure (SQLite via SQLitePCLRaw bundle_e_sqlite3), Licensing (ECDSA verify +
# DPAPI), and Updater (signed-manifest canonicalization). A green run proves that stack both compiles
# AND runs under AOT, and that the published binary starts on a clean OS — the failure class (missing
# runtime, R2R crash, missing native dep) this gate exists to catch.
#
# The publish fails on any trim/AOT (IL2xxx/IL3xxx) finding because PDM.AotHarness sets
# TreatWarningsAsErrors + IsAotCompatible, so this script is a real gate, not advisory.
#
# Usage:
#   ./build/aot-harness.ps1                                   # publish + full self-test (no network)
#   ./build/aot-harness.ps1 -Rid win-x64                      # explicit RID
#   ./build/aot-harness.ps1 -SmokeUrl "https://.../2mb.bin"   # also run a real download end-to-end

param(
    [string]$Configuration = "Release",
    [string]$Rid = "win-x64",
    [string]$SmokeUrl = ""
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$project = Join-Path $repo "src/PDM.AotHarness/PDM.AotHarness.csproj"

Write-Host "== NativeAOT publish ($Rid, $Configuration) ==" -ForegroundColor Cyan
# PublishAot / InvariantGlobalization / StripSymbols come from PDM.AotHarness.csproj. A trim/AOT
# finding during ILC compilation returns a non-zero exit and fails this step.
dotnet publish $project -c $Configuration -r $Rid --nologo
if ($LASTEXITCODE -ne 0) { throw "NativeAOT publish failed (see trim/AOT diagnostics above)." }

# Run from the publish folder: it contains the native binary AND any native dependencies the ILC
# linker copies out (e.g. e_sqlite3.dll), which the intermediate 'native/' folder does not.
$publishDir = Join-Path $repo "src/PDM.AotHarness/bin/$Configuration/net10.0/$Rid/publish"
$exeName = if ($Rid -like "win-*") { "pdm-aot-harness.exe" } else { "pdm-aot-harness" }
$exe = Join-Path $publishDir $exeName
if (-not (Test-Path $exe)) { throw "Native binary not found at $exe" }

$sizeMb = "{0:N1}" -f ((Get-Item $exe).Length / 1MB)
Write-Host "Native binary: $exe ($sizeMb MB)" -ForegroundColor Green

# Run the self-test (and, when a URL is supplied, a real download). The harness returns non-zero
# if any check fails; it exercises SQLite, JSON source-gen, ECDSA/DPAPI, and manifest signing.
Write-Host "== AOT self-test ==" -ForegroundColor Cyan
if ($SmokeUrl -ne "") {
    & $exe $SmokeUrl
} else {
    & $exe
}
if ($LASTEXITCODE -ne 0) { throw "AOT self-test failed (exit $LASTEXITCODE)." }

Write-Host ""
Write-Host "AOT harness passed on $Rid." -ForegroundColor Green
