# Dhru API - Complete Setup & Testing Guide

## Overview
The Dhru API endpoint allows resellers to integrate their Dhru panels with the PDM licensing system. Resellers can check balances, list services, place orders, and retrieve license keys through a Dhru-compatible API.

**Endpoint:** `/api/dhru/index.php`

---

## 🚀 Quick Start

### 1. Infrastructure Setup

Run the setup script to create required database infrastructure:

```powershell
cd deploy/dynamodb
./setup-dhru-api.ps1
```

This script will:
- Add `dhruApiUsername` GSI to `pdm-portal-resellers` table
- Create `pdm-dhru-orders` table
- Verify the setup

**What it creates:**

**Table: `pdm-dhru-orders`**
- Stores all Dhru API orders
- Primary Key: `orderId`
- GSI: `resellerAccountId-createdAt-index` (for querying orders by account)

**GSI: `dhruApiUsername-index`** on `pdm-portal-resellers`
- Allows fast lookup by Dhru username
- Used for authentication

---

### 2. Generate Credentials

1. Log in to the admin portal
2. Navigate to `/dashboard/api-keys`
3. Enter the reseller account ID (or it auto-fills for distributors)
4. Click "Generate Credentials"

You'll receive:
- **Username:** `distributor` (email prefix)
- **API Access Key:** `8B3-B92-97F-40E-E17-BA9-B49-78C`
- **Endpoint:** `http://localhost:3000/api/dhru/index.php`

---

### 3. Test the API

Run the test script:

```powershell
./test-dhru-api.ps1 -Username "distributor" -ApiKey "8B3-B92-97F-40E-E17-BA9-B49-78C"
```

For production:
```powershell
./test-dhru-api.ps1 -BaseUrl "https://your-domain.com" -Username "distributor" -ApiKey "8B3-B92-97F-40E-E17-BA9-B49-78C"
```

---

## 📡 API Reference

### Request Format

All requests use POST with `application/x-www-form-urlencoded`:

```
POST /api/dhru/index.php
Content-Type: application/x-www-form-urlencoded

username=distributor
apiaccesskey=8B3-B92-97F-40E-E17-BA9-B49-78C
action=accountinfo
requestformat=JSON
```

Or with JSON content type:

```json
POST /api/dhru/index.php
Content-Type: application/json

{
  "username": "distributor",
  "apiaccesskey": "8B3-B92-97F-40E-E17-BA9-B49-78C",
  "action": "accountinfo",
  "requestformat": "JSON"
}
```

### Common Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `username` | Yes | Dhru API username |
| `apiaccesskey` | Yes | API access key (format: XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX) |
| `action` | Yes | Action to perform |
| `requestformat` | Yes | Response format (always "JSON") |
| `parameters` | No | Action-specific parameters (JSON string) |

---

## 🔧 Supported Actions

### 1. Account Info (`accountinfo`)

Get account balance and status.

**Request:**
```
username=distributor
apiaccesskey=8B3-B92-97F-40E-E17-BA9-B49-78C
action=accountinfo
requestformat=JSON
```

**Response:**
```json
{
  "STATUS": "SUCCESS",
  "USERNAME": "distributor",
  "BALANCE": "100.00",
  "CREDITS": "100",
  "CURRENCY": "USD",
  "ACCOUNT_TYPE": "RESELLER",
  "STATUS": "ACTIVE",
  "EMAIL": "distributor@example.com",
  "ORGANIZATION": "My Company"
}
```

---

### 2. Service List (`imeiservicelist`)

List available PDM license plans.

**Request:**
```
username=distributor
apiaccesskey=8B3-B92-97F-40E-E17-BA9-B49-78C
action=imeiservicelist
requestformat=JSON
```

**Response:**
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

---

### 3. Place Order (`placeimeiorder`)

Purchase a PDM license.

**Request:**
```
username=distributor
apiaccesskey=8B3-B92-97F-40E-E17-BA9-B49-78C
action=placeimeiorder
requestformat=JSON
parameters={"ID":"PDM3M","IMEI":"john.doe@example.com"}
```

**Parameters:**
- `ID` or `SERVICEID`: Service ID (PDM3M, PDM6M, PDM12M)
- `IMEI`: Customer username and/or email
  - Format: `email@domain.com` or `username|email@domain.com`

**Response:**
```json
{
  "STATUS": "SUCCESS",
  "ORDERID": "DH1704123456789ABCDE",
  "STATUS": "COMPLETED",
  "SERVICEID": "PDM3M",
  "SERVICENAME": "PDM 3 Months License",
  "COST": "1",
  "CODE": "PDM-XXXX-XXXX-XXXX-XXXX",
  "COMMENT": "Your PDM license key is ready. Download: https://perfectdownloadmanager.com/download",
  "MESSAGE": "License generated successfully",
  "TIME": "Instant",
  "IMEI": "john.doe@example.com",
  "USERNAME": "john.doe",
  "EMAIL": "john.doe@example.com",
  "EXPIRES": "2024-04-01T00:00:00.000Z"
}
```

