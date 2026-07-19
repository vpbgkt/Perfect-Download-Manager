# Creates ONLY the seven pdm-portal-* DynamoDB tables in ap-south-1.
# Create-only + idempotent: existing tables are skipped, nothing is ever deleted
# or modified. Safe to re-run. Does not touch pdm-licenses or any other table.

param(
  [string]$Region = "ap-south-1"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$tables = @(
  "pdm-portal-admins",
  "pdm-portal-resellers",
  "pdm-portal-apikeys",
  "pdm-portal-counters",
  "pdm-portal-seo",
  "pdm-portal-releases",
  "pdm-portal-audit"
)

foreach ($t in $tables) {
  $exists = $true
  try {
    aws dynamodb describe-table --table-name $t --region $Region 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) { $exists = $false }
  } catch { $exists = $false }

  if ($exists) {
    Write-Host "SKIP  $t (already exists)"
    continue
  }

  $file = Join-Path $here "$t.json"
  Write-Host "CREATE $t ..."
  aws dynamodb create-table --cli-input-json "file://$file" --region $Region | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "create-table failed for $t" }
}

# Wait for all to become ACTIVE.
foreach ($t in $tables) {
  Write-Host "WAIT  $t -> ACTIVE"
  aws dynamodb wait table-exists --table-name $t --region $Region
}

# Enable TTL on the rate-limit/quota counters table (attribute: expiresAt).
Write-Host "TTL   pdm-portal-counters (expiresAt)"
aws dynamodb update-time-to-live `
  --table-name pdm-portal-counters `
  --time-to-live-specification "Enabled=true,AttributeName=expiresAt" `
  --region $Region | Out-Null

Write-Host "Done."
