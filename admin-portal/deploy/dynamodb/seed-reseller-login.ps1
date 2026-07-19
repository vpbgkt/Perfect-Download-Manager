# Maps a Firebase user to a RESELLER login so you can see the reseller view of
# the portal. Creates a pdm-portal-admins record with role "reseller" bound to a
# reseller account id. Idempotent (won't overwrite an existing record).
#
# 1) First create a reseller account in the dashboard (Resellers page) and copy
#    its account id, OR pass any id you created.
# 2) Create a second user in Firebase Authentication and copy its UID.
# 3) Run:
#    .\seed-reseller-login.ps1 -Uid <firebaseUid> -Email <email> -ResellerAccountId <res-...>

param(
  [Parameter(Mandatory = $true)][string]$Uid,
  [Parameter(Mandatory = $true)][string]$Email,
  [Parameter(Mandatory = $true)][string]$ResellerAccountId,
  [string]$Region = "ap-south-1"
)

$ErrorActionPreference = "Stop"
$now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")

$item = @{
  firebaseUid       = @{ S = $Uid }
  email             = @{ S = $Email }
  role              = @{ S = "reseller" }
  resellerAccountId = @{ S = $ResellerAccountId }
  mfaEnrolled       = @{ BOOL = $false }
  createdAt         = @{ S = $now }
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
    Write-Host "Seeded reseller login $Email -> account $ResellerAccountId (UID $Uid)"
  } else {
    Write-Host "Record already exists (or put failed) - no change."
  }
} finally {
  Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue
}
