# Setup Dhru API Infrastructure
# This script:
# 1. Adds dhruApiUsername GSI to pdm-portal-resellers table
# 2. Creates pdm-dhru-orders table
# 3. Verifies the setup

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Dhru API Infrastructure Setup" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

$ErrorActionPreference = "Stop"

# Check if AWS CLI is available
try {
    aws --version | Out-Null
} catch {
    Write-Host "ERROR: AWS CLI not found. Please install AWS CLI first." -ForegroundColor Red
    exit 1
}

Write-Host "[1/4] Checking existing infrastructure..." -ForegroundColor Yellow

# Check if resellers table exists
$resellerTableExists = $false
try {
    aws dynamodb describe-table --table-name pdm-portal-resellers --output json 2>&1 | Out-Null
    $resellerTableExists = $true
    Write-Host "✓ pdm-portal-resellers table exists" -ForegroundColor Green
} catch {
    Write-Host "✗ pdm-portal-resellers table not found" -ForegroundColor Red
    Write-Host "  Please create the table first using create-tables.ps1" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "[2/4] Adding dhruApiUsername GSI to resellers table..." -ForegroundColor Yellow

# Check if GSI already exists
$gsiExists = $false
try {
    $tableInfo = aws dynamodb describe-table --table-name pdm-portal-resellers --output json | ConvertFrom-Json
    foreach ($gsi in $tableInfo.Table.GlobalSecondaryIndexes) {
        if ($gsi.IndexName -eq "dhruApiUsername-index") {
            $gsiExists = $true
            break
        }
    }
} catch {
    Write-Host "✗ Error checking GSI status" -ForegroundColor Red
}

if ($gsiExists) {
    Write-Host "✓ dhruApiUsername-index already exists" -ForegroundColor Green
} else {
    Write-Host "  Creating dhruApiUsername-index..." -ForegroundColor Cyan
    
    try {
        aws dynamodb update-table `
            --table-name pdm-portal-resellers `
            --attribute-definitions AttributeName=dhruApiUsername,AttributeType=S `
            --global-secondary-index-updates '[
                {
                    "Create": {
                        "IndexName": "dhruApiUsername-index",
                        "KeySchema": [
                            {"AttributeName": "dhruApiUsername", "KeyType": "HASH"}
                        ],
                        "Projection": {"ProjectionType": "ALL"}
                    }
                }
            ]' --output json | Out-Null
        
        Write-Host "✓ GSI creation initiated (may take a few minutes to build)" -ForegroundColor Green
        
        # Wait for GSI to become active
        Write-Host "  Waiting for GSI to become active..." -ForegroundColor Cyan
        $maxWaitSeconds = 300
        $waitedSeconds = 0
        
        while ($waitedSeconds -lt $maxWaitSeconds) {
            Start-Sleep -Seconds 5
            $waitedSeconds += 5
            
            $tableInfo = aws dynamodb describe-table --table-name pdm-portal-resellers --output json | ConvertFrom-Json
            $gsiStatus = $null
            
            foreach ($gsi in $tableInfo.Table.GlobalSecondaryIndexes) {
                if ($gsi.IndexName -eq "dhruApiUsername-index") {
                    $gsiStatus = $gsi.IndexStatus
                    break
                }
            }
            
            if ($gsiStatus -eq "ACTIVE") {
                Write-Host "✓ GSI is now active" -ForegroundColor Green
                break
            }
            
            Write-Host "  Status: $gsiStatus (waited ${waitedSeconds}s)" -ForegroundColor Gray
        }
        
        if ($waitedSeconds -ge $maxWaitSeconds) {
            Write-Host "⚠ Timeout waiting for GSI. Check AWS console for status." -ForegroundColor Yellow
        }
        
    } catch {
        Write-Host "✗ Error creating GSI: $_" -ForegroundColor Red
        Write-Host "  You may need to add this manually in AWS console" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "[3/4] Creating pdm-dhru-orders table..." -ForegroundColor Yellow

# Check if orders table exists
$ordersTableExists = $false
try {
    aws dynamodb describe-table --table-name pdm-dhru-orders --output json 2>&1 | Out-Null
    $ordersTableExists = $true
    Write-Host "✓ pdm-dhru-orders table already exists" -ForegroundColor Green
} catch {
    Write-Host "  Creating pdm-dhru-orders table..." -ForegroundColor Cyan
    
    try {
        aws dynamodb create-table --cli-input-json file://pdm-dhru-orders.json --output json | Out-Null
        Write-Host "✓ Table created successfully" -ForegroundColor Green
        
        # Wait for table to become active
        Write-Host "  Waiting for table to become active..." -ForegroundColor Cyan
        aws dynamodb wait table-exists --table-name pdm-dhru-orders
        Write-Host "✓ Table is now active" -ForegroundColor Green
        
    } catch {
        Write-Host "✗ Error creating table: $_" -ForegroundColor Red
        Write-Host "  You may need to create this manually using pdm-dhru-orders.json" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "[4/4] Verifying setup..." -ForegroundColor Yellow

# Verify resellers table
try {
    $tableInfo = aws dynamodb describe-table --table-name pdm-portal-resellers --output json | ConvertFrom-Json
    $gsiCount = $tableInfo.Table.GlobalSecondaryIndexes.Count
    $hasDhruGsi = $false
    
    foreach ($gsi in $tableInfo.Table.GlobalSecondaryIndexes) {
        if ($gsi.IndexName -eq "dhruApiUsername-index") {
            $hasDhruGsi = $true
            break
        }
    }
    
    if ($hasDhruGsi) {
        Write-Host "✓ pdm-portal-resellers has dhruApiUsername-index" -ForegroundColor Green
    } else {
        Write-Host "✗ dhruApiUsername-index not found on pdm-portal-resellers" -ForegroundColor Red
    }
} catch {
    Write-Host "✗ Could not verify resellers table" -ForegroundColor Red
}

# Verify orders table
try {
    $tableInfo = aws dynamodb describe-table --table-name pdm-dhru-orders --output json | ConvertFrom-Json
    Write-Host "✓ pdm-dhru-orders table is ready" -ForegroundColor Green
} catch {
    Write-Host "✗ pdm-dhru-orders table not found" -ForegroundColor Red
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Setup Complete!" -ForegroundColor Green
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Generate Dhru API credentials at /dashboard/api-keys" -ForegroundColor White
Write-Host "2. Test the API endpoint at /api/dhru/index.php" -ForegroundColor White
Write-Host "3. Configure Dhru panel with credentials" -ForegroundColor White
Write-Host ""
