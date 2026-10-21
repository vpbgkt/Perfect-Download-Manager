# Login Authentication Fix Summary

## Issue Identified
Login was failing with error: `Authentication failed` even with correct credentials.

**Root Cause:** Case-sensitive email matching in DynamoDB queries.
- Stored email: `test-distributor@example.invalid` (capital D)
- Login attempt: `test-distributor@example.invalid` (lowercase d)
- DynamoDB exact match query failed because of case mismatch

## Changes Made

### 1. Code Fixes

#### `lib/auth.ts` - authenticatePassword function (Line ~679)
```typescript
// Before:
const result = await dynamo.query({
  TableName: tables.resellers,
  IndexName: "contactEmail-index",
  KeyConditionExpression: "contactEmail = :email",
  ExpressionAttributeValues: { ":email": input.email.trim() },
});

// After:
// Normalize email to lowercase for case-insensitive matching
const normalizedEmail = input.email.trim().toLowerCase();
const result = await dynamo.query({
  TableName: tables.resellers,
  IndexName: "contactEmail-index",
  KeyConditionExpression: "contactEmail = :email",
  ExpressionAttributeValues: { ":email": normalizedEmail },
});
```

#### `lib/accounts.ts` - createAccount function (Line ~316)
```typescript
// Before:
const record: ResellerAccountRecord = {
  // ...
  contactEmail: contactEmail.value,
  // ...
};

// After:
const record: ResellerAccountRecord = {
  // ...
  contactEmail: contactEmail.value.toLowerCase(), // Normalize email to lowercase
  // ...
};
```

#### `app/api/auth/reset-password/route.ts` (Line ~29)
```typescript
// Before:
const scanResult = await dynamo.scan({
  TableName: "pdm-portal-resellers",
  FilterExpression: "contactEmail = :email",
  ExpressionAttributeValues: {
    ":email": email,
  },
});

// After:
// Normalize email to lowercase for case-insensitive matching
const normalizedEmail = email.toLowerCase();
const scanResult = await dynamo.scan({
  TableName: "pdm-portal-resellers",
  FilterExpression: "contactEmail = :email",
  ExpressionAttributeValues: {
    ":email": normalizedEmail,
  },
});
```

### 2. Database Migration

Created and ran migration script: `deploy/dynamodb/normalize-emails.ps1`

**Results:**
- Updated: 1 record (`test-distributor@example.invalid` → `test-distributor@example.invalid`)
- Skipped: 2 records (already lowercase)

## Current Account Status

### ✅ Working Accounts

1. **test-distributor@example.invalid** (Distributor)
   - Account ID: `acc_example`
   - Type: distributor
   - Status: active
   - Balance: 499
   - Auth: Password-based (uses `/api/auth/login-password`)
   - **Status:** ✅ Ready to use

2. **distributor@example.invalid** (Distributor)
   - Account ID: `acc_example`
   - Type: distributor
   - Status: active
   - Balance: 500

3. **reseller@example.invalid** (Reseller)
   - Account ID: `acc_example`
   - Type: reseller
   - Status: active
   - Balance: 1000
   - **Note:** No passwordHash set - cannot login until password is set

### ❌ Missing Account

**admin@example.invalid** - Does NOT exist in any table
- Not in `pdm-portal-admins` (Firebase admins)
- Not in `pdm-portal-resellers` (distributors/resellers/dealers)

## How to Create admin@example.invalid

### Option 1: As Firebase Admin (Recommended)

This account will have super_admin privileges and use Firebase authentication.

**Steps:**
1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select project: "perfect-download-manager"
3. Navigate to: Authentication → Users
4. Click "Add user"
   - Email: `admin@example.invalid`
   - Password: `[REDACTED: provision a unique credential out-of-band]`
5. Click "Add user" and copy the UID (e.g., `ABC123xyz...`)
6. Run the creation script:
   ```powershell
   cd admin-portal\deploy\dynamodb
   .\create-admin-gsmmeta.ps1 -FirebaseUid "PASTE_UID_HERE"
   ```

### Option 2: As Distributor/Reseller Account

1. Login to admin portal with existing admin: `admin@example.invalid`
2. Navigate to: Dashboard → Accounts
3. Click "Create Account"
4. Fill in:
   - Email: `admin@example.invalid`
   - Password: `[REDACTED: provision a unique credential out-of-band]`
   - Account Type: distributor (or reseller/dealer)
   - Organization Name: (your choice)
5. Click "Create"

## Testing the Fix

### Test test-distributor@example.invalid login:

1. Start the development server:
   ```powershell
   cd admin-portal
   npm run dev
   ```

2. Open browser: http://localhost:3000/login

3. Enter credentials:
   - Email: `test-distributor@example.invalid`
   - Password: `[REDACTED: provision a unique credential out-of-band]`

4. Expected result: ✅ Login successful, redirected to dashboard

### Test admin@example.invalid login:

After creating the account (see above), test with:
- Email: `admin@example.invalid`
- Password: `[REDACTED: provision a unique credential out-of-band]`

## Technical Details

### Authentication Flow

The login form (`components/auth/login-form.tsx`) uses a dual authentication strategy:

1. **First attempt:** Password authentication (`/api/auth/login-password`)
   - For: distributors, resellers, dealers
   - Uses: `pdm-portal-resellers` table
   - Returns: JWT token stored in sessionStorage
   - If 401: Shows error and stops
   - If other error: Falls through to Firebase

2. **Second attempt:** Firebase authentication (if first fails and Firebase is configured)
   - For: admins (super_admin, admin, readonly_admin)
   - Uses: Firebase Authentication + `pdm-portal-admins` table
   - Returns: Session cookie
   - May require OTP verification (if `PORTAL_DISABLE_OTP` is not set)

### Email Normalization Strategy

All emails are now normalized to **lowercase** at:
1. **Input:** When querying for authentication
2. **Storage:** When creating new accounts
3. **Migration:** Existing records updated to lowercase

This ensures RFC 5321 compliance (email local-part is case-insensitive per standard practice).

## Files Modified

1. `admin-portal/lib/auth.ts` - authenticatePassword normalization
2. `admin-portal/lib/accounts.ts` - createAccount normalization
3. `admin-portal/app/api/auth/reset-password/route.ts` - reset password normalization
4. `admin-portal/deploy/dynamodb/normalize-emails.ps1` - New migration script
5. `admin-portal/deploy/dynamodb/create-admin-gsmmeta.ps1` - New helper script

## Restart Required

After these code changes, restart your Next.js development server:
```powershell
# Stop the current server (Ctrl+C)
# Then restart:
npm run dev
```

The changes affect server-side code, so HMR won't apply them without a restart.
