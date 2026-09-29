# Dhru API Testing Script
# Tests all Dhru API endpoints with actual credentials

param(
    [Parameter(Mandatory=$false)]
    [string]$BaseUrl = "http://localhost:3000",
    
    [Parameter(Mandatory=$true)]
    [string]$Username,
    
    [Parameter(Mandatory=$true)]
    [string]$ApiKey
)

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Dhru API Testing Suite" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Endpoint: $BaseUrl/api/dhru/index.php" -ForegroundColor White
Write-Host "Username: $Username" -ForegroundColor White
Write-Host "API Key:  $ApiKey" -ForegroundColor White
Write-Host ""

$endpoint = "$BaseUrl/api/dhru/index.php"
$testsPassed = 0
$testsFailed = 0

function Test-DhruAction {
    param(
        [string]$ActionName,
        [string]$Action,
        [hashtable]$Parameters = @{}
    )
    
    Write-Host "[TEST] $ActionName" -ForegroundColor Yellow
    Write-Host "Action: $Action" -ForegroundColor Gray
    
    $body = @{
        username = $Username
        apiaccesskey = $ApiKey
        action = $Action
        requestformat = "JSON"
    }
    
    if ($Parameters.Count -gt 0) {
        $body.parameters = ($Parameters | ConvertTo-Json -Compress)
        Write-Host "Parameters: $($body.parameters)" -ForegroundColor Gray
    }
    
    try {
        $response = Invoke-RestMethod -Uri $endpoint -Method POST -Body $body -ContentType "application/x-www-form-urlencoded"
        
        if ($response.STATUS -eq "SUCCESS") {
            Write-Host "✓ SUCCESS" -ForegroundColor Green
            $script:testsPassed++
            
            # Display relevant data
            if ($response.BALANCE) {
                Write-Host "  Balance: $($response.BALANCE) credits" -ForegroundColor Cyan
            }
            if ($response.SERVICES) {
                Write-Host "  Services: $($response.SERVICES.Count)" -ForegroundColor Cyan
            }
            if ($response.ORDERID) {
                Write-Host "  Order ID: $($response.ORDERID)" -ForegroundColor Cyan
            }
            if ($response.CODE) {
                Write-Host "  License Key: $($response.CODE)" -ForegroundColor Cyan
            }
            
            return $response
        } else {
            Write-Host "✗ ERROR: $($response.ERROR)" -ForegroundColor Red
            Write-Host "  Message: $($response.MESSAGE)" -ForegroundColor Red
            $script:testsFailed++
            return $null
        }
    } catch {
        Write-Host "✗ REQUEST FAILED: $_" -ForegroundColor Red
        $script:testsFailed++
        return $null
    }
    finally {
        Write-Host ""
    }
}

# Test 1: Account Info
Write-Host "[1/5] Testing Account Info..." -ForegroundColor Magenta
$accountInfo = Test-DhruAction -ActionName "Get Account Balance" -Action "accountinfo"

# Test 2: Service List
Write-Host "[2/5] Testing Service List..." -ForegroundColor Magenta
$services = Test-DhruAction -ActionName "Get Available Services" -Action "imeiservicelist"

if ($services -and $services.SERVICES) {
    Write-Host "Available Services:" -ForegroundColor Cyan
    foreach ($service in $services.SERVICES) {
        Write-Host "  - $($service.SERVICEID): $($service.SERVICENAME) ($($service.CREDIT) credits)" -ForegroundColor White
    }
    Write-Host ""
}

# Test 3: Place Order (if balance is sufficient)
Write-Host "[3/5] Testing Order Placement..." -ForegroundColor Magenta

if ($accountInfo -and [int]$accountInfo.CREDITS -ge 1) {
    Write-Host "Sufficient balance detected. Placing test order..." -ForegroundColor Cyan
    
    $orderParams = @{
        ID = "PDM3M"
        IMEI = "testuser@example.com"
    }
    
    $orderResponse = Test-DhruAction `
        -ActionName "Place Order (3 Month License)" `
        -Action "placeimeiorder" `
        -Parameters $orderParams
    
    if ($orderResponse -and $orderResponse.ORDERID) {
        $testOrderId = $orderResponse.REFERENCEID  # Use REFERENCEID (Dhru standard)
        
        # Test 4a: Order Details with 'getimeiorder' (Dhru standard)
        Write-Host "[4a/5] Testing Order Details (Dhru standard: getimeiorder)..." -ForegroundColor Magenta
        
        $detailsParams = @{
            ID = $testOrderId  # Dhru uses 'ID' parameter
        }
        
        $details = Test-DhruAction `
            -ActionName "Get Order Details (getimeiorder)" `
            -Action "getimeiorder" `
            -Parameters $detailsParams
        
        # Test 4b: Order Details with 'imeiorderdetails' (our alias)
        Write-Host "[4b/5] Testing Order Details (alternative: imeiorderdetails)..." -ForegroundColor Magenta
        
        $detailsParams2 = @{
            ORDERID = $testOrderId
        }
        
        $details2 = Test-DhruAction `
            -ActionName "Get Order Details (imeiorderdetails)" `
            -Action "imeiorderdetails" `
            -Parameters $detailsParams2
    } else {
        Write-Host "[4a/5] Skipping Order Details test (no order created)" -ForegroundColor Yellow
        Write-Host "[4b/5] Skipping Order Details test (no order created)" -ForegroundColor Yellow
        Write-Host ""
        $script:testsFailed += 2
    }
} else {
    Write-Host "⚠ Insufficient balance for test order" -ForegroundColor Yellow
    Write-Host "  Current balance: $($accountInfo.CREDITS) credits" -ForegroundColor Yellow
    Write-Host "  Required: 1 credit" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "[3/5] Skipping Order Placement test" -ForegroundColor Yellow
    Write-Host "[4a/5] Skipping Order Details test" -ForegroundColor Yellow
    Write-Host "[4b/5] Skipping Order Details test" -ForegroundColor Yellow
    Write-Host ""
    $script:testsFailed += 3
}

# Summary
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Test Results" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Passed: $testsPassed" -ForegroundColor Green
Write-Host "Failed: $testsFailed" -ForegroundColor Red
Write-Host ""

if ($testsFailed -eq 0) {
    Write-Host "✓ All tests passed!" -ForegroundColor Green
    exit 0
} else {
    Write-Host "✗ Some tests failed" -ForegroundColor Red
    exit 1
}