**Error Responses:**

Insufficient Balance:
```json
{
  "STATUS": "ERROR",
  "ERROR": "INSUFFICIENT_BALANCE",
  "MESSAGE": "Insufficient balance. Required: 1 credits, Available: 0 credits"
}
```

Invalid Service:
```json
{
  "STATUS": "ERROR",
  "ERROR": "INVALID_SERVICE",
  "MESSAGE": "Service 'INVALID' not found"
}
```

---

### 4. Order Details (`imeiorderdetails`)

Retrieve license key and order information.

**Request:**
```
username=distributor
apiaccesskey=8B3-B92-97F-40E-E17-BA9-B49-78C
action=imeiorderdetails
requestformat=JSON
parameters={"ORDERID":"DH1704123456789ABCDE"}
```

**Parameters:**
- `ORDERID`: The order ID from placeimeiorder

**Response:**
```json
{
  "STATUS": "SUCCESS",
  "ORDERID": "DH1704123456789ABCDE",
  "STATUS": "COMPLETED",
  "SERVICEID": "PDM3M",
  "SERVICENAME": "PDM 3 Months License",
  "COST": "1",
  "CODE": "PDM-XXXX-XXXX-XXXX-XXXX",
  "COMMENT": "Your PDM license key. Download: https://perfectdownloadmanager.com/download",
  "MESSAGE": "License is active",
  "IMEI": "john.doe@example.com",
  "USERNAME": "john.doe",
  "EMAIL": "john.doe@example.com",
  "CREATED": "2024-01-01T00:00:00.000Z",
  "EXPIRES": "2024-04-01T00:00:00.000Z",
  "COMPLETED": "2024-01-01T00:00:00.000Z"
}
```

---

## 🔐 Authentication

Authentication uses username + API access key combination:

1. **Username Lookup:** Query `pdm-portal-resellers` table using `dhruApiUsername-index` GSI
2. **Key Verification:** Compare provided key with stored `dhruApiAccessKey`
3. **Account Check:** Verify account `state` is `active`

### Error Responses

Invalid Credentials:
```json
{
  "STATUS": "ERROR",
  "ERROR": "INVALID_CREDENTIALS",
  "MESSAGE": "Authentication failed"
}
```

Account Suspended:
```json
{
  "STATUS": "ERROR",
  "ERROR": "ACCOUNT_SUSPENDED",
  "MESSAGE": "Authentication failed"
}
```

---

## 💰 Pricing & Balance

| Service | Duration | Cost (Credits) |
|---------|----------|----------------|
| PDM3M   | 3 Months | 1              |
| PDM6M   | 6 Months | 2              |
| PDM12M  | 12 Months| 3              |

**Balance Flow:**
1. Reseller starts with initial balance (set during account creation)
2. Each license purchase deducts credits from balance
3. Transaction is recorded in `pdm-portal-transactions` table
4. Order is stored in `pdm-dhru-orders` table

---

## 🧪 Testing Examples

### cURL Examples

**Account Info:**
```bash
curl -X POST http://localhost:3000/api/dhru/index.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=distributor" \
  -d "apiaccesskey=8B3-B92-97F-40E-E17-BA9-B49-78C" \
  -d "action=accountinfo" \
  -d "requestformat=JSON"
```

**Place Order:**
```bash
curl -X POST http://localhost:3000/api/dhru/index.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=distributor" \
  -d "apiaccesskey=8B3-B92-97F-40E-E17-BA9-B49-78C" \
  -d "action=placeimeiorder" \
  -d "requestformat=JSON" \
  -d 'parameters={"ID":"PDM3M","IMEI":"customer@example.com"}'
```

### PowerShell Examples

**Account Info:**
```powershell
$body = @{
    username = "distributor"
    apiaccesskey = "8B3-B92-97F-40E-E17-BA9-B49-78C"
    action = "accountinfo"
    requestformat = "JSON"
}

Invoke-RestMethod -Uri "http://localhost:3000/api/dhru/index.php" `
    -Method POST `
    -Body $body `
    -ContentType "application/x-www-form-urlencoded"
```

**Place Order:**
```powershell
$params = @{
    ID = "PDM3M"
    IMEI = "customer@example.com"
} | ConvertTo-Json -Compress

$body = @{
    username = "distributor"
    apiaccesskey = "8B3-B92-97F-40E-E17-BA9-B49-78C"
    action = "placeimeiorder"
    requestformat = "JSON"
    parameters = $params
}

Invoke-RestMethod -Uri "http://localhost:3000/api/dhru/index.php" `
    -Method POST `
    -Body $body `
    -ContentType "application/x-www-form-urlencoded"
```

---

## 🎯 Dhru Panel Configuration

To configure a Dhru panel to use this API:

### 1. Add API Service

1. Log in to Dhru panel admin
2. Go to **Services → Add New Service → API Service**
3. Select **"Custom API"** or **"Generic API"**

