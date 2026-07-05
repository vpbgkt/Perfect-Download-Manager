# Deploys the update-hosting bucket and generates the update signing key pair.
#
# On first run:
#   1. Generates a fresh ECDSA P-256 key pair (separate from the licensing key).
#   2. Stores the PRIVATE key in SSM SecureString.
#   3. Prints the PUBLIC key (base64 SPKI) - copy to LicensingConfig.UpdatePublicKeyBase64.
#   4. Creates the S3 bucket (public-read on objects only) and prints the manifest URL.
#
# Usage:
#   ./deploy.ps1                    # deploy (generates keys on first run)
#   ./deploy.ps1 -RotateKeys        # replace the signing key (invalidates old signatures)

param(
    [string]$Region = "ap-south-1",
    [string]$StackName = "pdm-updates",
    [string]$BucketName = "pdm-updates",
    [string]$PrivateKeyParam = "/pdm/updates/private-key",
    [switch]$RotateKeys
)

$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Assert-LastExit([string]$what) {
    if ($LASTEXITCODE -ne 0) { Write-Error "Failed: $what"; exit 1 }
}

$accountId = (aws sts get-caller-identity --query Account --output text).Trim()
Assert-LastExit "sts get-caller-identity"
$bucket = "$BucketName-$accountId-aps1"

Write-Host "Account: $accountId | Region: $Region | Bucket: $bucket"

# --- 1. Signing key pair ------------------------------------------------------
aws ssm get-parameter --name $PrivateKeyParam --region $Region --with-decryption > $null 2>&1
$paramExists = ($LASTEXITCODE -eq 0)

if ($RotateKeys -or -not $paramExists) {
    Write-Host "Generating update-signing key pair (ECDSA P-256)..."
    $keygen = Join-Path $here "_keygen.mjs"
    @'
import c from "node:crypto";
const { privateKey, publicKey } = c.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
process.stdout.write(JSON.stringify({
  priv: privateKey.export({ type: "pkcs8", format: "pem" }),
  pub: Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64")
}));
'@ | Set-Content -Path $keygen -Encoding utf8
    $keys = node $keygen | ConvertFrom-Json
    Remove-Item $keygen -Force

    $tmp = New-TemporaryFile
    Set-Content -Path $tmp -Value $keys.priv -NoNewline
    aws ssm put-parameter --name $PrivateKeyParam --type SecureString --value (Get-Content $tmp -Raw) --overwrite --region $Region --description "PDM update-signing ECDSA P-256 private key" | Out-Null
    Assert-LastExit "ssm put-parameter"
    Remove-Item $tmp -Force

    Write-Host ""
    Write-Host "=== EMBED THIS UPDATE PUBLIC KEY IN THE CLIENT ==="
    Write-Host "Set LicensingConfig.UpdatePublicKeyBase64 to:"
    Write-Host $keys.pub
    Write-Host ""
} else {
    Write-Host "Update signing key already present in SSM ($PrivateKeyParam)."
}

# --- 2. Bucket stack ----------------------------------------------------------
Write-Host "Deploying CloudFormation stack $StackName..."
aws cloudformation deploy `
    --template-file (Join-Path $here "template.yaml") `
    --stack-name $StackName `
    --region $Region `
    --parameter-overrides "BucketName=$bucket"
Assert-LastExit "cloudformation deploy"

$stableUrl = (aws cloudformation describe-stacks --stack-name $StackName --region $Region --query "Stacks[0].Outputs[?OutputKey=='ManifestUrlStable'].OutputValue" --output text).Trim()

Write-Host ""
Write-Host "=== UPDATE HOSTING READY ==="
Write-Host "Bucket:                 $bucket"
Write-Host "Stable manifest URL:    $stableUrl"
Write-Host ""
Write-Host "Set AppSettings.UpdateManifestUrl (or embed in LicensingConfig) to the stable URL,"
Write-Host "then run ./sign-release.ps1 to publish your first release."
