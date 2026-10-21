# Firebase to Password Authentication Migration Guide

This guide walks you through migrating your PDM Admin Portal from Firebase authentication to unified password-based JWT authentication.

## Overview

**Before:** Dual authentication system
- Admins: Firebase + OTP via email
- Distributors/Resellers/Dealers: Password + JWT

**After:** Unified authentication system
- All users: Password + JWT
- No Firebase dependency
- No OTP/email requirement

## Prerequisites

- Node.js and npm installed
- AWS CLI configured with credentials
- Access to `pdm-portal-admins` DynamoDB table in `ap-south-1`
- PowerShell (for Windows) or bash (for Linux/Mac)

## Migration Steps

### Step 1: Backup Current Data

```powershell
# Backup existing admin accounts
aws dynamodb scan --table-name pdm-portal-admins --region ap-south-1 --output json > admins-backup-$(Get-Date -Format 'yyyyMMdd-HHmmss').json
```

### Step 2: Update DynamoDB Table Schema

Run the migration script to add the email-index GSI:

```powershell
cd deploy/dynamodb
.\migrate-admins-to-password-auth.ps1
```

This script will:
1. Add `email-index` GSI to the table
2. Add `adminId` field to existing records
3. Normalize email addresses to lowercase

**Expected output:**
```
Scanning pdm-portal-admins table for email normalization...
Found 1 admin(s)
Backed up to: pdm-portal-admins-backup-YYYYMMDD-HHmmss.json

Step 2: Creating email-index GSI on existing table...
GSI is now ACTIVE

Step 3: Migrating existing admin records...
Processing: admin@example.invalid
  Updated: adminId=example-firebase-uid, email=admin@example.invalid

Migration complete
```

### Step 3: Create Admin Accounts with Passwords

#### For the primary admin (owner@example.invalid):

```powershell
cd deploy/dynamodb
.\create-admin-password.ps1 -Email "owner@example.invalid" -Password "YourSecurePassword123!"
```

#### For additional admins:

```powershell
.\create-admin-password.ps1 -Email "admin@example.com" -Password "SecurePass123!" -Role "admin"
```

**Available roles:**
- `super_admin` - Full access (default)
- `admin` - Standard admin access
- `readonly_admin` - Read-only access

### Step 4: Install Updated Dependencies

Remove Firebase packages and install dependencies:

```powershell
cd admin-portal
npm install
```

This will remove:
- `firebase`
- `firebase-admin`
- `resend`

### Step 5: Update Environment Variables

Edit `.env.local` and remove Firebase/OTP variables:

**Remove these lines:**
```bash
# Firebase (NO LONGER NEEDED)
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...
GOOGLE_APPLICATION_CREDENTIALS=...

# Resend/OTP (NO LONGER NEEDED)
RESEND_API_KEY=...
OTP_EMAIL_FROM=...
PORTAL_DISABLE_OTP=...

# Dev Firebase (NO LONGER NEEDED)
DEV_ADMIN_UID=...
```

**Update these lines:**
```bash
# Dev admin for local development
DEV_ADMIN_EMAIL=
DEV_ADMIN_PASSWORD=
DEV_ADMIN_ROLE=super_admin
```
Set a local-only email and a unique password of at least 12 characters before enabling local development mode.

**Keep these:**
```bash
# AWS (STILL NEEDED)
AWS_REGION=ap-south-1
# AWS_ACCESS_KEY_ID=
# AWS_SECRET_ACCESS_KEY=

# Release publishing (STILL NEEDED)
RELEASE_BUCKET=
UPDATES_SIGNING_KEY_PARAM=

# MODE
PORTAL_LOCAL_DEV=0

# JWT Secret (STILL NEEDED)
JWT_SECRET=
```
Generate `JWT_SECRET` locally with a cryptographically secure random generator; use at least 32 characters.

### Step 6: Test Login

Start the development server:

```powershell
npm run dev
```

Navigate to http://localhost:3000/login

**Test accounts:**
- Email: `owner@example.invalid`
- Password: (the password you set in Step 3)

OR

- Email: `test-distributor@example.invalid`
- Password: `[REDACTED: provision a unique credential out-of-band]`

### Step 7: Verify All Functionality

Test the following:
- ✅ Admin login
- ✅ Distributor login  
- ✅ Dashboard access
- ✅ License management
- ✅ Account management
- ✅ API key creation
- ✅ Audit logs
- ✅ Logout

## Rollback Plan

If you need to rollback:

