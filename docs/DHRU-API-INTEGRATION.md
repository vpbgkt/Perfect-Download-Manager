# Dhru API Integration Documentation

## Overview

The PDM Admin Portal integrates with Dhru Fusion API to allow distributors to place IMEI unlock and file-based service orders. When distributors place orders through Dhru API, the cost is automatically deducted from their PDM wallet balance.

## Features

- **Account Configuration**: Store Dhru API credentials per distributor account
- **Account Info**: Check Dhru API balance and account status
- **Service Discovery**: Browse available IMEI and File services
- **Order Placement**: Submit orders with automatic balance deduction
- **Order Tracking**: Retrieve order status and details
- **Balance Management**: Automatic wallet deduction and transaction records

---

## Configuration

### 1. Configure Dhru API Credentials

**Admin Portal UI:**
1. Navigate to `/dashboard/api-keys`
2. Scroll to "Dhru API Integration" section
3. Enter the following details:
   - **Distributor Account ID**: The PDM account ID (e.g., `acc_xxxxx`)
   - **Dhru API URL**: Your Dhru Fusion API endpoint (e.g., `https://yoursite.com`)
   - **Dhru Username**: Your Dhru account username
   - **Dhru API Access Key**: Your Dhru API key (format: `XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX`)
4. Click "Save Configuration"
5. Click "Test Connection" to verify

**API Endpoint:**
```http
POST /api/resellers/{accountId}/dhru-config
Content-Type: application/json
Authorization: Bearer {jwt_token}

{
  "dhruApiUrl": "https://yoursite.com",
  "dhruUsername": "your-username",
  "dhruApiKey": "XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX"
}
```

---

## API Endpoints

### 1. Get Account Information

Retrieve Dhru API account balance and status.

**Endpoint:** `GET /api/dhru/accountinfo`

**Query Parameters:**
- `accountId` (required): PDM distributor account ID

**Request:**
```http
GET /api/dhru/accountinfo?accountId=acc_xxxxx
Authorization: Bearer {jwt_token}
```

**Response:**
```json
{
  "success": true,
  "accountId": "acc_xxxxx",
  "dhruAccount": {
    "username": "your-username",
    "balance": "1500.00",
    "credits": "1500",
    "status": "active",
    "accountType": "reseller"
  },
  "raw": { /* Full Dhru API response */ }
}
```

---

### 2. Get Services List

Fetch available IMEI and File services.

**Endpoint:** `GET /api/dhru/services`

**Query Parameters:**
- `accountId` (required): PDM distributor account ID
- `type` (optional): Service type - `imei`, `file`, or `all` (default: `all`)

**Request:**
```http
GET /api/dhru/services?accountId=acc_xxxxx&type=imei
Authorization: Bearer {jwt_token}
```

**Response:**
```json
{
  "success": true,
  "accountId": "acc_xxxxx",
  "services": [
    {
      "SERVICEID": "1382",
      "SERVICENAME": "iPhone Unlock Service",
      "CREDIT": "10.00",
      "TIME": "1-24 hours",
      "INFO": "Service information",
      "type": "imei"
    }
  ],
  "count": 1
}
```

---

### 3. Place Order

Submit an IMEI or File order to Dhru API with automatic balance deduction.

**Endpoint:** `POST /api/dhru/placeorder`

**Request Body:**
```json
{
  "accountId": "acc_xxxxx",
  "orderType": "imei",
  "serviceId": "1382",
  "imei": "111111111111116",
  "estimatedCost": 10,
  // Optional IMEI parameters:
  "modelId": "",
  "providerId": "",
  "mep": "",
  "pin": "",
  "kbh": "",
  "prd": "",
  "type": "",
  "reference": "",
  "locks": ""
}
```

**For File Orders:**
```json
{
  "accountId": "acc_xxxxx",
  "orderType": "file",
  "serviceId": "2500",
  "fileName": "example.txt",
  "fileData": "base64_encoded_file_data",
  "estimatedCost": 15
}
```

**Success Response:**
```json
{
  "success": true,
  "order": {
    "dhruOrderId": "DH123456",
    "orderType": "imei",
    "serviceId": "1382",
    "imei": "111111111111116",
    "cost": 10,
    "status": "pending",
    "createdAt": "2026-09-27T10:00:00.000Z"
  },
  "transaction": {
    "transactionId": "txn_xxxxx",
    "previousBalance": 100,
    "newBalance": 90,
    "amount": 10
  },
  "dhruResponse": { /* Full Dhru API response */ }
}
```

**Error Response (Insufficient Balance):**
```json
{
  "error": "insufficient_balance",
  "message": "Insufficient balance. Required: 10 credits, Available: 5 credits",
  "details": {
    "required": 10,
    "available": 5,
    "shortfall": 5
  }
}
```

---

### 4. Get Order Details

Retrieve status and details of a previously placed order.

**Endpoint:** `GET /api/dhru/orders/{orderId}`

**Query Parameters:**
- `accountId` (required): PDM distributor account ID
- `type` (optional): Order type - `imei` or `file` (default: `imei`)

**Request:**
```http
GET /api/dhru/orders/DH123456?accountId=acc_xxxxx&type=imei
Authorization: Bearer {jwt_token}
```

**Response:**
```json
{
  "success": true,
  "orderId": "DH123456",
  "orderType": "imei",
  "accountId": "acc_xxxxx",
  "order": {
    "orderId": "DH123456",
    "status": "completed",
    "serviceId": "1382",
    "serviceName": "iPhone Unlock Service",
    "imei": "111111111111116",
    "cost": "10.00",
    "code": "UNLOCK_CODE_HERE",
    "comment": "Service completed successfully",
    "createdAt": "2026-09-27T10:00:00",
    "completedAt": "2026-09-27T12:00:00",
    "message": "Unlock successful"
  },
  "dhruResponse": { /* Full Dhru API response */ }
}
```

