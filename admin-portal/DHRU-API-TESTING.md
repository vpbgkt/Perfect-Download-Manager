# Dhru API Testing Guide

## Prerequisites

Before testing, ensure the following are set up:

### 1. DynamoDB Tables

#### Create pdm-dhru-orders table:
```bash
aws dynamodb create-table --cli-input-json file://deploy/dynamodb/pdm-dhru-orders.json --region ap-south-1
```

#### Add GSI to pdm-portal-resellers table:
```bash
aws dynamodb update-table \
  --table-name pdm-portal-resellers \
  --attribute-definitions AttributeName=dhruApiUsername,AttributeType=S \
  --global-secondary-index-updates '[{
    "Create": {
      "IndexName": "dhruApiUsername-index",
      "KeySchema": [{"AttributeName": "dhruApiUsername", "KeyType": "HASH"}],
      "Projection": {"ProjectionType": "ALL"}
    }
  }]' \
  --region ap-south-1
```

### 2. Test Reseller Account

Ensure you have a reseller account with:
- Active state
- Sufficient balance (at least 10 credits for testing)
- Account ID noted (e.g., `acc_xxxxx`)

## Testing Flow

### Step 1: Generate Dhru API Credentials

#### Via Admin UI:
1. Navigate to `http://localhost:3000/dashboard/api-keys`
2. Scroll to "Dhru API Integration" section
3. Enter reseller account ID: `acc_xxxxx`
4. Click "Generate Credentials"
5. Note the credentials:
   - Username: `reseller_abc123`
   - API Key: `XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX`
   - Endpoint: `http://localhost:3000/api/dhru/index.php`

#### Via API (Alternative):
```bash
curl -X POST http://localhost:3000/api/resellers/acc_xxxxx/dhru-api-key \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json"
```

### Step 2: Test Account Info

Verify credentials and check balance:

```bash
curl -X POST http://localhost:3000/api/dhru/index.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=reseller_abc123" \
  -d "apiaccesskey=XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX" \
  -d "action=accountinfo" \
  -d "requestformat=JSON"
```

**Expected Response:**
```json
{
  "STATUS": "SUCCESS",
  "USERNAME": "reseller_abc123",
  "BALANCE": "100.00",
  "CREDITS": "100",
  "CURRENCY": "USD",
  "ACCOUNT_TYPE": "RESELLER",
  "STATUS": "ACTIVE",
  "EMAIL": "reseller@example.com",
  "ORGANIZATION": "Reseller Company"
}
```

**Verification:**
- ✅ STATUS should be "SUCCESS"
- ✅ BALANCE should match reseller's current balance
- ✅ STATUS should be "ACTIVE"

### Step 3: Test Service List

Get available PDM services:

```bash
curl -X POST http://localhost:3000/api/dhru/index.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=reseller_abc123" \
  -d "apiaccesskey=XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX" \
  -d "action=imeiservicelist" \
  -d "requestformat=JSON"
```

**Expected Response:**
```json
{
  "STATUS": "SUCCESS",
  "SERVICES": [
    {
      "SERVICEID": "PDM3M",
      "SERVICENAME": "PDM 3 Months License",
      "CREDIT": "1",
      "TIME": "Instant",
      "INFO": "Perfect Download Manager - 3 Months License Key",
      "REQUIREINFORMATION": "USERNAME,EMAIL"
    },
    {
      "SERVICEID": "PDM6M",
      "SERVICENAME": "PDM 6 Months License",
      "CREDIT": "2",
      "TIME": "Instant",
      "INFO": "Perfect Download Manager - 6 Months License Key",
      "REQUIREINFORMATION": "USERNAME,EMAIL"
    },
    {
      "SERVICEID": "PDM12M",
      "SERVICENAME": "PDM 12 Months License",
      "CREDIT": "3",
      "TIME": "Instant",
      "INFO": "Perfect Download Manager - 1 Year License Key",
      "REQUIREINFORMATION": "USERNAME,EMAIL"
    }
  ],
  "TOTAL": 3
}
```

**Verification:**
- ✅ Should return 3 services
- ✅ Service IDs should be PDM3M, PDM6M, PDM12M
- ✅ Credits should be 1, 2, 3 respectively

### Step 4: Test Place Order (3 Month License)

Purchase a 3-month PDM license:

