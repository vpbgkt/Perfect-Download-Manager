# Dhru API Integration Guide for Resellers

## Overview

This guide explains how PDM resellers can integrate our Dhru-compatible API into their existing Dhru Fusion panels to sell PDM licenses directly to their customers.

## What is Dhru API?

Dhru Fusion is a popular panel software used by mobile service providers to manage IMEI unlocking, file services, and other mobile-related services. Our Dhru-compatible API allows you to add PDM licenses as a service in your Dhru panel.

## Available PDM License Services

| Service ID | Description | Duration | Cost (Credits) |
|-----------|-------------|----------|----------------|
| **PDM3M** | PDM 3 Months License | 90 days | 1 credit |
| **PDM6M** | PDM 6 Months License | 180 days | 2 credits |
| **PDM12M** | PDM 12 Months License | 365 days | 3 credits |

## Getting Started

### Step 1: Obtain API Credentials

Contact your PDM portal administrator to receive your Dhru API credentials. You will receive:

- **Username**: Your unique Dhru API username (e.g., `mycompany_abc123`)
- **API Access Key**: Your secret key (format: `XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX`)
- **API Endpoint**: The URL to make API requests (e.g., `https://portal.perfectdownloadmanager.com/api/dhru/index.php`)

### Step 2: Configure in Dhru Panel

1. Log into your Dhru Fusion panel as admin
2. Navigate to **Services → API Services**
3. Click **Add New API Service**
4. Configure the following:
   - **Service Name**: PDM License Service (or your preferred name)
   - **API Type**: IMEI API
   - **API URL**: [Your endpoint provided]
   - **Username**: [Your username provided]
   - **API Key**: [Your API access key provided]
   - **Request Format**: JSON
   - **Response Format**: JSON

5. Click **Save** and **Test Connection**
6. If successful, you should see your current balance and account status

### Step 3: Add PDM Services

After configuring the API connection, add the three PDM services:

#### For PDM 3 Months License:
- **Service ID**: PDM3M
- **Service Name**: PDM 3 Months License
- **Cost**: 1 credit (set your own selling price)
- **Delivery Time**: Instant
- **Required Fields**: Username, Email

#### For PDM 6 Months License:
- **Service ID**: PDM6M
- **Service Name**: PDM 6 Months License
- **Cost**: 2 credits (set your own selling price)
- **Delivery Time**: Instant
- **Required Fields**: Username, Email

#### For PDM 12 Months License:
- **Service ID**: PDM12M
- **Service Name**: PDM 12 Months License
- **Cost**: 3 credits (set your own selling price)
- **Delivery Time**: Instant
- **Required Fields**: Username, Email

## API Actions Reference

### 1. accountinfo

Check your PDM account balance and status.

**Request:**
```
POST /api/dhru/index.php
Content-Type: application/x-www-form-urlencoded

username=your_username
apiaccesskey=YOUR-API-KEY
action=accountinfo
requestformat=JSON
```

**Response:**
```json
{
  "STATUS": "SUCCESS",
  "USERNAME": "your_username",
  "BALANCE": "150.00",
  "CREDITS": "150",
  "CURRENCY": "USD",
  "ACCOUNT_TYPE": "RESELLER",
  "STATUS": "ACTIVE",
  "EMAIL": "your@email.com",
  "ORGANIZATION": "Your Company Name"
}
```

### 2. imeiservicelist

Get list of available PDM license services.

**Request:**
```
POST /api/dhru/index.php
Content-Type: application/x-www-form-urlencoded

username=your_username
apiaccesskey=YOUR-API-KEY
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

### 3. placeimeiorder

Purchase a PDM license (deducts balance automatically).

**Request:**
```
POST /api/dhru/index.php
Content-Type: application/x-www-form-urlencoded

username=your_username
apiaccesskey=YOUR-API-KEY
action=placeimeiorder
requestformat=JSON
parameters={"ID":"PDM3M","IMEI":"johndoe|john@example.com"}
```

**Important Notes:**
- **IMEI field format**: Use `username|email` or just `email`
- **ID**: Must be one of: PDM3M, PDM6M, PDM12M
- Balance is deducted immediately upon successful order

**Success Response:**
```json
{
  "STATUS": "SUCCESS",
  "ORDERID": "DH1234567890ABC",
  "STATUS": "COMPLETED",
  "SERVICEID": "PDM3M",
  "SERVICENAME": "PDM 3 Months License",
  "COST": "1",
  "CODE": "PDM-XXXX-XXXX-XXXX-XXXX",
  "COMMENT": "Your PDM license key is ready. Download: https://perfectdownloadmanager.com/download",
  "MESSAGE": "License generated successfully",
  "TIME": "Instant",
  "IMEI": "johndoe|john@example.com",
  "USERNAME": "johndoe",
  "EMAIL": "john@example.com",
  "EXPIRES": "2027-12-27T10:30:00.000Z"
}
```

**Error Response:**
```json
{
  "STATUS": "ERROR",
  "ERROR": "INSUFFICIENT_BALANCE",
  "MESSAGE": "Insufficient balance. Required: 1 credits, Available: 0 credits"
}
```

### 4. imeiorderdetails

Retrieve license key and details for a previous order.

**Request:**
```
POST /api/dhru/index.php
Content-Type: application/x-www-form-urlencoded

