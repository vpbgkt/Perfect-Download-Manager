# Signs a release package and publishes it (+ its manifest) to the update bucket.
#
# Prereqs:
#   1. ./build/publish.ps1 has produced dist/PDM-<version>.zip.
#   2. ./deploy.ps1 has been run (bucket exists, SSM key exists).
#
# What it does:
#   1. Computes size and SHA-256 of dist/PDM-<version>.zip.
#   2. Fetches the ECDSA private key from SSM, builds and signs a manifest JSON.
#   3. Uploads the .zip and manifest.json to s3://<bucket>/<channel>/.
#
# Usage:
#   ./sign-release.ps1 -Version 1.0.0
#   ./sign-release.ps1 -Version 1.1.0-beta.1 -Channel Beta
#   ./sign-release.ps1 -Version 1.2.0 -ReleaseNotes "Fixed X, improved Y."

param(
    [Parameter(Mandatory = $true)][string]$Version,
    [ValidateSet("Stable", "Beta")][string]$Channel = "Stable",
    [string]$ReleaseNotes = "",
    [string]$Region = "ap-south-1",
    [string]$BucketName = "pdm-updates",
    [string]$PrivateKeyParam = "/pdm/updates/private-key"
)

$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent (Split-Path -Parent $here)

$accountId = (aws sts get-caller-identity --query Account --output text).Trim()
if ($LASTEXITCODE -ne 0) { Write-Error "aws sts get-caller-identity failed"; exit 1 }
$bucket = "$BucketName-$accountId-aps1"

$zip = Join-Path $repo "dist/PDM-$Version.zip"
if (-not (Test-Path $zip)) {
    Write-Error "Package not found at $zip. Run ./build/publish.ps1 -Version $Version first."
    exit 1
}

$size = (Get-Item $zip).Length
$hash = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()

$channelKey = $Channel.ToLower()
$packageKey = "$channelKey/pdm-$Version.zip"
$packageUrl = "https://$bucket.s3.$Region.amazonaws.com/$packageKey"

Write-Host "Package: $zip"
Write-Host "Size:    $size bytes"
Write-Host "SHA-256: $hash"

# 1. Upload the package first (idempotent, so re-runs are safe).
Write-Host "Uploading package to s3://$bucket/$packageKey ..."
aws s3 cp $zip "s3://$bucket/$packageKey" --region $Region | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "package upload failed"; exit 1 }

# 2. Sign the manifest with the SSM private key.
Write-Host "Signing manifest..."
$signer = Join-Path $here "_sign.mjs"
@'
import crypto from "node:crypto";
import fs from "node:fs";

// PEM comes from a temp file whose path is in PDM_SIGN_PEM_FILE (env vars mangle multi-line
// strings on Windows). Metadata comes via stdin JSON.
const pemFile = process.env.PDM_SIGN_PEM_FILE;
if (!pemFile) { console.error("PDM_SIGN_PEM_FILE env var is required"); process.exit(2); }
const privateKeyPem = fs.readFileSync(pemFile, "utf8");
const args = JSON.parse(fs.readFileSync(0, "utf8"));

// Build the manifest matching UpdateManifest fields. Property order and null handling must
// match the .NET client's serializer (JsonIgnoreCondition.WhenWritingNull, JsonStringEnumConverter).
const manifest = {
  Version: args.version,
  Channel: args.channel,
  PackageUrl: args.packageUrl,
  PackageSizeBytes: args.size,
  PackageSha256: args.hash,
  ReleasedUtc: new Date().toISOString()
};
if (args.releaseNotes) manifest.ReleaseNotes = args.releaseNotes;

const payload = JSON.stringify(manifest);
const key = crypto.createPrivateKey(privateKeyPem);
const signature = crypto.sign("sha256", Buffer.from(payload, "utf8"), { key, dsaEncoding: "der" });
manifest.Signature = signature.toString("base64");

process.stdout.write(JSON.stringify(manifest, null, 2));
'@ | Set-Content -Path $signer -Encoding utf8

# Save the PEM to a temp file so newlines survive (Windows env vars mangle multi-line strings).
$pemJson = aws ssm get-parameter --name $PrivateKeyParam --region $Region --with-decryption --output json
if ([string]::IsNullOrWhiteSpace($pemJson)) { Write-Error "Could not fetch signing key from SSM"; exit 1 }
$pemObj = $pemJson | ConvertFrom-Json
$privatePem = $pemObj.Parameter.Value
if ([string]::IsNullOrWhiteSpace($privatePem)) { Write-Error "SSM returned empty key"; exit 1 }

$pemTemp = New-TemporaryFile
Set-Content -Path $pemTemp -Value $privatePem -NoNewline -Encoding ascii

$input = @{
    version = $Version
    channel = $Channel
    packageUrl = $packageUrl
    size = $size
    hash = $hash
    releaseNotes = $ReleaseNotes
} | ConvertTo-Json -Compress

$env:PDM_SIGN_PEM_FILE = $pemTemp.FullName
try {
    $manifestJson = $input | node $signer
} finally {
    Remove-Item Env:\PDM_SIGN_PEM_FILE -ErrorAction SilentlyContinue
    Remove-Item $pemTemp -Force
    Remove-Item $signer -Force
}

if ([string]::IsNullOrWhiteSpace($manifestJson)) { Write-Error "Signing failed"; exit 1 }

$manifestPath = Join-Path $repo "dist/manifest-$Channel-$Version.json"
# Write UTF-8 WITHOUT BOM so the client's JSON parser gets clean bytes over the wire.
[System.IO.File]::WriteAllBytes($manifestPath, [System.Text.UTF8Encoding]::new($false).GetBytes($manifestJson))

# 3. Upload the manifest so the client picks it up on next check.
Write-Host "Uploading manifest to s3://$bucket/$channelKey/manifest.json ..."
aws s3 cp $manifestPath "s3://$bucket/$channelKey/manifest.json" --content-type "application/json" --region $Region | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "manifest upload failed"; exit 1 }

Write-Host ""
Write-Host "=== PUBLISHED ==="
Write-Host "Channel:      $Channel"
Write-Host "Version:      $Version"
Write-Host "Manifest URL: https://$bucket.s3.$Region.amazonaws.com/$channelKey/manifest.json"
Write-Host "Package URL:  $packageUrl"
Write-Host ""
Write-Host "Clients on this channel will offer the update on their next Check for Updates."
