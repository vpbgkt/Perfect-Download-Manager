# Phase 1 & 2 Database Deployment Guide

## Overview

This guide covers database schema updates for **Phase 1: Foundation** and **Phase 2: Balance Management**, which introduce:

- Multi-tier account system (Distributor / Reseller / Dealer)
- Password-based authentication
- Balance management with transaction tracking
- Account hierarchy (parent-child relationships)
- Discount system

## Prerequisites

- AWS CLI configured with appropriate credentials
- Access to `ap-south-1` region (or your configured region)
- Existing `pdm-portal-resellers` table

## Database Changes

### Modified Tables

**`pdm-portal-resellers`** - Three new Global Secondary Indexes (GSIs):
- `accountType-index` - Query accounts by type (distributor/reseller/dealer)
- `parentAccountId-index` - Find child accounts
- `contactEmail-index` - Login by email

### New Tables

**`pdm-portal-transactions`** - Balance transaction history:
- Partition key: `transactionId`
- GSI: `accountId-createdAt-index` for querying by account

## Deployment Steps

### Option 1: Fresh Installation (New Database)

If you're setting up from scratch:

```powershell
# Create all tables including new transactions table
.\create-tables.ps1 -Region ap-south-1
```

### Option 2: Update Existing Database (Recommended)

If you have existing reseller accounts:

#### Step 1: Update Schema

```powershell
# Add GSIs to resellers table and create transactions table
.\update-phase1-phase2.ps1 -Region ap-south-1
```

**What it does:**
- ✅ Adds GSIs to `pdm-portal-resellers` (asynchronous operation)
- ✅ Creates `pdm-portal-transactions` table
- ✅ Safe to re-run (checks existence)
- ✅ No data loss - only schema changes

**⏱️ Expected duration:** 5-15 minutes (GSI creation is async)

#### Step 2: Verify GSI Status

Wait for GSIs to become ACTIVE:

```powershell
aws dynamodb describe-table --table-name pdm-portal-resellers --region ap-south-1 --query "Table.GlobalSecondaryIndexes[*].[IndexName,IndexStatus]" --output table
```

You should see:
```
+---------------------------+--------+
| accountType-index         | ACTIVE |
| parentAccountId-index     | ACTIVE |
| contactEmail-index        | ACTIVE |
+---------------------------+--------+
```

#### Step 3: Migrate Existing Data (Dry Run First)

```powershell
# Preview changes without modifying database
.\migrate-existing-accounts.ps1 -Region ap-south-1 -DryRun
```

Review the output, then apply changes:

```powershell
# Apply migrations
.\migrate-existing-accounts.ps1 -Region ap-south-1 -DefaultBalance 1000 -DefaultDiscount 10
```

**Parameters:**
- `-DefaultBalance` - Initial balance for existing accounts (default: 0)
- `-DefaultDiscount` - Discount percentage 0-100 (default: 0)
- `-DryRun` - Preview without changes

**What it does:**
- ✅ Adds `accountType: "reseller"` to existing accounts
- ✅ Sets `balance` and `discountPercent`
- ✅ Idempotent - safe to re-run

**⚠️ Important:**
- The migration does not assign passwords. Accounts without an existing password hash must receive a unique password through an authorized, verified process before login is enabled.

## Verification

### Check Table Structure

```powershell
# List all portal tables
aws dynamodb list-tables --region ap-south-1 --query "TableNames[?starts_with(@, 'pdm-portal-')]" --output table

# Verify resellers table has new GSIs
aws dynamodb describe-table --table-name pdm-portal-resellers --region ap-south-1
```

### Check Migrated Data

```powershell
# Scan first account to verify new fields
aws dynamodb scan --table-name pdm-portal-resellers --region ap-south-1 --limit 1
```

Look for:
- `accountType`: `{ "S": "reseller" }`
- `balance`: `{ "N": "1000" }`
- `discountPercent`: `{ "N": "10" }`
- `passwordHash`: `{ "S": "$2a$..." }`

### Test Transaction Table

```powershell
# Verify transactions table exists and is empty
aws dynamodb scan --table-name pdm-portal-transactions --region ap-south-1 --limit 1
```

## Rollback (If Needed)

### Remove GSIs (Not Recommended)

```powershell
aws dynamodb update-table \
  --table-name pdm-portal-resellers \
  --global-secondary-index-updates '[{"Delete":{"IndexName":"accountType-index"}}]' \
  --region ap-south-1
```

⚠️ **Warning:** Deleting GSIs removes index data. Better to leave them in place.

### Delete Transactions Table

```powershell
aws dynamodb delete-table --table-name pdm-portal-transactions --region ap-south-1
```

## Costs

### GSI Creation
- **One-time backfill cost**: Based on existing data volume
- **Ongoing cost**: Same as base table (read/write capacity or on-demand)

### Transactions Table
- **Storage**: ~0.5 KB per transaction
- **On-demand pricing**: $1.25 per million writes, $0.25 per million reads

### Estimates
- 10K existing accounts + 3 GSIs: ~$2-5 one-time
- 100K transactions/month: ~$0.15/month storage + request costs

## Troubleshooting

### GSI Creation Stuck

```powershell
# Check GSI status
aws dynamodb describe-table --table-name pdm-portal-resellers --region ap-south-1 --query "Table.GlobalSecondaryIndexes[*].IndexStatus"
```

GSI states:
- `CREATING` - In progress (normal, can take 10-30 min)
- `ACTIVE` - Ready to use
- `UPDATING` - Modification in progress

### Migration Script Fails

**Password hash error:**
```powershell
# Install bcryptjs globally
npm install -g bcryptjs

# Or skip password hashing
.\migrate-existing-accounts.ps1 -SkipPasswordHash
```

**Permission denied:**
```powershell
# Check AWS credentials
aws sts get-caller-identity

# Ensure IAM permissions for dynamodb:UpdateItem
```

## Next Steps

After successful deployment:

1. ✅ **Deploy application code** with Phase 1 & 2 changes
2. ✅ **Test password login** with migrated accounts
3. ✅ **Create test transactions** to verify balance system
4. ✅ **Update existing admin UI** to support new fields
5. ✅ **Notify users** to change default passwords

## Support

For issues:
1. Check script output for specific errors
2. Verify AWS CLI configuration: `aws configure list`
3. Review IAM permissions for DynamoDB operations
4. Check CloudWatch logs for DynamoDB throttling

## Files in This Directory

- `update-phase1-phase2.ps1` - Schema update script (GSIs + new table)
- `migrate-existing-accounts.ps1` - Data migration script
- `create-tables.ps1` - Full table creation (updated for Phase 1 & 2)
- `pdm-portal-resellers.json` - Updated resellers table schema
- `pdm-portal-transactions.json` - New transactions table schema
- `README-PHASE1-PHASE2.md` - This file

## Change Log

### Schema Changes
- **pdm-portal-resellers**: Added 3 GSIs, no data modification
- **pdm-portal-transactions**: New table created

### Data Changes
- **accountType**: Added to all existing accounts (default: "reseller")
- **balance**: Added to all existing accounts (configurable, default: 0)
- **discountPercent**: Added to all existing accounts (configurable, default: 0)
- **passwordHash**: Added to all existing accounts (temporary password)

### Backward Compatibility
- ✅ Existing API endpoints continue to work
- ✅ Old account structure supported (defaults applied)
- ✅ No breaking changes to existing functionality
