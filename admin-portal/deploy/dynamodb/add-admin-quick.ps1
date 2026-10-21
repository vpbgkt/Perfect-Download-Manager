# Quick script to add admin@example.invalid to pdm-portal-admins
# You need to provide the Firebase UID from Firebase Console

param(
  [Parameter(Mandatory = $true)][string]$AdminEmail,
  [Parameter(Mandatory = $false)][string]$FirebaseUid,
  [string]$Region = "ap-south-1"
)

$ErrorActionPreference = "Stop"

# If no UID provided, show instructions
if ([string]::IsNullOrWhiteSpace($FirebaseUid)) {
  Write-Host "=" * 70 -ForegroundColor Cyan
  Write-Host "  Firebase UID Required" -ForegroundColor Yellow
  Write-Host "=" * 70 -ForegroundColor Cyan
  Write-Host ""
  Write-Host "Provide the admin email and Firebase UID to create an admin record."
  Write-Host ""
  Write-Host "Steps:" -ForegroundColor Green
  Write-Host "  1. Go to: https://console.firebase.google.com"
  Write-Host "  2. Select project: perfect-download-manager"
  Write-Host "  3. Navigate to: Authentication → Users"
  Write-Host "  4. Find the intended admin user"
  Write-Host "  5. Copy the user's Firebase UID"
  Write-Host ""
  Write-Host "Then run:" -ForegroundColor Green
  Write-Host "  .\add-admin-quick.ps1 -AdminEmail ""ADMIN_EMAIL"" -FirebaseUid ""FIREBASE_UID"""
  Write-Host ""
  Write-Host "=" * 70 -ForegroundColor Cyan
  exit 0
}

Write-Host ""
Write-Host "Adding $AdminEmail to pdm-portal-admins..." -ForegroundColor Cyan
Write-Host "Firebase UID: $FirebaseUid"
Write-Host ""

$now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

$item = @{
  firebaseUid = @{ S = $FirebaseUid }
  email       = @{ S = $AdminEmail.ToLowerInvariant() }
  role        = @{ S = "super_admin" }
  mfaEnrolled = @{ BOOL = $false }
  createdAt   = @{ S = $now }
} | ConvertTo-Json -Compress -Depth 5

$tmp = New-TemporaryFile
Set-Content -LiteralPath $tmp.FullName -Value $item -NoNewline

try {
  Write-Host "Inserting record into DynamoDB..." -ForegroundColor Yellow
  
  aws dynamodb put-item `
    --table-name pdm-portal-admins `
    --item "file://$($tmp.FullName)" `
    --condition-expression "attribute_not_exists(firebaseUid)" `
    --region $Region
  
  if ($LASTEXITCODE -eq 0) {
    Write-Host ""
    Write-Host "SUCCESS!" -ForegroundColor Green
    Write-Host "=" * 70 -ForegroundColor Green
    Write-Host ""
    Write-Host "Admin account created:" -ForegroundColor Green
    Write-Host "  Email: $AdminEmail"
    Write-Host "  Role: super_admin"
    Write-Host "  Firebase UID: $FirebaseUid"
    Write-Host ""
    Write-Host "You can now login at: http://localhost:3000/login" -ForegroundColor Cyan
    Write-Host "  Set a unique password using the authorized account provisioning flow."
    Write-Host ""
    Write-Host "=" * 70 -ForegroundColor Green
  } else {
    Write-Host ""
    Write-Host "FAILED!" -ForegroundColor Red
    Write-Host "This usually means:"
    Write-Host "  - The UID already exists in the table"
    Write-Host "  - Network/AWS credentials issue"
    Write-Host ""
    Write-Host "Run this to check existing admins:"
    Write-Host "  aws dynamodb scan --table-name pdm-portal-admins --region $Region"
  }
} catch {
  Write-Host ""
  Write-Host "ERROR: $_" -ForegroundColor Red
} finally {
  Remove-Item -LiteralPath $tmp.FullName -ErrorAction SilentlyContinue
}

Write-Host ""
