# Data Migration Script for Phase 1 & 2
#
# This script updates existing reseller accounts with new required fields:
# - accountType: defaults to "reseller"
# - balance: defaults to 0
# - discountPercent: defaults to 0
# - passwordHash: existing accounts without a password remain unable to log in
#
# IMPORTANT: Review existing accounts before running. Backup recommended.
# This script is idempotent - safe to re-run.

param(
  [string]$Region = "ap-south-1",
  [int]$DefaultBalance = 0,
  [int]$DefaultDiscount = 0,
  [switch]$DryRun = $false
)

$ErrorActionPreference = "Stop"

Write-Host "=== Account Data Migration Script ===" -ForegroundColor Cyan
Write-Host "Region: $Region" -ForegroundColor Gray
Write-Host "Dry Run: $DryRun" -ForegroundColor Gray
Write-Host ""

if ($DryRun) {
  Write-Host "DRY RUN MODE: No changes will be made to the database" -ForegroundColor Yellow
  Write-Host ""
}

# ────────────────────────────────────────────────────────────────────────────
# Fetch existing reseller accounts
# ────────────────────────────────────────────────────────────────────────────

Write-Host "Fetching existing accounts from pdm-portal-resellers..." -ForegroundColor Yellow

$scanResult = aws dynamodb scan `
  --table-name pdm-portal-resellers `
  --region $Region `
  --output json 2>&1

if ($LASTEXITCODE -ne 0) {
  Write-Host "ERROR: Failed to scan pdm-portal-resellers table" -ForegroundColor Red
  Write-Host $scanResult -ForegroundColor Red
  exit 1
}

$data = $scanResult | ConvertFrom-Json
$accounts = $data.Items

Write-Host "Found $($accounts.Count) existing accounts" -ForegroundColor Gray
Write-Host ""

if ($accounts.Count -eq 0) {
  Write-Host "No accounts to migrate. Exiting." -ForegroundColor Green
  exit 0
}

# ────────────────────────────────────────────────────────────────────────────
# Update each account
# ────────────────────────────────────────────────────────────────────────────

$updated = 0
$skipped = 0
$failed = 0

foreach ($account in $accounts) {
  $accountId = $account.resellerAccountId.S
  $orgName = $account.orgName.S
  
  Write-Host "Processing: $orgName ($accountId)" -ForegroundColor Cyan
  
  # Check which fields need to be added
  $needsUpdate = $false
  $updates = @()
  $attrNames = @{}
  $attrValues = @{}
  
  # accountType
  if (-not $account.accountType) {
    $needsUpdate = $true
    $updates += "#accountType = :accountType"
    $attrNames["#accountType"] = "accountType"
    $attrValues[":accountType"] = @{ S = "reseller" }
    Write-Host "  + accountType: reseller" -ForegroundColor Gray
  }
  
  # balance
  if (-not $account.balance) {
    $needsUpdate = $true
    $updates += "#balance = :balance"
    $attrNames["#balance"] = "balance"
    $attrValues[":balance"] = @{ N = "$DefaultBalance" }
    Write-Host "  + balance: $DefaultBalance" -ForegroundColor Gray
  }
  
  # discountPercent
  if (-not $account.discountPercent) {
    $needsUpdate = $true
    $updates += "discountPercent = :discountPercent"
    $attrValues[":discountPercent"] = @{ N = "$DefaultDiscount" }
    Write-Host "  + discountPercent: $DefaultDiscount%" -ForegroundColor Gray
  }
  
  if (-not $needsUpdate) {
    Write-Host "  SKIP (already migrated)" -ForegroundColor Gray
    $skipped++
    Write-Host ""
    continue
  }
  
  if ($DryRun) {
    Write-Host "  DRY RUN - Would update account" -ForegroundColor Yellow
    $updated++
    Write-Host ""
    continue
  }
  
  # Build update expression
  $updateExpr = "SET " + ($updates -join ", ")
  
  # Convert to JSON for AWS CLI
  $attrNamesJson = $attrNames | ConvertTo-Json -Compress
  $attrValuesJson = $attrValues | ConvertTo-Json -Compress -Depth 10
  
  try {
    $updateCmd = @"
aws dynamodb update-item \
  --table-name pdm-portal-resellers \
  --key '{\"resellerAccountId\":{\"S\":\"$accountId\"}}' \
  --update-expression '$updateExpr' \
  --expression-attribute-names '$attrNamesJson' \
  --expression-attribute-values '$attrValuesJson' \
  --region $Region \
  --output json
"@
    
    Invoke-Expression $updateCmd | Out-Null
    
    if ($LASTEXITCODE -eq 0) {
      Write-Host "  SUCCESS" -ForegroundColor Green
      $updated++
    } else {
      Write-Host "  FAILED" -ForegroundColor Red
      $failed++
    }
  } catch {
    Write-Host "  ERROR: $_" -ForegroundColor Red
    $failed++
  }
  
  Write-Host ""
}

# ────────────────────────────────────────────────────────────────────────────
# Summary
# ────────────────────────────────────────────────────────────────────────────

Write-Host "=== Migration Summary ===" -ForegroundColor Cyan
Write-Host "Total accounts: $($accounts.Count)" -ForegroundColor Gray
Write-Host "Updated: $updated" -ForegroundColor Green
Write-Host "Skipped: $skipped" -ForegroundColor Gray
Write-Host "Failed: $failed" -ForegroundColor $(if ($failed -gt 0) { "Red" } else { "Gray" })
Write-Host ""

if ($DryRun) {
  Write-Host "This was a DRY RUN. No changes were made." -ForegroundColor Yellow
  Write-Host "Run without -DryRun flag to apply changes." -ForegroundColor Yellow
} elseif ($failed -eq 0) {
  Write-Host "Migration completed successfully!" -ForegroundColor Green
  
  Write-Host ""
  Write-Host "Accounts without an existing password hash were left unchanged." -ForegroundColor Yellow
  Write-Host "Set each account password through an authorized, verified process before enabling login." -ForegroundColor Yellow
} else {
  Write-Host "Migration completed with errors. Review failed accounts above." -ForegroundColor Red
  exit 1
}

Write-Host ""
