# Release hardening: obfuscate PDM.Licensing after a Release build.
#
# Usage (from repo root):
#   dotnet build -c Release
#   ./build/obfuscate.ps1
#
# Installs Obfuscar as a local dotnet tool if needed, then rewrites PDM.Licensing.dll in the
# Release output with renamed private members, obscured control flow, and hidden strings.

param(
    [string]$Configuration = "Release",
    [string]$Tfm = "net10.0"
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$out = Join-Path $repo "src/PDM.Licensing/bin/$Configuration/$Tfm"

if (-not (Test-Path (Join-Path $out "PDM.Licensing.dll"))) {
    Write-Error "Build PDM.Licensing in $Configuration first (dotnet build -c $Configuration)."
    exit 1
}

# Ensure a local tool manifest + Obfuscar.
if (-not (Test-Path (Join-Path $repo ".config/dotnet-tools.json"))) {
    Push-Location $repo
    dotnet new tool-manifest | Out-Null
    Pop-Location
}
Push-Location $repo
dotnet tool install Obfuscar.GlobalTool 2>$null | Out-Null
Pop-Location

# Run Obfuscar with the output path pointed at the build folder.
$config = Join-Path $PSScriptRoot "obfuscar.xml"
Push-Location $out
dotnet obfuscar.console $config -InPath="$out" -OutPath="$out" 2>&1 | Write-Host
Pop-Location

Write-Host "Obfuscation complete: $out\PDM.Licensing.dll"
Write-Host "NOTE: PDM.App is intentionally not obfuscated (WPF binding relies on member names)."