### 1. Restore package.json

```powershell
git checkout package.json
npm install
```

### 2. Restore Firebase configuration

```powershell
git checkout .env.local
git checkout lib/firebase-client.ts
git checkout firebase-service-account.json
```

### 3. Restore code files

```powershell
git checkout lib/auth.ts
git checkout lib/server-context.ts
git checkout components/auth/login-form.tsx
git checkout components/dashboard/session-provider.tsx
git checkout models/api-client.ts
git checkout proxy.ts
```

### 4. Restore DynamoDB data (if needed)

```powershell
# Use the backup file created in Step 1
aws dynamodb batch-write-item --request-items file://admins-backup-YYYYMMDD-HHmmss.json --region ap-south-1
```

## Troubleshooting

### Issue: "Authentication failed" on login

**Cause:** Password hash not set or incorrect email

**Solution:**
```powershell
# Recreate the admin with password
.\create-admin-password.ps1 -Email "your-email@example.com" -Password "YourPassword123!"
```

### Issue: "Not signed in" error in dashboard

**Cause:** SessionStorage not set or cleared

**Solution:**
1. Open browser DevTools (F12)
2. Go to Application → Session Storage
3. Check for `pdm_account` entry
4. If missing, try logging in again
5. Clear browser cache and try again

### Issue: GSI creation timeout

**Cause:** DynamoDB GSI creation takes time

**Solution:**
```powershell
# Check GSI status
aws dynamodb describe-table --table-name pdm-portal-admins --region ap-south-1 --query "Table.GlobalSecondaryIndexes[?IndexName=='email-index'].IndexStatus"
```

Wait until status shows `ACTIVE`, then continue.

### Issue: npm install fails

**Cause:** Package lock file conflicts

**Solution:**
```powershell
rm package-lock.json
npm install
```

## Post-Migration Cleanup

After successful migration and verification:

### 1. Remove Firebase project (optional)

If you no longer need Firebase:
1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project
3. Project Settings → Delete Project

### 2. Remove OTP/MFA fields from admin records

After confirming all admins can login with passwords:

```powershell
# Script to clean up OTP-related fields
aws dynamodb scan --table-name pdm-portal-admins --region ap-south-1 | ConvertFrom-Json | ForEach-Object {
  $_.Items | ForEach-Object {
    $adminId = $_.adminId.S
    aws dynamodb update-item `
      --table-name pdm-portal-admins `
      --key "{`"adminId`":{`"S`":`"$adminId`"}}" `
      --update-expression "REMOVE otpHash, otpExpiresAt, otpAttempts, failedOtp, failedOtpWindowStart, lockUntil, sessionTtl" `
      --region ap-south-1
  }
}
```

### 3. Remove legacy firebaseUid field

Once all admins are using password auth:

```powershell
aws dynamodb scan --table-name pdm-portal-admins --region ap-south-1 | ConvertFrom-Json | ForEach-Object {
  $_.Items | ForEach-Object {
    $adminId = $_.adminId.S
    aws dynamodb update-item `
      --table-name pdm-portal-admins `
      --key "{`"adminId`":{`"S`":`"$adminId`"}}" `
      --update-expression "REMOVE firebaseUid" `
      --region ap-south-1
  }
}
```

## Benefits After Migration

✅ **Simpler architecture** - Single authentication method for all users
✅ **Fewer dependencies** - No Firebase or Resend
✅ **Easier onboarding** - Create admins same way as distributors
✅ **Lower costs** - No Firebase subscription
✅ **Unified codebase** - Less complexity, easier to maintain
✅ **No external auth** - All authentication self-contained

## Support

If you encounter issues during migration:

1. Check the console logs for errors
2. Verify DynamoDB table structure
3. Confirm environment variables are set correctly
4. Review the troubleshooting section above
5. Check git history for reference: `git log --oneline --grep="Firebase"`

## Migration Checklist

- [ ] Backup existing admin data
- [ ] Run table migration script
- [ ] Create admin accounts with passwords
- [ ] Update package.json dependencies
- [ ] Update .env.local configuration
- [ ] Test admin login
- [ ] Test distributor login
- [ ] Verify dashboard functionality
- [ ] Test API calls
- [ ] Verify session persistence
- [ ] Test logout functionality
- [ ] Update documentation
- [ ] Deploy to production
- [ ] Monitor for errors
- [ ] Clean up legacy fields (optional)

## Complete!

Your portal is now using unified password-based JWT authentication for all users. 🎉
