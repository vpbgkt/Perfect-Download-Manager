# Dhru API Integration - Quick Start Guide

## 🚀 Quick Setup (5 Minutes)

### Step 1: Configure Dhru API Credentials

1. Login as super_admin
2. Go to **Dashboard → API Keys**
3. Find "Dhru API Integration" section
4. Fill in the form:
   ```
   Distributor Account ID: acc_example
   Dhru API URL: https://yoursite.com
   Dhru Username: your-dhru-username
   Dhru API Access Key: XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX
   ```
5. Click **Save Configuration**
6. Click **Test Connection** to verify

✅ Configuration saved successfully!

---

### Step 2: Check Account Balance

**Ensure distributor has PDM credits:**

```bash
# Via UI: Dashboard → Balance widget
# Via API:
curl "http://localhost:3000/api/accounts/acc_xxxxx/balance" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Expected: Balance > 0 credits

---

### Step 3: Browse Available Services

```bash
curl "http://localhost:3000/api/dhru/services?accountId=acc_xxxxx&type=all" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

Copy a service ID for testing (e.g., `1382`)

---

### Step 4: Place Test Order

```bash
curl -X POST "http://localhost:3000/api/dhru/placeorder" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "acc_xxxxx",
    "orderType": "imei",
    "serviceId": "1382",
    "imei": "111111111111116",
    "estimatedCost": 10
  }'
```

✅ Order placed! Balance deducted automatically.

---

### Step 5: Check Order Status

```bash
curl "http://localhost:3000/api/dhru/orders/DH123456?accountId=acc_xxxxx" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## 📊 Balance Deduction Example

**Before Order:**
```json
{
  "accountId": "acc_xxxxx",
  "balance": 100
}
```

**Place Order (Cost: 10 credits)**

**After Order:**
```json
{
  "accountId": "acc_xxxxx",
  "balance": 90,
  "transaction": {
    "type": "debit",
    "amount": 10,
    "reason": "Dhru API imei order - DH123456"
  }
}
```

---

## 🔍 Common Use Cases

### Use Case 1: iPhone IMEI Unlock

```javascript
// Frontend code
const response = await fetch("/api/dhru/placeorder", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`
  },
  body: JSON.stringify({
    accountId: "acc_xxxxx",
    orderType: "imei",
    serviceId: "1382",
    imei: "123456789012345",
    estimatedCost: 15
  })
});

const data = await response.json();
console.log("Order ID:", data.order.dhruOrderId);
console.log("New Balance:", data.transaction.newBalance);
```

### Use Case 2: File-Based Service

```javascript
const response = await fetch("/api/dhru/placeorder", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`
  },
  body: JSON.stringify({
    accountId: "acc_xxxxx",
    orderType: "file",
    serviceId: "2500",
    fileName: "device_data.txt",
    fileData: btoa("file content"), // base64 encode
    estimatedCost: 20
  })
});
```

### Use Case 3: Check Multiple Order Statuses

```javascript
const orderIds = ["DH123456", "DH123457", "DH123458"];

for (const orderId of orderIds) {
  const response = await fetch(
    `/api/dhru/orders/${orderId}?accountId=acc_xxxxx`,
    {
      headers: { "Authorization": `Bearer ${token}` }
    }
  );
  const data = await response.json();
  console.log(`${orderId}: ${data.order.status}`);
}
```

---

## ⚠️ Important Notes

1. **Balance Check**: Always ensure sufficient balance before placing orders
2. **Service Cost**: Fetch actual service cost from service list before ordering
3. **Order Type**: Must specify `imei` or `file` correctly
4. **Test IMEI**: Use `111111111111116` for testing
5. **Error Handling**: Always check response status and handle errors

---

## 🐛 Quick Debugging

### Issue: "Configuration Missing"
→ Configure Dhru API credentials first

### Issue: "Insufficient Balance"  
→ Add credits to distributor account

### Issue: "Order Failed"
→ Check Dhru API response in `dhruResponse` field

### Issue: "Connection Failed"
→ Verify Dhru API URL and credentials

---

## 📞 Need Help?

- **Full Documentation**: See `DHRU-API-INTEGRATION.md`
- **API Reference**: Check endpoint details in main docs
- **Support**: Contact admin with account ID and order ID

---

## ✅ Checklist

Before going live:

- [ ] Dhru API credentials configured
- [ ] Test connection successful
- [ ] Test order placed successfully
- [ ] Balance deduction verified
- [ ] Transaction history shows order
- [ ] Order status can be retrieved
- [ ] Error handling implemented
- [ ] Production credentials updated

---

**Happy coding! 🎉**
