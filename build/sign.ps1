# Authenticode-signs one or more files (SHA-256 + RFC-3161 timestamp).
#
# This is the reusable signing primitive used by publish-aot-dist.ps1 and by the installer build.
# Signing is the real anti-tamper anchor (docs/SECURITY.md, C3): once signed, any post-sign patch —
# including swapping the embedded licensing key — invalidates the signature, which the runtime
# self-integrity check (TamperGuard.VerifySelfIntegrity) then detects.
#
# Usage:
#   ./build/sign.ps1 -Thumbprint <certSha1> -Paths dist/PDM/PDM.exe,dist/PDM/pdm-update.exe
#   ./build/sign.ps1 -Thumbprint <certSha1> -Paths dist/PDM/*.exe
#
# For production use a proper Authenticode / EV code-signing certificate (thumbprint from the
# machine's certificate store). For local pipeline testing, generate a dev cert with
# build/new-dev-signing-cert.ps1 and pass its thumbprint here.

param(
    [Parameter(Mandatory = $true)][string]$Thumbprint,
    [Parameter(Mandatory = $true)][string[]]$Paths,
    [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"

function Resolve-SignTool {
    $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidate = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -like "*x64*" } |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($candidate) { return $candidate.FullName }
    throw "signtool.exe not found. Install the Windows 10/11 SDK."
}

$signtool = Resolve-SignTool

# Expand globs to concrete files.
$files = @()
foreach ($p in $Paths) { $files += (Get-Item $p -ErrorAction Stop).FullName }
if ($files.Count -eq 0) { throw "No files matched -Paths." }

Write-Host "Signing $($files.Count) file(s) with cert $Thumbprint ..." -ForegroundColor Cyan
& $signtool sign /sha1 $Thumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 /q @files
if ($LASTEXITCODE -ne 0) { throw "signtool sign failed (exit $LASTEXITCODE)." }

# Verify the signatures chain to a trusted root (/pa = default authenticode policy).
& $signtool verify /pa /q @files
if ($LASTEXITCODE -ne 0) {
    Write-Warning "signtool verify reported the signature does not chain to a trusted root."
    Write-Warning "This is expected for a self-signed DEV cert unless it is in Trusted Root."
} else {
    Write-Host "All signatures verified against a trusted root." -ForegroundColor Green
}