```bash
curl -X POST http://localhost:3000/api/dhru/index.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=reseller_abc123" \
  -d "apiaccesskey=XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX" \
  -d "action=placeimeiorder" \
  -d "requestformat=JSON" \
  -d 'parameters={"ID":"PDM3M","IMEI":"testuser|test@example.com"}'
```

**Expected Response:**
```json
{
  "STATUS": "SUCCESS",
  "ORDERID": "DH1727434200ABC",
  "STATUS": "COMPLETED",
  "SERVICEID": "PDM3M",
  "SERVICENAME": "PDM 3 Months License",
  "COST": "1",
  "CODE": "PDM-A1B2-C3D4-E5F6-G7H8",
  "COMMENT": "Your PDM license key is ready. Download: https://perfectdownloadmanager.com/download",
  "MESSAGE": "License generated successfully",
  "TIME": "Instant",
  "IMEI": "testuser|test@example.com",
  "USERNAME": "testuser",
  "EMAIL": "test@example.com",
  "EXPIRES": "2026-12-27T10:30:00.000Z"
}
```

**Verification:**
- ✅ STATUS should be "SUCCESS"
- ✅ ORDERID should be returned (format: DH + timestamp + random)
- ✅ CODE should contain valid license key (format: PDM-XXXX-XXXX-XXXX-XXXX)
- ✅ EXPIRES should be ~3 months from now

**Check Balance Deduction:**
```bash
# Re-run account info
curl -X POST http://localhost:3000/api/dhru/index.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=reseller_abc123" \
  -d "apiaccesskey=XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX" \
  -d "action=accountinfo" \
  -d "requestformat=JSON"
```

**Verification:**
- ✅ BALANCE should be reduced by 1 credit (e.g., 100 → 99)

### Step 5: Test Order Details

Retrieve the license key from previous order:

```bash
curl -X POST http://localhost:3000/api/dhru/index.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=reseller_abc123" \
  -d "apiaccesskey=XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX" \
  -d "action=imeiorderdetails" \
  -d "requestformat=JSON" \
  -d 'parameters={"ORDERID":"DH1727434200ABC"}'
```

**Expected Response:**
```json
{
  "STATUS": "SUCCESS",
  "ORDERID": "DH1727434200ABC",
  "STATUS": "COMPLETED",
  "SERVICEID": "PDM3M",
  "SERVICENAME": "PDM 3 Months License",
  "COST": "1",
  "CODE": "PDM-A1B2-C3D4-E5F6-G7H8",
  "COMMENT": "Your PDM license key. Download: https://perfectdownloadmanager.com/download",
  "MESSAGE": "License is active",
  "IMEI": "test@example.com",
  "USERNAME": "testuser",
  "EMAIL": "test@example.com",
  "CREATED": "2026-09-27T10:30:00.000Z",
  "EXPIRES": "2026-12-27T10:30:00.000Z"
}
```

**Verification:**
- ✅ Should return same license key as in Step 4
- ✅ Order details should match the placed order

### Step 6: Test 6 Month License

```bash
curl -X POST http://localhost:3000/api/dhru/index.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=reseller_abc123" \
  -d "apiaccesskey=XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX" \
  -d "action=placeimeiorder" \
  -d "requestformat=JSON" \
  -d 'parameters={"ID":"PDM6M","IMEI":"user2@example.com"}'
```

**Verification:**
- ✅ COST should be "2"
- ✅ EXPIRES should be ~6 months from now
- ✅ Balance deducted by 2 credits

### Step 7: Test 12 Month License

```bash
curl -X POST http://localhost:3000/api/dhru/index.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=reseller_abc123" \
  -d "apiaccesskey=XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX" \
  -d "action=placeimeiorder" \
  -d "requestformat=JSON" \
  -d 'parameters={"ID":"PDM12M","IMEI":"user3@example.com"}'
```

**Verification:**
- ✅ COST should be "3"
- ✅ EXPIRES should be ~12 months from now
- ✅ Balance deducted by 3 credits

## Error Testing

### Test Invalid Credentials

```bash
curl -X POST http://localhost:3000/api/dhru/index.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=invalid_user" \
  -d "apiaccesskey=WRONG-KEY" \
  -d "action=accountinfo" \
  -d "requestformat=JSON"
```

