# Publishes the Avalonia desktop head as a NativeAOT, self-contained, runtime-free binary
# (docs/MIGRATION-AVALONIA-NATIVEAOT.md §9, §11 Phase 2). This is the artifact the retargeted WiX
# installer will package, replacing the framework-dependent WPF payload + bundled .NET runtime.
#
# §14-locked flags: win-x64, InvariantGlobalization on, symbols stripped, ReadyToRun OFF (AOT
# supersedes it and R2R caused the field startup crash). Compiled bindings are on by default in the
# project. Third-party trim warnings (Avalonia.Controls.DataGrid, Serilog) are expected and do not
# fail the publish; revisit with targeted trimmer roots when tightening trim hygiene.
#
# Usage:
#   ./build/publish-avalonia-aot.ps1
#   ./build/publish-avalonia-aot.ps1 -Rid win-x64 -Configuration Release

param(
    [string]$Configuration = "Release",
    [string]$Rid = "win-x64"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$project = Join-Path $repo "src/PDM.App.Avalonia/PDM.App.Avalonia.csproj"

Write-Host "== Avalonia NativeAOT publish ($Rid, $Configuration) ==" -ForegroundColor Cyan
dotnet publish $project -c $Configuration -r $Rid --nologo `
    -p:PublishAot=true `
    -p:InvariantGlobalization=true `
    -p:StripSymbols=true `
    -p:PublishReadyToRun=false
if ($LASTEXITCODE -ne 0) { throw "Avalonia NativeAOT publish failed." }

$publishDir = Join-Path $repo "src/PDM.App.Avalonia/bin/$Configuration/net10.0-windows10.0.19041.0/$Rid/publish"
$exe = Join-Path $publishDir "PDM.exe"
if (-not (Test-Path $exe)) { throw "Native binary not found at $exe" }

$sizeMb = "{0:N1}" -f ((Get-Item $exe).Length / 1MB)
Write-Host ""
Write-Host "Published NativeAOT binary: $exe ($sizeMb MB)" -ForegroundColor Green
