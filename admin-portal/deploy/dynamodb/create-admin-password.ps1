# Create or update admin account with password authentication
# Usage: .\create-admin-password.ps1 -Email "owner@example.invalid" -Password "YourSecurePassword123!"

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

# Generate bcrypt hash using Node.js
Write-Host "Generating password hash..." -ForegroundColor Yellow

# Get the admin-portal root directory (2 levels up from this script)
$scriptDir = $PSScriptRoot
$deployDir = Split-Path -Parent $scriptDir
$adminPortalRoot = Split-Path -Parent $deployDir

$hashScript = @"
const bcrypt = require('bcryptjs');
const password = process.argv[2];
const hash = bcrypt.hashSync(password, 10);
console.log(hash);
"@

$tempScript = New-TemporaryFile
$tempScript = "$($tempScript.FullName).js"
Set-Content -Path $tempScript -Value $hashScript

try {
  Push-Location $adminPortalRoot
  $passwordHash = node $tempScript $Password
  Pop-Location
  
  if ([string]::IsNullOrWhiteSpace($passwordHash)) {
    throw "Failed to generate password hash"
  }
  
  Write-Host "Password hash generated successfully" -ForegroundColor Green
  Write-Host ""
} catch {
  Write-Host "Error generating password hash: $_" -ForegroundColor Red
  Write-Host ""
  Write-Host "Make sure Node.js and bcryptjs are installed:" -ForegroundColor Yellow
  Write-Host "  npm install" -ForegroundColor Cyan
  exit 1
} finally {
  Remove-Item -Path $tempScript -ErrorAction SilentlyContinue
}

# Check if admin already exists
Write-Host "Checking if admin exists..." -ForegroundColor Yellow

$existingAdmin = aws dynamodb query `
  --table-name pdm-portal-admins `
  --index-name email-index `
  --key-condition-expression "email = :email" `
  --expression-attribute-values "{`":email`":{`"S`":`"$normalizedEmail`"}}" `
  --region $Region `
  --output json | ConvertFrom-Json

if ($existingAdmin.Items.Count -gt 0) {
  Write-Host "Admin already exists. Updating password..." -ForegroundColor Yellow
  
  $adminId = $existingAdmin.Items[0].adminId.S
  
  # Update existing admin
  aws dynamodb update-item `
    --table-name pdm-portal-admins `
    --key "{`"adminId`":{`"S`":`"$adminId`"}}" `
    --update-expression "SET passwordHash = :hash, #role = :role, email = :email" `
    --expression-attribute-names "{`"#role`":`"role`"}" `
    --expression-attribute-values "{`":hash`":{`"S`":`"$passwordHash`"},`":role`":{`"S`":`"$Role`"},`":email`":{`"S`":`"$normalizedEmail`"}}" `
    --region $Region
  
  if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "SUCCESS! Admin password updated" -ForegroundColor Green
  } else {
    Write-Host ""
    Write-Host "FAILED to update admin" -ForegroundColor Red
    exit 1
  }
} else {
  Write-Host "Creating new admin..." -ForegroundColor Yellow
  
  # Generate new admin ID
  $adminId = "adm_$(New-Guid)"
  $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  
  # Create new admin
  $item = @{
    adminId      = @{ S = $adminId }
    email        = @{ S = $normalizedEmail }
    passwordHash = @{ S = $passwordHash }
    role         = @{ S = $Role }
    mfaEnrolled  = @{ BOOL = $false }
    createdAt    = @{ S = $now }
  } | ConvertTo-Json -Compress -Depth 5
  
  $tmp = New-TemporaryFile
  Set-Content -Path $tmp.FullName -Value $item -NoNewline
  
  try {
    aws dynamodb put-item `
      --table-name pdm-portal-admins `
      --item "file://$($tmp.FullName)" `
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
    Remove-Item -Path $tmp.FullName -ErrorAction SilentlyContinue
  }
}

Write-Host ""
Write-Host "=" * 70 -ForegroundColor Green
Write-Host "  Admin Account Ready" -ForegroundColor Yellow
Write-Host "=" * 70 -ForegroundColor Green
Write-Host ""
Write-Host "Email: $normalizedEmail" -ForegroundColor Cyan
Write-Host "Role: $Role" -ForegroundColor Cyan
Write-Host ""
Write-Host "You can now login at: http://localhost:3000/login" -ForegroundColor Green
Write-Host ""
Write-Host "=" * 70 -ForegroundColor Green
Write-Host ""