**Expected:**
```json
{
  "STATUS": "ERROR",
  "ERROR": "INVALID_CREDENTIALS",
  "MESSAGE": "Authentication failed"
}
```

### Test Insufficient Balance

1. Create order that exceeds balance
2. Or use account with low balance

```bash
curl -X POST http://localhost:3000/api/dhru/index.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=reseller_abc123" \
  -d "apiaccesskey=XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX" \
  -d "action=placeimeiorder" \
  -d "requestformat=JSON" \
  -d 'parameters={"ID":"PDM12M","IMEI":"test@example.com"}'
```

**Expected (if balance < 3):**
```json
{
  "STATUS": "ERROR",
  "ERROR": "INSUFFICIENT_BALANCE",
  "MESSAGE": "Insufficient balance. Required: 3 credits, Available: 2 credits"
}
```

### Test Invalid Service ID

```bash
curl -X POST http://localhost:3000/api/dhru/index.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=reseller_abc123" \
  -d "apiaccesskey=XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX" \
  -d "action=placeimeiorder" \
  -d "requestformat=JSON" \
  -d 'parameters={"ID":"INVALID","IMEI":"test@example.com"}'
```

**Expected:**
```json
{
  "STATUS": "ERROR",
  "ERROR": "INVALID_SERVICE",
  "MESSAGE": "Service 'INVALID' not found"
}
```

### Test Missing IMEI

```bash
curl -X POST http://localhost:3000/api/dhru/index.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=reseller_abc123" \
  -d "apiaccesskey=XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX" \
  -d "action=placeimeiorder" \
  -d "requestformat=JSON" \
  -d 'parameters={"ID":"PDM3M"}'
```

**Expected:**
```json
{
  "STATUS": "ERROR",
  "ERROR": "MISSING_IMEI",
  "MESSAGE": "IMEI field (username/email) is required"
}
```

### Test Order Not Found

```bash
curl -X POST http://localhost:3000/api/dhru/index.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=reseller_abc123" \
  -d "apiaccesskey=XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX" \
  -d "action=imeiorderdetails" \
  -d "requestformat=JSON" \
  -d 'parameters={"ORDERID":"INVALID_ORDER"}'
```

**Expected:**
```json
{
  "STATUS": "ERROR",
  "ERROR": "ORDER_NOT_FOUND",
  "MESSAGE": "Order 'INVALID_ORDER' not found"
}
```

## Database Verification

### Check License in pdm-licenses table

```bash
aws dynamodb get-item \
  --table-name pdm-licenses \
  --key '{"licenseKey":{"S":"PDM-A1B2-C3D4-E5F6-G7H8"}}' \
  --region ap-south-1
```

**Verify:**
- ✅ License exists
- ✅ `owner` field matches email
- ✅ `expiresAt` is set correctly
- ✅ `resellerAccountId` matches reseller account

### Check Order in pdm-dhru-orders table

```bash
aws dynamodb get-item \
  --table-name pdm-dhru-orders \
  --key '{"orderId":{"S":"DH1727434200ABC"}}' \
  --region ap-south-1
```

**Verify:**
- ✅ Order exists
- ✅ Contains license key
- ✅ Status is "COMPLETED"
- ✅ Cost matches service

### Check Transaction in pdm-transactions table

```bash
aws dynamodb query \
  --table-name pdm-transactions \
  --index-name accountId-timestamp-index \
  --key-condition-expression "accountId = :aid" \
  --expression-attribute-values '{":aid":{"S":"acc_xxxxx"}}' \
  --region ap-south-1 \
  --limit 5 \
  --scan-index-forward false
```

**Verify:**
- ✅ Transaction type is "debit"
- ✅ Amount matches license cost
- ✅ Reason mentions Dhru API
- ✅ `relatedEntity` contains license key

### Check Audit Log

```bash
aws dynamodb query \
  --table-name pdm-audit-log \
  --index-name actor-timestamp-index \
  --key-condition-expression "actor = :actor" \
  --expression-attribute-values '{":actor":{"S":"dhru:reseller_abc123"}}' \
  --region ap-south-1 \
  --limit 5 \
  --scan-index-forward false
```

**Verify:**
- ✅ Action is "dhru_license_purchased"
- ✅ Contains order ID and license key
- ✅ Metadata includes service details

## Postman Collection

