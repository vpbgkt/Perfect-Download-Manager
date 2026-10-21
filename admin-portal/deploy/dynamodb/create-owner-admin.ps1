# Quick script to create owner@example.invalid admin account
# This is the primary admin for the PDM Portal

param(
  [Parameter(Mandatory = $false)][string]$Password,
  [string]$Region = "ap-south-1"
)

$ErrorActionPreference = "Stop"

$email = "owner@example.invalid"

Write-Host ""
Write-Host "=" * 70 -ForegroundColor Cyan
Write-Host "  Create Owner Admin Account" -ForegroundColor Yellow
Write-Host "=" * 70 -ForegroundColor Cyan
Write-Host ""

# Prompt for password if not provided
if ([string]::IsNullOrWhiteSpace($Password)) {
  Write-Host "Enter password for $email" -ForegroundColor Yellow
  $securePassword = Read-Host -AsSecureString
  $BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  $Password = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)
  Write-Host ""
}

# Validate password strength
if ($Password.Length -lt 8) {
  Write-Host "ERROR: Password must be at least 8 characters long" -ForegroundColor Red
  exit 1
}

Write-Host "Creating admin account for: $email" -ForegroundColor Cyan
Write-Host "Role: super_admin" -ForegroundColor Cyan
Write-Host ""

# Call the main create script
$scriptPath = Join-Path $PSScriptRoot "create-admin-password.ps1"

try {
  & $scriptPath -Email $email -Password $Password -Role "super_admin" -Region $Region
  
  if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "=" * 70 -ForegroundColor Green
    Write-Host "  Owner Admin Created Successfully!" -ForegroundColor Yellow
    Write-Host "=" * 70 -ForegroundColor Green
    Write-Host ""
    Write-Host "Login credentials:" -ForegroundColor Cyan
    Write-Host "  URL: http://localhost:3000/login" -ForegroundColor White
    Write-Host "  Email: $email" -ForegroundColor White
    Write-Host "  Password: (the password you just entered)" -ForegroundColor White
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "  1. Start the dev server: npm run dev" -ForegroundColor White
    Write-Host "  2. Navigate to login page" -ForegroundColor White
    Write-Host "  3. Login with the credentials above" -ForegroundColor White
    Write-Host ""
    Write-Host "=" * 70 -ForegroundColor Green
    Write-Host ""
  }
} catch {
  Write-Host ""
  Write-Host "ERROR: Failed to create admin account" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  Write-Host ""
  exit 1
}
