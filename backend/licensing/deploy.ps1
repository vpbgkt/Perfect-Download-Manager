# Deploys the PDM licensing backend to AWS (region ap-south-1 by default).
#
# Prerequisites: AWS CLI configured, Node.js (for key generation only).
# What it does:
#   1. (First run) generates an ECDSA P-256 key pair; stores the PRIVATE key in SSM
#      SecureString and prints the PUBLIC key (base64) to embed in the client.
#   2. Zips the Lambda source and uploads it to a deploy bucket.
#   3. Deploys the CloudFormation stack (DynamoDB + Lambdas + HTTP API).
#   4. Prints the API base URL.
#
# Usage:
#   ./deploy.ps1                 # deploy (generates keys on first run)
#   ./deploy.ps1 -RotateKeys     # force-regenerate the signing key pair

param(
    [string]$Region = "ap-south-1",
    [string]$StackName = "pdm-licensing",
    [string]$TableName = "pdm-licenses",
    [string]$PrivateKeyParam = "/pdm/licensing/private-key",
    [switch]$RotateKeys
)

# AWS CLI writes progress to stderr; do NOT treat that as a terminating error.
$ErrorActionPreference = "Continue"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

function Assert-LastExit([string]$what) {
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Step failed: $what (exit $LASTEXITCODE)"
        exit 1
    }
}

$accountId = (aws sts get-caller-identity --query Account --output text).Trim()
Assert-LastExit "sts get-caller-identity"
$bucket = "pdm-licensing-deploy-$accountId-aps1"

Write-Host "Account: $accountId | Region: $Region | Bucket: $bucket"

# --- 1. Signing key pair -----------------------------------------------------
aws ssm get-parameter --name $PrivateKeyParam --region $Region --with-decryption > $null 2>&1
$paramExists = ($LASTEXITCODE -eq 0)

if ($RotateKeys -or -not $paramExists) {
    Write-Host "Generating ECDSA P-256 signing key pair..."
    $keygen = Join-Path $here "_keygen.mjs"
    @'
import c from "node:crypto";
const { privateKey, publicKey } = c.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
process.stdout.write(JSON.stringify({
  priv: privateKey.export({ type: "pkcs8", format: "pem" }),
  pub: Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64")
}));
'@ | Set-Content -Path $keygen -Encoding utf8
    $keys = (node $keygen | ConvertFrom-Json)
    Remove-Item $keygen -Force

    $tmp = New-TemporaryFile
    Set-Content -Path $tmp -Value $keys.priv -NoNewline
    aws ssm put-parameter --name $PrivateKeyParam --type SecureString --value (Get-Content $tmp -Raw) --overwrite --region $Region --description "PDM licensing ECDSA P-256 private key" | Out-Null
    Assert-LastExit "ssm put-parameter"
    Remove-Item $tmp -Force

    Write-Host ""
    Write-Host "=== EMBED THIS PUBLIC KEY IN THE CLIENT (LicensingConfig.PublicKeyBase64) ==="
    Write-Host $keys.pub
    Write-Host ""
} else {
    Write-Host "Signing key already present in SSM ($PrivateKeyParam). Use -RotateKeys to replace."
}

# --- 2. Package + upload Lambda ---------------------------------------------
aws s3api head-bucket --bucket $bucket --region $Region > $null 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "Creating deploy bucket $bucket..."
    aws s3api create-bucket --bucket $bucket --region $Region --create-bucket-configuration LocationConstraint=$Region | Out-Null
    Assert-LastExit "create deploy bucket"
}

$zip = Join-Path $here "lambda.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Write-Host "Packaging Lambda source..."
Compress-Archive -Path (Join-Path $here "src/*") -DestinationPath $zip -Force
$codeKey = "lambda-$(Get-Date -Format yyyyMMddHHmmss).zip"
aws s3 cp $zip "s3://$bucket/$codeKey" --region $Region | Out-Null
Assert-LastExit "upload lambda zip"
Remove-Item $zip -Force

# --- 3. Deploy stack ---------------------------------------------------------
Write-Host "Deploying CloudFormation stack $StackName..."
aws cloudformation deploy `
    --template-file (Join-Path $here "template.yaml") `
    --stack-name $StackName `
    --capabilities CAPABILITY_IAM `
    --region $Region `
    --parameter-overrides "CodeBucket=$bucket" "CodeKey=$codeKey" "PrivateKeyParam=$PrivateKeyParam" "TableName=$TableName"
Assert-LastExit "cloudformation deploy"

# --- 4. Output ---------------------------------------------------------------
$apiUrl = (aws cloudformation describe-stacks --stack-name $StackName --region $Region --query "Stacks[0].Outputs[?OutputKey=='ApiBaseUrl'].OutputValue" --output text).Trim()
Write-Host ""
Write-Host "=== DEPLOY COMPLETE ==="
Write-Host "API base URL (set LicensingConfig.ApiBaseUrl): $apiUrl"
Write-Host ""
Write-Host "Next: mint a license with"
Write-Host "  node admin/create-license.mjs --region $Region --table $TableName --owner 'You' --max-activations 3"
