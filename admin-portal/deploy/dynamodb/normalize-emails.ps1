# Normalize all contactEmail values to lowercase in pdm-portal-resellers table
# This ensures case-insensitive email matching for authentication

param(
  [string]$Region = "ap-south-1"
)

$ErrorActionPreference = "Stop"

Write-Host "Scanning pdm-portal-resellers table for email normalization..."

$scanResult = aws dynamodb scan `
  --table-name pdm-portal-resellers `
  --region $Region `
  --output json | ConvertFrom-Json

$updatedCount = 0
$skippedCount = 0

foreach ($item in $scanResult.Items) {
  $accountId = $item.resellerAccountId.S
  $email = $item.contactEmail.S
  $emailLower = $email.ToLower()

  if ($email -cne $emailLower) {
    Write-Host "Updating $accountId : $email -> $emailLower"
    
    # Create temporary files for JSON parameters (avoids PowerShell quote escaping issues)
    $keyFile = New-TemporaryFile
    $valuesFile = New-TemporaryFile
    
    try {
      $keyJson = @{
        resellerAccountId = @{ S = $accountId }
      } | ConvertTo-Json -Compress
      
      $valuesJson = @{
        ":email" = @{ S = $emailLower }
      } | ConvertTo-Json -Compress
      
      Set-Content -Path $keyFile.FullName -Value $keyJson -NoNewline
      Set-Content -Path $valuesFile.FullName -Value $valuesJson -NoNewline
      
      aws dynamodb update-item `
        --table-name pdm-portal-resellers `
        --key "file://$($keyFile.FullName)" `
        --update-expression "SET contactEmail = :email" `
        --expression-attribute-values "file://$($valuesFile.FullName)" `
        --region $Region
      
      if ($LASTEXITCODE -eq 0) {
        $updatedCount++
        Write-Host "  Updated successfully" -ForegroundColor Green
      } else {
        Write-Host "  Update failed" -ForegroundColor Red
      }
    } finally {
      Remove-Item -Path $keyFile.FullName -ErrorAction SilentlyContinue
      Remove-Item -Path $valuesFile.FullName -ErrorAction SilentlyContinue
    }
  } else {
    Write-Host "Skipping $accountId : $email (already lowercase)"
    $skippedCount++
  }
}

Write-Host ""
Write-Host "Migration complete:"
Write-Host "  Updated: $updatedCount"
Write-Host "  Skipped: $skippedCount"
