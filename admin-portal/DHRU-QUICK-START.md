# Dhru API Quick Start Guide

## For Administrators

### 1. Database Setup (One-time)

```bash
# Create orders table
aws dynamodb create-table \
  --cli-input-json file://deploy/dynamodb/pdm-dhru-orders.json \
  --region ap-south-1

# Add GSI to resellers table
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

# Wait for GSI to become ACTIVE (check status)
aws dynamodb describe-table \
  --table-name pdm-portal-resellers \
  --region ap-south-1 \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`dhruApiUsername-index`].IndexStatus'
```

### 2. Generate Credentials for Reseller

1. Go to: `http://your-portal.com/dashboard/api-keys`
2. Find "Dhru API Integration" section
3. Enter reseller account ID (e.g., `acc_xxxxx`)
4. Click "Generate Credentials"
5. Copy the credentials:
   - Username
   - API Access Key
   - Endpoint URL
6. Send credentials to reseller securely

### 3. Verify Setup

```bash
# Test with the generated credentials
curl -X POST http://your-portal.com/api/dhru/index.php \
  -d "username=GENERATED_USERNAME" \
  -d "apiaccesskey=GENERATED_KEY" \
  -d "action=accountinfo" \
  -d "requestformat=JSON"
```

Expected: Shows reseller balance and status

---

## For Resellers

### 1. Configure Dhru Panel

1. Log into your Dhru Fusion panel
2. Go to: **Services → API Services → Add New**
3. Configure:
   - **API URL**: `https://portal.perfectdownloadmanager.com/api/dhru/index.php`
   - **Username**: [Provided by admin]
   - **API Key**: [Provided by admin]
   - **Request Format**: JSON
4. Click "Test Connection"
5. If successful, proceed to add services

### 2. Add PDM Services

Add these three services in your Dhru panel:

#### Service 1: PDM 3 Months
- **Service ID**: `PDM3M`
- **Service Name**: PDM 3 Months License
- **Your Cost**: 1 credit
- **Selling Price**: [Set your retail price]
- **Delivery**: Instant
- **Fields**: Username, Email

#### Service 2: PDM 6 Months
- **Service ID**: `PDM6M`
- **Service Name**: PDM 6 Months License
- **Your Cost**: 2 credits
- **Selling Price**: [Set your retail price]
- **Delivery**: Instant
- **Fields**: Username, Email

#### Service 3: PDM 12 Months
- **Service ID**: `PDM12M`
- **Service Name**: PDM 12 Months License
- **Your Cost**: 3 credits
- **Selling Price**: [Set your retail price]
- **Delivery**: Instant
- **Fields**: Username, Email

### 3. Test Order

Place a test order for PDM3M service:
- Use your own email for testing
- Check if license key is returned
- Verify your balance decreased by 1 credit

### 4. Go Live

Once tested successfully:
- Publish services to your customers
- Monitor orders in Dhru panel
- Check balance regularly

---

## Quick API Reference

### Check Balance
```bash
curl -X POST [YOUR_ENDPOINT] \
  -d "username=[USERNAME]" \
  -d "apiaccesskey=[API_KEY]" \
  -d "action=accountinfo" \
  -d "requestformat=JSON"
```

### List Services
```bash
curl -X POST [YOUR_ENDPOINT] \
  -d "username=[USERNAME]" \
  -d "apiaccesskey=[API_KEY]" \
  -d "action=imeiservicelist" \
  -d "requestformat=JSON"
```

### Place Order
```bash
curl -X POST [YOUR_ENDPOINT] \
  -d "username=[USERNAME]" \
  -d "apiaccesskey=[API_KEY]" \
  -d "action=placeimeiorder" \
  -d "requestformat=JSON" \
  -d 'parameters={"ID":"PDM3M","IMEI":"customer@email.com"}'
```

### Get Order Details
```bash
curl -X POST [YOUR_ENDPOINT] \
  -d "username=[USERNAME]" \
  -d "apiaccesskey=[API_KEY]" \
  -d "action=imeiorderdetails" \
  -d "requestformat=JSON" \
  -d 'parameters={"ORDERID":"DH1234567890ABC"}'
```

---

## Pricing

| Service | Duration | Credits | Your Cost |
|---------|----------|---------|-----------|
| PDM3M   | 3 months | 1       | $1.00     |
| PDM6M   | 6 months | 2       | $2.00     |
| PDM12M  | 12 months| 3       | $3.00     |

Set your own selling prices to make profit!

---

## Common Issues

### "Invalid Credentials"
- Check username and API key are correct
- Ensure no extra spaces
- Verify account is active

### "Insufficient Balance"
- Check your balance with accountinfo
- Contact admin to add credits
- Each 3M license = 1 credit, 6M = 2, 12M = 3

### "Service Not Found"
- Verify service ID is exactly: PDM3M, PDM6M, or PDM12M
- Case-sensitive

### License Key Not Received
- Check API response STATUS field
- If SUCCESS, license key is in CODE field
- Use imeiorderdetails to retrieve

---

## Support

- **Full Documentation**: See DHRU-RESELLER-INTEGRATION.md
- **Testing Guide**: See DHRU-API-TESTING.md
- **Admin Support**: Contact your portal administrator
- **Technical Issues**: Check Dhru panel logs

---

## Important Notes

✅ **Instant Delivery**: All licenses delivered immediately  
✅ **Auto Balance**: Credits deducted automatically  
✅ **Secure**: HTTPS required in production  
✅ **24/7 API**: Available anytime  

⚠️ **Keep credentials secret**  
⚠️ **Monitor your balance**  
⚠️ **Test before going live**  
⚠️ **Use correct service IDs**

---

**Quick Start Version**: 1.0  
**Last Updated**: September 27, 2026