### 2. Configure API Details

| Field | Value |
|-------|-------|
| **Service Name** | PDM Licenses |
| **API Type** | Custom/Generic |
| **API URL** | `https://your-domain.com/api/dhru/index.php` |
| **Username** | `distributor` |
| **API Key** | `8B3-B92-97F-40E-E17-BA9-B49-78C` |
| **Request Method** | POST |
| **Request Format** | Form Data or JSON |

### 3. Add Service Plans

Create services in Dhru panel matching these IDs:
- **PDM3M** - 3 Months License (1 credit)
- **PDM6M** - 6 Months License (2 credits)
- **PDM12M** - 12 Months License (3 credits)

### 4. Test Connection

Use Dhru panel's API test feature to verify:
1. Account balance retrieval
2. Service list
3. Test order placement

---

## 📊 Database Schema

### pdm-dhru-orders Table

```
Primary Key: orderId (String)
GSI: resellerAccountId-createdAt-index

Attributes:
- orderId: "DH1704123456789ABCDE"
- resellerAccountId: "acc_xxx"
- dhruUsername: "distributor"
- serviceId: "PDM3M"
- serviceName: "PDM 3 Months License"
- licenseKey: "PDM-XXXX-XXXX-XXXX-XXXX"
- cost: 1
- username: "john.doe"
- email: "john.doe@example.com"
- status: "COMPLETED"
- createdAt: "2024-01-01T00:00:00.000Z"
- expiresAt: "2024-04-01T00:00:00.000Z"
```

### pdm-portal-resellers (Updated)

Added fields:
- `dhruApiUsername` - Dhru API username (email prefix)
- `dhruApiAccessKey` - API access key (8 segments)
- `dhruApiCreatedAt` - Timestamp when credentials were generated
- `dhruApiRevokedAt` - Timestamp when credentials were revoked (if applicable)

New GSI: `dhruApiUsername-index` for fast authentication lookups

---

## 🔍 Troubleshooting

### Issue: "Invalid Credentials" Error

**Cause:** Username or API key mismatch

**Solution:**
1. Verify credentials in `/dashboard/api-keys`
2. Check for extra spaces or incorrect copy/paste
3. Ensure credentials haven't been revoked

### Issue: "GSI Not Found" Error

**Cause:** dhruApiUsername-index GSI not created

**Solution:**
```powershell
cd deploy/dynamodb
./setup-dhru-api.ps1
```

### Issue: "Table Not Found" Error

**Cause:** pdm-dhru-orders table doesn't exist

**Solution:**
```powershell
cd deploy/dynamodb
aws dynamodb create-table --cli-input-json file://pdm-dhru-orders.json
```

### Issue: "Insufficient Balance"

**Cause:** Reseller account has insufficient credits

**Solution:**
1. Add credits to the account via admin portal
2. Navigate to `/dashboard/accounts`
3. Find the reseller account
4. Add transaction to increase balance

---

## 🚀 Production Deployment

### 1. Environment Variables

Ensure these are set:
```bash
AWS_REGION=your-region
AWS_ACCESS_KEY_ID=your-key
AWS_SECRET_ACCESS_KEY=your-secret
```

### 2. Run Setup

```powershell
cd deploy/dynamodb
./setup-dhru-api.ps1
```

### 3. Update Endpoint URLs

In production, the endpoint will be:
```
https://your-domain.com/api/dhru/index.php
```

### 4. Test Connectivity

```powershell
./test-dhru-api.ps1 -BaseUrl "https://your-domain.com" -Username "your-username" -ApiKey "your-key"
```

---

## 📚 Related Documentation

- [DHRU-README.md](./DHRU-README.md) - Original integration overview
- [DHRU-QUICK-START.md](./DHRU-QUICK-START.md) - Quick start guide
- [DHRU-API-TESTING.md](./DHRU-API-TESTING.md) - API testing details
- [DHRU-RESELLER-INTEGRATION.md](./DHRU-RESELLER-INTEGRATION.md) - Reseller integration guide

---

## ✅ Checklist

Before going live:

- [ ] Run `setup-dhru-api.ps1` to create infrastructure
- [ ] Generate Dhru API credentials for test account
- [ ] Run `test-dhru-api.ps1` with test credentials
- [ ] Verify all 4 actions work (accountinfo, servicelist, placeorder, orderdetails)
- [ ] Test with actual Dhru panel (if available)
- [ ] Set up monitoring for `/api/dhru/index.php` endpoint
- [ ] Configure rate limiting if needed
- [ ] Document credentials securely
- [ ] Train resellers on integration process

---

## 🎉 Summary

The Dhru API integration is now complete and functional! Resellers can:

✅ Check their account balance  
✅ List available PDM license services  
✅ Purchase licenses instantly  
✅ Retrieve license keys anytime  
✅ Integrate seamlessly with existing Dhru panels  

All transactions are tracked, audited, and balance is updated in real-time.