---

## Balance Deduction Flow

When a distributor places an order:

1. **Balance Check**: System verifies PDM wallet has sufficient balance
2. **Order Submission**: Order is sent to Dhru Fusion API
3. **Dhru Confirmation**: Dhru API confirms order acceptance
4. **Balance Deduction**: Cost is deducted from PDM wallet
5. **Transaction Record**: Debit transaction is created with order reference
6. **Audit Log**: Order placement is logged for compliance

**Transaction Record:**
```json
{
  "transactionId": "txn_xxxxx",
  "accountId": "acc_xxxxx",
  "type": "debit",
  "amount": 10,
  "reason": "Dhru API imei order - DH123456",
  "relatedEntity": "dhru:imei:DH123456",
  "metadata": {
    "dhruOrderId": "DH123456",
    "orderType": "imei",
    "serviceId": "1382",
    "imei": "111111111111116"
  },
  "createdAt": "2026-09-27T10:00:00.000Z"
}
```

---

## Error Handling

### Common Error Codes

| Error Code | HTTP Status | Description |
|------------|-------------|-------------|
| `configuration_missing` | 400 | Dhru API not configured for account |
| `insufficient_balance` | 402 | Not enough credits in PDM wallet |
| `account_suspended` | 403 | Account is not active |
| `not_found` | 404 | Account or order not found |
| `dhru_api_error` | 502 | Failed to connect to Dhru API |
| `dhru_order_failed` | 400 | Dhru API rejected the order |

### Example Error Response

```json
{
  "error": "insufficient_balance",
  "message": "Insufficient balance. Required: 10 credits, Available: 5 credits",
  "details": {
    "required": 10,
    "available": 5,
    "shortfall": 5
  }
}
```

---

## Security

### Authentication

All Dhru API endpoints require authentication via JWT token:

```http
Authorization: Bearer {jwt_token}
```

### Authorization

- **Super Admins**: Can configure and access Dhru API for all accounts
- **Distributors**: Can only access their own Dhru API integration
- **Resellers/Dealers**: Cannot access Dhru API endpoints

### Credentials Storage

Dhru API credentials are stored encrypted in the `pdm-portal-resellers` table:
- `dhruApiUrl`: Dhru Fusion API endpoint
- `dhruUsername`: Dhru account username
- `dhruApiKey`: Dhru API access key (stored securely)
- `dhruConfiguredAt`: Configuration timestamp

---

## Testing

### Test Connection

Use the "Test Connection" button in the admin portal to verify:
1. Credentials are correctly configured
2. Connection to Dhru API is working
3. Account balance can be retrieved

### Test Order Placement

1. Ensure account has sufficient PDM balance
2. Use a test service ID from your Dhru account
3. For IMEI orders, use test IMEI: `111111111111116`
4. Monitor transaction history to verify balance deduction

### Manual API Testing

```bash
# Get Account Info
curl -X GET "http://localhost:3000/api/dhru/accountinfo?accountId=acc_xxxxx" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Get Services
curl -X GET "http://localhost:3000/api/dhru/services?accountId=acc_xxxxx&type=imei" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Place Order
curl -X POST "http://localhost:3000/api/dhru/placeorder" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "acc_xxxxx",
    "orderType": "imei",
    "serviceId": "1382",
    "imei": "111111111111116",
    "estimatedCost": 10
  }'

# Get Order Details
curl -X GET "http://localhost:3000/api/dhru/orders/DH123456?accountId=acc_xxxxx&type=imei" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

## Troubleshooting

### "Configuration Missing" Error

**Problem**: Dhru API credentials not configured

**Solution**:
1. Go to `/dashboard/api-keys`
2. Configure Dhru API credentials
3. Save and test connection

### "Insufficient Balance" Error

**Problem**: PDM wallet balance too low

**Solution**:
1. Check current balance at `/dashboard`
2. Add credits to distributor account
3. Retry order placement

### "Dhru API Error" (502)

**Problem**: Cannot connect to Dhru Fusion API

**Solution**:
1. Verify Dhru API URL is correct
2. Check Dhru API is online and accessible
3. Verify network/firewall settings
4. Test connection using Dhru API test tools

### Orders Placed But Balance Not Deducted

**Problem**: Critical error in transaction processing

**Solution**:
1. Check server logs for transaction errors
2. Verify DynamoDB tables are accessible
3. Manually reconcile balance if needed
4. Contact support with order ID and account ID

---

## Database Schema

### Reseller Account Fields (pdm-portal-resellers)

```typescript
{
  resellerAccountId: string;        // Primary key
  orgName: string;
  contactEmail: string;
  accountType: "distributor" | "reseller" | "dealer";
  state: "active" | "suspended";
  balance: number;
  
  // Dhru API Configuration
  dhruApiUrl?: string;              // Dhru Fusion API endpoint
  dhruUsername?: string;            // Dhru account username  
  dhruApiKey?: string;              // Dhru API access key
  dhruConfiguredAt?: string;        // ISO timestamp
  
  // ... other fields
}
```

---

## Support

For issues or questions about Dhru API integration:

1. Check this documentation
2. Review server logs for error details
3. Test using manual API calls
4. Contact Dhru Fusion support for Dhru API specific issues
5. Contact PDM support for integration issues

---

## Changelog

### Version 1.0 (September 2026)
- Initial Dhru API integration
- Account info endpoint
- Service list endpoint
- Order placement with balance deduction
- Order details endpoint
- Admin portal configuration UI
