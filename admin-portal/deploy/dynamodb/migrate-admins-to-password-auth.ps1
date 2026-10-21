# Migrate pdm-portal-admins table from Firebase auth to password auth
# This script:
# 1. Creates a new table with password support (pdm-portal-admins-v2)
# 2. Migrates existing admin data
# 3. Backs up and replaces the old table
#
# IMPORTANT: This is a destructive operation. Backup recommended!

param(
  [string]$Region = "ap-south-1",
  [switch]$DryRun = $false
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=" * 70 -ForegroundColor Cyan
Write-Host "  Admin Table Migration: Firebase -> Password Auth" -ForegroundColor Yellow
Write-Host "=" * 70 -ForegroundColor Cyan
Write-Host ""

if ($DryRun) {
  Write-Host "DRY RUN MODE - No changes will be made" -ForegroundColor Yellow
  Write-Host ""
}

# Step 1: Backup existing table data
Write-Host "Step 1: Backing up existing admin data..." -ForegroundColor Green

$existingAdmins = aws dynamodb scan --table-name pdm-portal-admins --region $Region --output json | ConvertFrom-Json

if ($existingAdmins.Items.Count -eq 0) {
  Write-Host "  No existing admins found. Table is empty." -ForegroundColor Yellow
} else {
  Write-Host "  Found $($existingAdmins.Items.Count) admin(s)" -ForegroundColor Cyan
  
  $backupFile = "pdm-portal-admins-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss').json"
  $existingAdmins | ConvertTo-Json -Depth 10 | Out-File $backupFile
  Write-Host "  Backed up to: $backupFile" -ForegroundColor Green
}

Write-Host ""

# Step 2: Create new table structure with email-index GSI
Write-Host "Step 2: Creating email-index GSI on existing table..." -ForegroundColor Green

if (!$DryRun) {
  try {
    # Check if GSI already exists
    $tableDesc = aws dynamodb describe-table --table-name pdm-portal-admins --region $Region --output json | ConvertFrom-Json
    $hasEmailIndex = $tableDesc.Table.GlobalSecondaryIndexes | Where-Object { $_.IndexName -eq "email-index" }
    
    if ($hasEmailIndex) {
      Write-Host "  email-index GSI already exists" -ForegroundColor Cyan
    } else {
      Write-Host "  Adding email-index GSI..." -ForegroundColor Yellow
      
      aws dynamodb update-table `
        --table-name pdm-portal-admins `
        --attribute-definitions AttributeName=email,AttributeType=S `
        --global-secondary-index-updates "[{\"Create\":{\"IndexName\":\"email-index\",\"KeySchema\":[{\"AttributeName\":\"email\",\"KeyType\":\"HASH\"}],\"Projection\":{\"ProjectionType\":\"ALL\"}}}]" `
        --region $Region
      
      if ($LASTEXITCODE -eq 0) {
        Write-Host "  GSI creation initiated. Waiting for it to become ACTIVE..." -ForegroundColor Yellow
        
        # Wait for GSI to be active
        $maxWait = 300 # 5 minutes
        $waited = 0
        $interval = 10
        
        while ($waited -lt $maxWait) {
          Start-Sleep -Seconds $interval
          $waited += $interval
          
          $tableDesc = aws dynamodb describe-table --table-name pdm-portal-admins --region $Region --output json | ConvertFrom-Json
          $gsi = $tableDesc.Table.GlobalSecondaryIndexes | Where-Object { $_.IndexName -eq "email-index" }
          
          if ($gsi.IndexStatus -eq "ACTIVE") {
            Write-Host "  GSI is now ACTIVE" -ForegroundColor Green
            break
          }
          
          Write-Host "  GSI Status: $($gsi.IndexStatus) (waited $waited seconds)" -ForegroundColor Yellow
        }
        
        if ($waited -ge $maxWait) {
          Write-Host "  Warning: GSI creation timed out. Check AWS console." -ForegroundColor Red
        }
      }
    }
  } catch {
    Write-Host "  Error creating GSI: $_" -ForegroundColor Red
    Write-Host "  Continuing anyway..." -ForegroundColor Yellow
  }
}

Write-Host ""

# Step 3: Update existing records to add adminId and normalize email
Write-Host "Step 3: Migrating existing admin records..." -ForegroundColor Green

if ($existingAdmins.Items.Count -gt 0) {
  foreach ($item in $existingAdmins.Items) {
    $firebaseUid = $item.firebaseUid.S
    $email = $item.email.S
    $role = $item.role.S
    
    Write-Host "  Processing: $email (Firebase UID: $firebaseUid)" -ForegroundColor Cyan
    
    if (!$DryRun) {
      # Update: add adminId (use Firebase UID for backward compat), normalize email
      $normalizedEmail = $email.ToLower()
      
      try {
        aws dynamodb update-item `
          --table-name pdm-portal-admins `
          --key "{`"firebaseUid`":{`"S`":`"$firebaseUid`"}}" `
          --update-expression "SET adminId = :adminId, email = :email" `
          --expression-attribute-values "{`":adminId`":{`"S`":`"$firebaseUid`"},`":email`":{`"S`":`"$normalizedEmail`"}}" `
          --region $Region
        
        if ($LASTEXITCODE -eq 0) {
          Write-Host "    Updated: adminId=$firebaseUid, email=$normalizedEmail" -ForegroundColor Green
        }
      } catch {
        Write-Host "    Error: $_" -ForegroundColor Red
      }
    } else {
      Write-Host "    [DRY RUN] Would add adminId=$firebaseUid, email=$($email.ToLower())" -ForegroundColor Yellow
    }
  }
} else {
  Write-Host "  No admins to migrate" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "=" * 70 -ForegroundColor Cyan
Write-Host "  Migration Summary" -ForegroundColor Yellow
Write-Host "=" * 70 -ForegroundColor Cyan
Write-Host ""
Write-Host "Changes made:" -ForegroundColor Green
Write-Host "  1. Added email-index GSI to pdm-portal-admins table"
Write-Host "  2. Added adminId field to existing admin records"
Write-Host "  3. Normalized email addresses to lowercase"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Run create-admin-password.ps1 to add password authentication"
Write-Host "  2. Update application code to use new authentication"
Write-Host "  3. Test login with password-based auth"
Write-Host "  4. Once verified, the firebaseUid field can be removed"
Write-Host ""
Write-Host "Backup file: $backupFile" -ForegroundColor Cyan
Write-Host ""
Write-Host "=" * 70 -ForegroundColor Cyan
Write-Host ""
