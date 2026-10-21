# Database Setup Status

**Date**: September 27, 2026  
**Time**: Setup completed at 13:51 IST

## ✅ Completed Tasks

### 1. pdm-dhru-orders Table
- **Status**: ✅ ACTIVE
- **Table Name**: `pdm-dhru-orders`
- **Primary Key**: `orderId` (String)
- **GSI**: `resellerAccountId-createdAt-index` (ACTIVE)
- **Region**: ap-south-1
- **Billing**: PAY_PER_REQUEST
- **Encryption**: KMS (Enabled)

**Verification Command**:
```bash
aws dynamodb describe-table --table-name pdm-dhru-orders --region ap-south-1 --query 'Table.TableStatus'
```

### 2. pdm-portal-resellers GSI
- **Status**: 🔄 CREATING (will be ACTIVE in ~5-10 minutes)
- **Index Name**: `dhruApiUsername-index`
- **Key**: `dhruApiUsername` (String, HASH)
- **Projection**: ALL
- **Table**: `pdm-portal-resellers`

**Check Status**:
```bash
aws dynamodb describe-table --table-name pdm-portal-resellers --region ap-south-1 --query 'Table.GlobalSecondaryIndexes[?IndexName==`dhruApiUsername-index`].IndexStatus' --output text
```

**Expected**: Should return "ACTIVE" once ready.

## 🎯 Next Steps

### Wait for GSI to Become ACTIVE

The `dhruApiUsername-index` GSI is currently being created. This process usually takes **5-10 minutes**.

**Monitor Progress**:
```bash
# Run this every 2-3 minutes
aws dynamodb describe-table \
  --table-name pdm-portal-resellers \
  --region ap-south-1 \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`dhruApiUsername-index`]' \
  --output table
```

### Once GSI is ACTIVE

1. ✅ **Test the API endpoint**:
   ```bash
   # Start your dev server if not running
   cd admin-portal
   npm run dev
   ```

2. ✅ **Generate test credentials**:
   - Navigate to: `http://localhost:3000/dashboard/api-keys`
   - Scroll to "Dhru API Integration"
   - Enter a reseller account ID
   - Click "Generate Credentials"

3. ✅ **Test API calls**:
   ```bash
   # Replace with your generated credentials
   curl -X POST http://localhost:3000/api/dhru/index.php \
     -d "username=YOUR_USERNAME" \
     -d "apiaccesskey=YOUR_API_KEY" \
     -d "action=accountinfo" \
     -d "requestformat=JSON"
   ```

4. ✅ **Run complete test flow**:
   - Follow the steps in `DHRU-API-TESTING.md`
   - Test all 4 API actions
   - Verify balance deduction
   - Check license generation

## 📊 Database Summary

### Tables Created/Updated:

| Table | Action | Status | Purpose |
|-------|--------|--------|---------|
| `pdm-dhru-orders` | Created | ✅ ACTIVE | Store Dhru API orders |
| `pdm-portal-resellers` | Updated (GSI) | 🔄 CREATING | Query by Dhru username |

### Indexes:

| Index Name | Table | Status | Key |
|-----------|-------|--------|-----|
| `resellerAccountId-createdAt-index` | pdm-dhru-orders | ✅ ACTIVE | resellerAccountId + createdAt |
| `dhruApiUsername-index` | pdm-portal-resellers | 🔄 CREATING | dhruApiUsername |

## 🔍 Verification Checklist

Once GSI is ACTIVE, verify everything works:

- [ ] pdm-dhru-orders table exists and is ACTIVE
- [ ] resellerAccountId-createdAt-index GSI is ACTIVE
- [ ] dhruApiUsername-index GSI is ACTIVE
- [ ] Can generate Dhru credentials via UI
- [ ] accountinfo action returns balance
- [ ] imeiservicelist action returns 3 services
- [ ] placeimeiorder action generates license
- [ ] Balance is deducted correctly
- [ ] License is stored in pdm-licenses table
- [ ] Order is stored in pdm-dhru-orders table
- [ ] Transaction is recorded in pdm-transactions table
- [ ] Audit log is created in pdm-audit-log table

## ⏱️ Timeline

- **13:51 IST**: Started table creation
- **13:51 IST**: pdm-dhru-orders created (ACTIVE)
- **13:51 IST**: dhruApiUsername-index GSI creation started (CREATING)
- **~14:00 IST**: Expected GSI completion (estimate)

## 🆘 Troubleshooting

### If GSI Takes Longer Than Expected

GSI creation time depends on:
- Table size (currently 3 items, should be fast)
- AWS region load
- Other operations on the table

**Normal**: 5-10 minutes  
**Check if stuck**: After 15 minutes, check AWS console

### If GSI Creation Fails

Check for errors:
```bash
aws dynamodb describe-table \
  --table-name pdm-portal-resellers \
  --region ap-south-1 \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`dhruApiUsername-index`]'
```

If failed, you may need to retry the update-table command.

### Test Without Waiting

You can test most functionality immediately:
- Credential generation UI will work
- API endpoint is ready
- Only authentication via username lookup requires the GSI

The system will automatically use the GSI once it becomes ACTIVE.

## 📝 Commands Reference

### Check pdm-dhru-orders Table
```bash
aws dynamodb describe-table --table-name pdm-dhru-orders --region ap-south-1
```

### Check GSI Status
```bash
aws dynamodb describe-table --table-name pdm-portal-resellers --region ap-south-1 --query 'Table.GlobalSecondaryIndexes[?IndexName==`dhruApiUsername-index`].IndexStatus' --output text
```

### List All GSIs on Resellers Table
```bash
aws dynamodb describe-table --table-name pdm-portal-resellers --region ap-south-1 --query 'Table.GlobalSecondaryIndexes[*].{Name:IndexName,Status:IndexStatus}' --output table
```

### Test Query on GSI (once ACTIVE)
```bash
aws dynamodb query \
  --table-name pdm-portal-resellers \
  --index-name dhruApiUsername-index \
  --key-condition-expression "dhruApiUsername = :username" \
  --expression-attribute-values '{":username":{"S":"test_user"}}' \
  --region ap-south-1
```

## ✅ Ready to Proceed?

**Once GSI shows ACTIVE status**, you're ready to:
1. Test the complete Dhru API system
2. Generate credentials for real resellers
3. Deploy to production
4. Onboard resellers

**Documentation to review**:
- `DHRU-README.md` - Start here for overview
- `DHRU-QUICK-START.md` - Setup and testing
- `DHRU-API-TESTING.md` - Complete test procedures
- `DHRU-RESELLER-INTEGRATION.md` - Share with resellers

---

**Current Status**: ✅ Table created, 🔄 GSI creating (wait 5-10 min)  
**Next Action**: Check GSI status in a few minutes, then proceed with testing  
**Estimated Ready Time**: ~14:00 IST (10 minutes from start)
