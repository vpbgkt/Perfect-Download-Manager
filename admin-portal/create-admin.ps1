# Create admin account with password
# Run from admin-portal directory: .\create-admin.ps1 -Email "admin@example.com" -Password "YourPassword"

param(
  [Parameter(Mandatory = $true)][string]$Email,
  [Parameter(Mandatory = $true)][string]$Password,
  [string]$Role = "super_admin",
  [string]$Region = "ap-south-1"
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=" * 70 -ForegroundColor Cyan
Write-Host "  Create Admin with Password Authentication" -ForegroundColor Yellow
Write-Host "=" * 70 -ForegroundColor Cyan
Write-Host ""

$normalizedEmail = $Email.ToLower()

Write-Host "Email: $normalizedEmail" -ForegroundColor Cyan
Write-Host "Role: $Role" -ForegroundColor Cyan
Write-Host ""

# Generate bcrypt hash using Node.js from current directory (admin-portal)
Write-Host "Generating password hash..." -ForegroundColor Yellow

$hashScript = @"
const bcrypt = require('bcryptjs');
const password = process.argv[2];
const hash = bcrypt.hashSync(password, 10);
console.log(hash);
"@

# Create temp file in current directory to avoid path issues
$tempScriptPath = "temp-hash-$(Get-Random).cjs"
Set-Content -Path $tempScriptPath -Value $hashScript

try {
  $passwordHash = (node $tempScriptPath $Password 2>&1 | Select-Object -Last 1).Trim()
  
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($passwordHash) -or -not $passwordHash.StartsWith('$2b$')) {
    throw "Failed to generate password hash. Output: $passwordHash"
  }
  
  Write-Host "Password hash generated successfully" -ForegroundColor Green
  Write-Host ""
} catch {
  Write-Host "Error: $_" -ForegroundColor Red
  Write-Host ""
  Write-Host "Make sure you're running from admin-portal directory and bcryptjs is installed:" -ForegroundColor Yellow
  Write-Host "  cd admin-portal" -ForegroundColor Cyan
  Write-Host "  npm install" -ForegroundColor Cyan
  exit 1
} finally {
  Remove-Item -Path $tempScriptPath -ErrorAction SilentlyContinue
}

# Check if admin already exists
Write-Host "Checking if admin exists..." -ForegroundColor Yellow

# Create JSON file for query
$queryValues = @{ ":email" = @{ S = $normalizedEmail } } | ConvertTo-Json -Compress -Depth 5
$queryFile = "temp-query-$(Get-Random).json"
Set-Content -Path $queryFile -Value $queryValues -NoNewline

