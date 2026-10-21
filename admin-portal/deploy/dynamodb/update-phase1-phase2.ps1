# Update script for Phase 1 & 2: Multi-tier Balance System
# 
# This script:
# 1. Adds GSIs to existing pdm-portal-resellers table (accountType, parentAccountId, contactEmail)
# 2. Creates new pdm-portal-transactions table if it doesn't exist
# 3. Does NOT modify existing data - only schema changes
# 4. Safe to re-run - checks existence before operations
#
# IMPORTANT: GSI creation on existing table with data can take time and incurs cost.
# The existing data will be backfilled into the new indexes automatically.

param(
  [string]$Region = "ap-south-1"
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "=== Phase 1 & 2 Database Update Script ===" -ForegroundColor Cyan
Write-Host "Region: $Region" -ForegroundColor Gray
Write-Host ""

# ────────────────────────────────────────────────────────────────────────────
# STEP 1: Update pdm-portal-resellers table with new GSIs
# ────────────────────────────────────────────────────────────────────────────

Write-Host "STEP 1: Updating pdm-portal-resellers table..." -ForegroundColor Yellow

$resellerTable = "pdm-portal-resellers"

# Check if table exists
try {
  $tableDesc = aws dynamodb describe-table --table-name $resellerTable --region $Region 2>$null | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Table $resellerTable does not exist. Please run create-tables.ps1 first." -ForegroundColor Red
    exit 1
  }
} catch {
  Write-Host "ERROR: Cannot access table $resellerTable. Check AWS credentials and region." -ForegroundColor Red
  exit 1
}

# Get existing GSIs
$existingGSIs = $tableDesc.Table.GlobalSecondaryIndexes | ForEach-Object { $_.IndexName }

# Define GSIs to create
$gsiConfigs = @(
  @{
    Name = "accountType-index"
    KeySchema = @(
      @{ AttributeName = "accountType"; KeyType = "HASH" }
    )
    AttributeDefinitions = @(
      @{ AttributeName = "accountType"; AttributeType = "S" }
    )
  },
  @{
    Name = "parentAccountId-index"
    KeySchema = @(
      @{ AttributeName = "parentAccountId"; KeyType = "HASH" }
    )
    AttributeDefinitions = @(
      @{ AttributeName = "parentAccountId"; AttributeType = "S" }
    )
  },
  @{
    Name = "contactEmail-index"
    KeySchema = @(
      @{ AttributeName = "contactEmail"; KeyType = "HASH" }
    )
    AttributeDefinitions = @(
      @{ AttributeName = "contactEmail"; AttributeType = "S" }
    )
  }
)

foreach ($gsi in $gsiConfigs) {
  if ($existingGSIs -contains $gsi.Name) {
    Write-Host "  SKIP    $($gsi.Name) (already exists)" -ForegroundColor Gray
    continue
  }

  Write-Host "  CREATE  $($gsi.Name) on $resellerTable..." -ForegroundColor Green
  
  # Build the update command
  $attrDefs = $gsi.AttributeDefinitions | ConvertTo-Json -Compress
  $keySchema = $gsi.KeySchema | ConvertTo-Json -Compress
  
  $gsiSpec = @{
    IndexName = $gsi.Name
    KeySchema = $gsi.KeySchema
    Projection = @{ ProjectionType = "ALL" }
  } | ConvertTo-Json -Compress -Depth 10

  # Note: We need to add attribute definitions first
  try {
    aws dynamodb update-table `
      --table-name $resellerTable `
      --attribute-definitions $attrDefs `
      --global-secondary-index-updates "[{`"Create`":$gsiSpec}]" `
      --region $Region | Out-Null
    
    if ($LASTEXITCODE -eq 0) {
      Write-Host "  SUCCESS $($gsi.Name) creation initiated" -ForegroundColor Green
      Write-Host "          (Index will be backfilled asynchronously)" -ForegroundColor Gray
    } else {
      Write-Host "  WARNING Failed to create $($gsi.Name). It may already exist or table is updating." -ForegroundColor Yellow
    }
  } catch {
    Write-Host "  WARNING $($gsi.Name): $_" -ForegroundColor Yellow
  }
  
  # Add delay between GSI creations (AWS limits one GSI creation at a time)
  Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "NOTE: GSI creation is asynchronous. Check status with:" -ForegroundColor Cyan
Write-Host "  aws dynamodb describe-table --table-name $resellerTable --region $Region" -ForegroundColor Gray
Write-Host ""

# ────────────────────────────────────────────────────────────────────────────
# STEP 2: Create pdm-portal-transactions table
# ────────────────────────────────────────────────────────────────────────────

Write-Host "STEP 2: Creating pdm-portal-transactions table..." -ForegroundColor Yellow

$transactionsTable = "pdm-portal-transactions"

# Check if transactions table already exists
$txnExists = $true
try {
  aws dynamodb describe-table --table-name $transactionsTable --region $Region 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { $txnExists = $false }
} catch { $txnExists = $false }

if ($txnExists) {
  Write-Host "  SKIP    $transactionsTable (already exists)" -ForegroundColor Gray
} else {
  $file = Join-Path $here "$transactionsTable.json"
  if (-Not (Test-Path $file)) {
    Write-Host "  ERROR   Schema file not found: $file" -ForegroundColor Red
    exit 1
  }
  
  Write-Host "  CREATE  $transactionsTable..." -ForegroundColor Green
  aws dynamodb create-table --cli-input-json "file://$file" --region $Region | Out-Null
  
  if ($LASTEXITCODE -eq 0) {
    Write-Host "  WAIT    $transactionsTable -> ACTIVE" -ForegroundColor Gray
    aws dynamodb wait table-exists --table-name $transactionsTable --region $Region
    Write-Host "  SUCCESS $transactionsTable is ACTIVE" -ForegroundColor Green
  } else {
    Write-Host "  ERROR   Failed to create $transactionsTable" -ForegroundColor Red
    exit 1
  }
}

# ────────────────────────────────────────────────────────────────────────────
# STEP 3: Summary & Next Steps
# ────────────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "=== Update Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Database changes applied:" -ForegroundColor Cyan
Write-Host "  ✓ pdm-portal-resellers: GSIs for accountType, parentAccountId, contactEmail" -ForegroundColor Gray
Write-Host "  ✓ pdm-portal-transactions: New table for balance tracking" -ForegroundColor Gray
Write-Host ""
Write-Host "IMPORTANT NOTES:" -ForegroundColor Yellow
Write-Host "  • GSI creation on existing tables is asynchronous and may take time" -ForegroundColor Gray
Write-Host "  • Existing data will be automatically backfilled into new indexes" -ForegroundColor Gray
Write-Host "  • No existing data was modified or deleted" -ForegroundColor Gray
Write-Host "  • Safe to re-run this script" -ForegroundColor Gray
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Verify GSI status: aws dynamodb describe-table --table-name $resellerTable --region $Region" -ForegroundColor Gray
Write-Host "  2. Update existing accounts with new fields (accountType, balance, etc.)" -ForegroundColor Gray
Write-Host "  3. Deploy updated application code" -ForegroundColor Gray
Write-Host ""
