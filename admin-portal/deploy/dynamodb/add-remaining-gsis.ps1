# Add Remaining GSIs for Phase 1 & 2
# Run this after accountType-index is ACTIVE
# AWS allows only 1 GSI creation at a time

param([string]$Region = "ap-south-1")

# Create temp files for JSON
$tempDir = [System.IO.Path]::GetTempPath()
$gsi1File = Join-Path $tempDir "gsi1.json"
$gsi2File = Join-Path $tempDir "gsi2.json"

Write-Host "Adding parentAccountId-index..." -ForegroundColor Yellow
$json1 = '[{"Create":{"IndexName":"parentAccountId-index","KeySchema":[{"AttributeName":"parentAccountId","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}}}]'
[System.IO.File]::WriteAllText($gsi1File, $json1, [System.Text.UTF8Encoding]::new($false))

aws dynamodb update-table --table-name pdm-portal-resellers --attribute-definitions AttributeName=parentAccountId,AttributeType=S --global-secondary-index-updates file://$gsi1File --region $Region

if ($LASTEXITCODE -eq 0) {
    Write-Host "Waiting for parentAccountId-index to become ACTIVE..." -ForegroundColor Gray
    do {
        Start-Sleep -Seconds 5
        $status = aws dynamodb describe-table --table-name pdm-portal-resellers --region $Region --query "Table.GlobalSecondaryIndexes[?IndexName=='parentAccountId-index'].IndexStatus" --output text
        Write-Host "  Status: $status" -ForegroundColor Gray
    } while ($status -eq "CREATING")
    Write-Host "parentAccountId-index is ACTIVE" -ForegroundColor Green
} else {
    Write-Host "Failed to create parentAccountId-index. Check if it already exists or if accountType-index is still creating." -ForegroundColor Red
    Remove-Item $gsi1File -ErrorAction SilentlyContinue
    Remove-Item $gsi2File -ErrorAction SilentlyContinue
    exit 1
}

Write-Host ""
Write-Host "Adding contactEmail-index..." -ForegroundColor Yellow
$json2 = '[{"Create":{"IndexName":"contactEmail-index","KeySchema":[{"AttributeName":"contactEmail","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}}}]'
[System.IO.File]::WriteAllText($gsi2File, $json2, [System.Text.UTF8Encoding]::new($false))

aws dynamodb update-table --table-name pdm-portal-resellers --attribute-definitions AttributeName=contactEmail,AttributeType=S --global-secondary-index-updates file://$gsi2File --region $Region

if ($LASTEXITCODE -eq 0) {
    Write-Host "Waiting for contactEmail-index to become ACTIVE..." -ForegroundColor Gray
    do {
        Start-Sleep -Seconds 5
        $status = aws dynamodb describe-table --table-name pdm-portal-resellers --region $Region --query "Table.GlobalSecondaryIndexes[?IndexName=='contactEmail-index'].IndexStatus" --output text
        Write-Host "  Status: $status" -ForegroundColor Gray
    } while ($status -eq "CREATING")
    Write-Host "contactEmail-index is ACTIVE" -ForegroundColor Green
} else {
    Write-Host "Failed to create contactEmail-index" -ForegroundColor Red
    Remove-Item $gsi1File -ErrorAction SilentlyContinue
    Remove-Item $gsi2File -ErrorAction SilentlyContinue
    exit 1
}

# Clean up temp files
Remove-Item $gsi1File -ErrorAction SilentlyContinue
Remove-Item $gsi2File -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "All GSIs created successfully!" -ForegroundColor Green