try {
  $queryResult = aws dynamodb query `
    --table-name pdm-portal-admins `
    --index-name email-index `
    --key-condition-expression "email = :email" `
    --expression-attribute-values "file://$queryFile" `
    --region $Region `
    --output json 2>&1

  Remove-Item -Path $queryFile -ErrorAction SilentlyContinue

  if ($LASTEXITCODE -ne 0) {
    Write-Host "Error querying DynamoDB: $queryResult" -ForegroundColor Red
    Write-Host ""
    Write-Host "Make sure:" -ForegroundColor Yellow
    Write-Host "  1. AWS CLI is configured" -ForegroundColor Cyan
    Write-Host "  2. email-index GSI exists and is ACTIVE" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Check GSI status:" -ForegroundColor Yellow
    Write-Host "  aws dynamodb describe-table --table-name pdm-portal-admins --region $Region --query `"Table.GlobalSecondaryIndexes[?IndexName=='email-index'].IndexStatus`"" -ForegroundColor Cyan
    exit 1
  }

  $existingAdmin = $queryResult | ConvertFrom-Json
} catch {
  Write-Host "Error: $_" -ForegroundColor Red
  exit 1
}

if ($existingAdmin.Items.Count -gt 0) {
  Write-Host "Admin already exists. Updating password..." -ForegroundColor Yellow
  
  $existingItem = $existingAdmin.Items[0]
  
  # Determine the key to use
  if ($existingItem.PSObject.Properties.Name -contains "adminId") {
    $keyName = "adminId"
    $keyValue = $existingItem.adminId.S
  } else {
    $keyName = "firebaseUid"
    $keyValue = $existingItem.firebaseUid.S
  }
  
  # Update existing admin
  $updateKey = @{ $keyName = @{ S = $keyValue } } | ConvertTo-Json -Compress -Depth 5
  $updateFile = "temp-update-key-$(Get-Random).json"
  Set-Content -Path $updateFile -Value $updateKey -NoNewline
  
  $updateValues = @{
    ":hash" = @{ S = $passwordHash }
    ":role" = @{ S = $Role }
    ":email" = @{ S = $normalizedEmail }
  } | ConvertTo-Json -Compress -Depth 5
  $updateValuesFile = "temp-update-values-$(Get-Random).json"
  Set-Content -Path $updateValuesFile -Value $updateValues -NoNewline
  
  try {
    aws dynamodb update-item `
      --table-name pdm-portal-admins `
      --key "file://$updateFile" `
      --update-expression "SET passwordHash = :hash, #role = :role, email = :email" `
      --expression-attribute-names '{\"#role\":\"role\"}' `
      --expression-attribute-values "file://$updateValuesFile" `
      --region $Region
    
    if ($LASTEXITCODE -eq 0) {
      Write-Host ""
      Write-Host "SUCCESS! Admin password updated" -ForegroundColor Green
      $adminId = $keyValue
    } else {
      Write-Host ""
      Write-Host "FAILED to update admin" -ForegroundColor Red
      exit 1
    }
  } finally {
    Remove-Item -Path $updateFile -ErrorAction SilentlyContinue
    Remove-Item -Path $updateValuesFile -ErrorAction SilentlyContinue
  }
} else {
  Write-Host "Creating new admin..." -ForegroundColor Yellow
  
  # Generate IDs
  $adminId = "adm_$([guid]::NewGuid().ToString())"
  $firebaseUid = "legacy_$([guid]::NewGuid().ToString())"
  $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  
  # Create new admin with both adminId and firebaseUid (for backward compatibility)
  $item = @{
    firebaseUid  = @{ S = $firebaseUid }
    adminId      = @{ S = $adminId }
    email        = @{ S = $normalizedEmail }
    passwordHash = @{ S = $passwordHash }
    role         = @{ S = $Role }
    mfaEnrolled  = @{ BOOL = $false }
    createdAt    = @{ S = $now }
  } | ConvertTo-Json -Compress -Depth 5
  
  $tmp = "temp-item-$(Get-Random).json"
  Set-Content -Path $tmp -Value $item -NoNewline
  
  try {
    aws dynamodb put-item `
      --table-name pdm-portal-admins `
      --item "file://$tmp" `
      --region $Region
    
    if ($LASTEXITCODE -eq 0) {
      Write-Host ""
      Write-Host "SUCCESS! New admin created" -ForegroundColor Green
    } else {
      Write-Host ""
      Write-Host "FAILED to create admin" -ForegroundColor Red
      exit 1
    }
  } finally {
    Remove-Item -Path $tmp -ErrorAction SilentlyContinue
  }
}

Write-Host ""
Write-Host "=" * 70 -ForegroundColor Green
Write-Host "  Admin Account Ready" -ForegroundColor Yellow
Write-Host "=" * 70 -ForegroundColor Green
Write-Host ""
Write-Host "Email: $normalizedEmail" -ForegroundColor Cyan
Write-Host "Role: $Role" -ForegroundColor Cyan
Write-Host "Admin ID: $adminId" -ForegroundColor Cyan
Write-Host ""
Write-Host "You can now login at: http://localhost:3000/login" -ForegroundColor Green
Write-Host ""
Write-Host "=" * 70 -ForegroundColor Green
Write-Host ""
