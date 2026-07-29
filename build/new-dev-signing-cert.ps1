# Creates a SELF-SIGNED code-signing certificate for LOCAL pipeline testing ONLY.
#
# WARNING: This is NOT for production. A self-signed cert lets you exercise the signing pipeline and
# validate the runtime self-integrity check (TamperGuard.VerifySelfIntegrity → Trusted/Tampered),
# but it will trip SmartScreen and is not trusted on other machines. For public distribution buy a
# real Authenticode (OV) or EV code-signing certificate and use its thumbprint with build/sign.ps1.
#
# What it does:
#   1. Creates a code-signing cert in CurrentUser\My.
#   2. (Optional, -Trust) copies it into CurrentUser\Root so WinVerifyTrust treats it as trusted on
#      THIS machine — required to see VerifySelfIntegrity return Trusted locally.
#   3. Prints the thumbprint to pass to build/sign.ps1 or publish-aot-dist.ps1 -CertThumbprint.
#
# Remove later with:  ./build/new-dev-signing-cert.ps1 -Remove
#
# Usage:
#   ./build/new-dev-signing-cert.ps1 -Trust
#   ./build/new-dev-signing-cert.ps1 -Remove

param(
    [string]$Subject = "CN=PDM Dev Code Signing (TEST ONLY)",
    [switch]$Trust,
    [switch]$Remove
)

$ErrorActionPreference = "Stop"

if ($Remove) {
    foreach ($store in @("Cert:\CurrentUser\My", "Cert:\CurrentUser\Root")) {
        Get-ChildItem $store | Where-Object { $_.Subject -eq $Subject } | ForEach-Object {
            Write-Host "Removing $($_.Thumbprint) from $store"
            Remove-Item "$store\$($_.Thumbprint)" -Force
        }
    }
    Write-Host "Dev signing cert removed." -ForegroundColor Green
    return
}

$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $Subject `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -KeyUsage DigitalSignature `
    -KeyAlgorithm RSA -KeyLength 2048 `
    -NotAfter (Get-Date).AddYears(2)

Write-Host "Created dev code-signing cert." -ForegroundColor Green
Write-Host "  Thumbprint: $($cert.Thumbprint)"

if ($Trust) {
    $root = "Cert:\CurrentUser\Root"
    $tmp = Join-Path $env:TEMP "pdm-dev-codesign.cer"
    Export-Certificate -Cert $cert -FilePath $tmp | Out-Null
    Import-Certificate -FilePath $tmp -CertStoreLocation $root | Out-Null
    Remove-Item $tmp -Force
    Write-Host "  Added to CurrentUser\Root (trusted on this machine for testing)." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Sign with:  ./build/sign.ps1 -Thumbprint $($cert.Thumbprint) -Paths dist/PDM/*.exe"
Write-Host "Or publish: ./build/publish-aot-dist.ps1 -CertThumbprint $($cert.Thumbprint)"
