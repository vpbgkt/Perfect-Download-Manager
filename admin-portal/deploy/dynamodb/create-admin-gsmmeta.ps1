# Create admin@example.invalid in pdm-portal-admins table
# 
# Prerequisites:
# 1. Create the Firebase user first in Firebase Console with email: admin@example.invalid
# 2. Copy the Firebase UID
# 3. Run: .\create-admin-gsmmeta.ps1 -FirebaseUid <uid>

param(
  [Parameter(Mandatory = $true)][string]$FirebaseUid,
  [string]$Email = "admin@example.invalid",
  [string]$Role = "super_admin",
  [string]$Region = "ap-south-1"
)

$ErrorActionPreference = "Stop"
$now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

Write-Host "Creating admin record for $Email with UID $FirebaseUid..."

$item = @{
  firebaseUid = @{ S = $FirebaseUid }
  email       = @{ S = $Email }
  role        = @{ S = $Role }
  mfaEnrolled = @{ BOOL = $false }
  createdAt   = @{ S = $now }
} | ConvertTo-Json -Compress -Depth 5

$tmp = New-TemporaryFile
Set-Content -LiteralPath $tmp.FullName -Value $item -NoNewline

try {
  aws dynamodb put-item `
    --table-name pdm-portal-admins `
    --item "file://$($tmp.FullName)" `
    --condition-expression "attribute_not_exists(firebaseUid)" `
    --region $Region
  
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Successfully created admin: $Email (UID: $FirebaseUid)" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:"
    Write-Host "  1. Login at your admin portal with $Email"
    Write-Host "  2. Complete OTP verification if enabled"
  } else {
    Write-Host "Failed to create admin (record may already exist)" -ForegroundColor Yellow
  }
} catch {
  Write-Host "Error: $_" -ForegroundColor Red
} finally {
  Remove-Item -LiteralPath $tmp.FullName -ErrorAction SilentlyContinue
}