username=your_username
apiaccesskey=YOUR-API-KEY
action=imeiorderdetails
requestformat=JSON
parameters={"ORDERID":"DH1234567890ABC"}
```

**Response:**
```json
{
  "STATUS": "SUCCESS",
  "ORDERID": "DH1234567890ABC",
  "STATUS": "COMPLETED",
  "SERVICEID": "PDM3M",
  "SERVICENAME": "PDM 3 Months License",
  "COST": "1",
  "CODE": "PDM-XXXX-XXXX-XXXX-XXXX",
  "COMMENT": "Your PDM license key. Download: https://perfectdownloadmanager.com/download",
  "MESSAGE": "License is active",
  "IMEI": "john@example.com",
  "USERNAME": "johndoe",
  "EMAIL": "john@example.com",
  "CREATED": "2026-09-27T10:30:00.000Z",
  "EXPIRES": "2027-12-27T10:30:00.000Z"
}
```

## Testing with Postman/cURL

### Test Account Info

```bash
curl -X POST https://your-portal.com/api/dhru/index.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=your_username" \
  -d "apiaccesskey=YOUR-API-KEY" \
  -d "action=accountinfo" \
  -d "requestformat=JSON"
```

### Test Service List

```bash
curl -X POST https://your-portal.com/api/dhru/index.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=your_username" \
  -d "apiaccesskey=YOUR-API-KEY" \
  -d "action=imeiservicelist" \
  -d "requestformat=JSON"
```

### Test Place Order (3 Month License)

```bash
curl -X POST https://your-portal.com/api/dhru/index.php \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "username=your_username" \
  -d "apiaccesskey=YOUR-API-KEY" \
  -d "action=placeimeiorder" \
  -d "requestformat=JSON" \
  -d 'parameters={"ID":"PDM3M","IMEI":"testuser|test@example.com"}'
```

## Error Codes

| Error Code | Description |
|-----------|-------------|
| **INVALID_CREDENTIALS** | Username or API key is incorrect |
| **ACCOUNT_SUSPENDED** | Your account has been suspended |
| **AUTHENTICATION_FAILED** | Authentication error |
| **MISSING_PARAMETERS** | Required parameters are missing |
| **INVALID_ACTION** | The action specified is not supported |
| **MISSING_SERVICE_ID** | Service ID not provided in order |
| **INVALID_SERVICE** | Service ID does not exist |
| **MISSING_IMEI** | Username/email not provided |
| **INSUFFICIENT_BALANCE** | Not enough credits to complete order |
| **ORDER_NOT_FOUND** | Order ID does not exist |
| **UNAUTHORIZED** | Cannot access this order |
| **INTERNAL_ERROR** | Server error occurred |

## Balance Management

### How Balance Works

1. Your PDM portal balance is measured in **credits**
2. Each PDM license purchase deducts credits based on the service:
   - 3 months = 1 credit
   - 6 months = 2 credits
   - 12 months = 3 credits

3. Ensure you have sufficient balance before processing orders
4. Contact your administrator to add more credits to your account

### Checking Balance

- Use the `accountinfo` action to check your current balance
- Your Dhru panel may also display the balance automatically
- Monitor balance regularly to avoid order failures

## Customer Delivery

When a customer purchases a PDM license through your Dhru panel:

1. **License Key** is returned in the `CODE` field
2. **Download Link** is in the `COMMENT` field
3. **Expiration Date** shows when the license expires
4. Provide both the license key AND download link to your customer

### Email Template Example

```
Dear Customer,

Your PDM License has been activated!

License Key: [CODE from response]
Valid Until: [EXPIRES from response]

Download PDM: https://perfectdownloadmanager.com/download

Installation Instructions:
1. Download and install PDM from the link above
2. Open PDM application
3. Go to License/Registration section
4. Enter your license key
5. Click Activate

Thank you for your purchase!
```

## Troubleshooting

### Connection Fails

- Verify the API endpoint URL is correct
- Check username and API key are entered correctly
- Ensure your account is active (not suspended)
- Test with the `accountinfo` action first

### Order Fails with Insufficient Balance

- Check your current balance using `accountinfo`
- Contact administrator to add more credits
- Ensure the service cost is correct (1, 2, or 3 credits)

### License Key Not Returned

- Check the response `STATUS` field - should be "SUCCESS"
- Verify the `CODE` field contains the license key
- If order was successful but no key, use `imeiorderdetails` to retrieve it

### Customer Says License Invalid

- Verify the license key was copied correctly (no extra spaces)
- Check expiration date hasn't passed
- Ensure customer downloaded PDM from official website
- Contact administrator for license verification

## Security Best Practices

1. **Keep API Key Secret**: Never share your API access key publicly
2. **Use HTTPS**: Always use the secure HTTPS endpoint
3. **Monitor Usage**: Regularly check your order history and balance
4. **Secure Storage**: Store credentials securely in your Dhru panel
5. **Log Requests**: Keep logs of API requests for troubleshooting

## Support

For technical support or questions:

- **Admin Panel**: Contact your PDM portal administrator
- **Integration Issues**: Check API response error messages
- **Balance/Billing**: Contact administrator for account management
- **Dhru Panel Setup**: Refer to Dhru Fusion documentation

## Changelog

### Version 1.0 (September 2026)
- Initial Dhru API integration
- Support for 3 PDM license tiers
- Instant license generation
- Automatic balance deduction
- Full Dhru Fusion compatibility

---

**Last Updated**: September 27, 2026  
**API Version**: 1.0  
**Compatible with**: Dhru Fusion 2.x and later
