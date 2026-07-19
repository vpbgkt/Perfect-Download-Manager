# Seeds a super_admin into pdm-portal-admins. Idempotent: won't overwrite an
# existing record (conditional on firebaseUid not already present).
#
# Usage:
#   .\seed-admin.ps1 -Uid <firebaseUid> -Email <email> [-Role super_admin] [-Region ap-south-1]

param(
  [Parameter(Mandatory = $true)][string]$Uid,
  [Parameter(Mandatory = $true)][string]$Email,
  [string]$Role = "super_admin",
  [string]$Region = "ap-south-1"
)

$ErrorActionPreference = "Stop"
$now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

$item = @{
  firebaseUid = @{ S = $Uid }
  email       = @{ S = $Email }
  role        = @{ S = $Role }
  mfaEnrolled = @{ BOOL = $false }
  createdAt   = @{ S = $now }
} | ConvertTo-Json -Compress -Depth 5

$tmp = New-TemporaryFile
Set-Content -LiteralPath $tmp -Value $item -NoNewline

try {
  aws dynamodb put-item `
    --table-name pdm-portal-admins `
    --item "file://$tmp" `
    --condition-expression "attribute_not_exists(firebaseUid)" `
    --region $Region
  if ($LASTEXITCODE -eq 0) {
    Write-Host "Seeded admin $Email ($Role) with UID $Uid"
  } else {
    Write-Host "Admin already exists (or put failed) - no change."
  }
} finally {
  Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
}