Import this collection for easier testing:

```json
{
  "info": {
    "name": "PDM Dhru API",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "variable": [
    {
      "key": "base_url",
      "value": "http://localhost:3000"
    },
    {
      "key": "username",
      "value": "reseller_abc123"
    },
    {
      "key": "api_key",
      "value": "XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX"
    }
  ],
  "item": [
    {
      "name": "Account Info",
      "request": {
        "method": "POST",
        "header": [
          {
            "key": "Content-Type",
            "value": "application/x-www-form-urlencoded"
          }
        ],
        "body": {
          "mode": "urlencoded",
          "urlencoded": [
            {"key": "username", "value": "{{username}}"},
            {"key": "apiaccesskey", "value": "{{api_key}}"},
            {"key": "action", "value": "accountinfo"},
            {"key": "requestformat", "value": "JSON"}
          ]
        },
        "url": "{{base_url}}/api/dhru/index.php"
      }
    },
    {
      "name": "Service List",
      "request": {
        "method": "POST",
        "header": [
          {
            "key": "Content-Type",
            "value": "application/x-www-form-urlencoded"
          }
        ],
        "body": {
          "mode": "urlencoded",
          "urlencoded": [
            {"key": "username", "value": "{{username}}"},
            {"key": "apiaccesskey", "value": "{{api_key}}"},
            {"key": "action", "value": "imeiservicelist"},
            {"key": "requestformat", "value": "JSON"}
          ]
        },
        "url": "{{base_url}}/api/dhru/index.php"
      }
    },
    {
      "name": "Place Order - 3M",
      "request": {
        "method": "POST",
        "header": [
          {
            "key": "Content-Type",
            "value": "application/x-www-form-urlencoded"
          }
        ],
        "body": {
          "mode": "urlencoded",
          "urlencoded": [
            {"key": "username", "value": "{{username}}"},
            {"key": "apiaccesskey", "value": "{{api_key}}"},
            {"key": "action", "value": "placeimeiorder"},
            {"key": "requestformat", "value": "JSON"},
            {"key": "parameters", "value": "{\"ID\":\"PDM3M\",\"IMEI\":\"testuser|test@example.com\"}"}
          ]
        },
        "url": "{{base_url}}/api/dhru/index.php"
      }
    },
    {
      "name": "Order Details",
      "request": {
        "method": "POST",
        "header": [
          {
            "key": "Content-Type",
            "value": "application/x-www-form-urlencoded"
          }
        ],
        "body": {
          "mode": "urlencoded",
          "urlencoded": [
            {"key": "username", "value": "{{username}}"},
            {"key": "apiaccesskey", "value": "{{api_key}}"},
            {"key": "action", "value": "imeiorderdetails"},
            {"key": "requestformat", "value": "JSON"},
            {"key": "parameters", "value": "{\"ORDERID\":\"DH1727434200ABC\"}"}
          ]
        },
        "url": "{{base_url}}/api/dhru/index.php"
      }
    }
  ]
}
```

## Success Criteria

All tests pass when:

- ✅ Credentials generated successfully via UI
- ✅ Account info returns correct balance
- ✅ Service list shows all 3 PDM plans
- ✅ Can place orders for 3M, 6M, 12M licenses
- ✅ Balance deducted correctly (1, 2, 3 credits)
- ✅ License keys generated and returned
- ✅ Order details retrievable
- ✅ Licenses stored in database
- ✅ Transactions recorded
- ✅ Audit logs created
- ✅ Error handling works correctly
- ✅ Invalid credentials rejected
- ✅ Insufficient balance detected
- ✅ Missing parameters caught

## Troubleshooting

### Issue: Authentication fails
- Check username and API key are correct
- Verify GSI exists on pdm-portal-resellers table
- Check account state is "active"

### Issue: Balance not deducting
- Check transaction manager is working
- Verify pdm-transactions table exists
- Check account has balance to deduct

### Issue: License not generated
- Check pdm-licenses table exists
- Verify license creation service is working
- Check for errors in server logs

### Issue: Order not found
- Verify pdm-dhru-orders table exists
- Check order was saved successfully
- Verify querying by correct orderId

---

**Testing completed on**: [Date]  
**Tested by**: [Your name]  
**All tests passed**: [ ] Yes [ ] No  
**Notes**: [Add any observations]
