# Firebase Removal - Testing Checklist

Complete this checklist to verify the Firebase removal and password authentication migration.

## Pre-Testing Setup

### 1. Install Dependencies
```powershell
cd admin-portal
npm install
```

**Expected:** No errors, Firebase packages removed

### 2. Run Database Migration
```powershell
cd deploy/dynamodb
.\migrate-admins-to-password-auth.ps1
```

**Expected:** 
- GSI created successfully
- Existing admin records migrated
- Email addresses normalized to lowercase

### 3. Create Admin Accounts
```powershell
# Create owner admin
.\create-owner-admin.ps1

# Create test distributor (already exists)
# test-distributor@example.invalid with password: [REDACTED: provision a unique credential out-of-band]
```

**Expected:** Admin account created with password hash

---

## Authentication Flow Tests

### Test 1: Admin Login ✓
**Steps:**
1. Start dev server: `npm run dev`
2. Navigate to http://localhost:3000/login
3. Enter credentials:
   - Email: `owner@example.invalid`
   - Password: (the one you set)
4. Click "Continue"

**Expected Results:**
- ✅ No console errors
- ✅ Redirect to `/dashboard`
- ✅ Dashboard loads successfully
- ✅ SessionStorage contains `pdm_account` with JWT token

**Check SessionStorage:**
```javascript
// In browser console:
JSON.parse(sessionStorage.getItem('pdm_account'))
// Should show: { accountId, role, token, ... }
```

### Test 2: Distributor Login ✓
**Steps:**
1. Logout if logged in
2. Navigate to http://localhost:3000/login
3. Enter credentials:
   - Email: `test-distributor@example.invalid`
   - Password: `[REDACTED: provision a unique credential out-of-band]`
4. Click "Continue"

**Expected Results:**
- ✅ No console errors
- ✅ Redirect to `/dashboard`
- ✅ Dashboard loads successfully
- ✅ SessionStorage contains distributor account data

### Test 3: Case-Insensitive Email ✓
**Steps:**
1. Try logging in with different email cases:
   - `OWNER@example.invalid`
   - `Owner@PerfectDownloadManager.com`
   - `owner@PERFECTDOWNLOADMANAGER.COM`

**Expected Results:**
- ✅ All variations work (normalized to lowercase)
- ✅ Successful login for all cases

### Test 4: Invalid Credentials ✓
**Steps:**
1. Try login with wrong password
2. Try login with non-existent email

**Expected Results:**
- ✅ Shows error: "Invalid email or password" or "Authentication failed"
- ✅ Status code: 401
- ✅ No redirect
- ✅ No token in sessionStorage

### Test 5: Empty Fields ✓
**Steps:**
1. Submit form with empty email
2. Submit form with empty password
3. Submit form with both empty

**Expected Results:**
- ✅ Shows validation error
- ✅ Form submission prevented
- ✅ No API call made

---

## Session Management Tests

### Test 6: Dashboard Access (Authenticated) ✓
**Steps:**
1. Login successfully
2. Navigate to various dashboard pages:
   - `/dashboard`
   - `/dashboard/licenses`
   - `/dashboard/accounts`
   - `/dashboard/releases`

**Expected Results:**
- ✅ All pages load successfully
- ✅ No redirects to login
- ✅ Data loads correctly

### Test 7: Dashboard Access (Unauthenticated) ✓
**Steps:**
1. Clear sessionStorage: `sessionStorage.clear()`
2. Navigate to `/dashboard`

**Expected Results:**
- ✅ Redirect to `/login?next=%2Fdashboard`
- ✅ After login, redirect back to `/dashboard`

### Test 8: API Calls with JWT ✓
**Steps:**
1. Login successfully
2. Open Network tab in DevTools
3. Navigate through dashboard pages

**Expected Results:**
- ✅ API calls include `Authorization: Bearer <token>` header
- ✅ API calls return 200 status
- ✅ Data loads correctly

### Test 9: API Calls without JWT ✓
**Steps:**
1. Open new incognito window
2. Navigate to `/dashboard`
3. Check Network tab

**Expected Results:**
- ✅ Page redirects to login immediately
- ✅ No unauthorized API calls made

---

## Logout Tests

### Test 10: Logout Flow ✓
**Steps:**
1. Login successfully
2. Click "Sign out" button
3. Check sessionStorage
4. Try accessing `/dashboard`

**Expected Results:**
- ✅ Redirects to `/login`
- ✅ SessionStorage cleared (`pdm_account` removed)
- ✅ Cannot access dashboard without re-login
- ✅ POST request to `/api/auth/logout` succeeds

### Test 11: Logout from Multiple Tabs ✓
**Steps:**
1. Open 2 tabs with dashboard
2. Logout from one tab
3. Try to use the other tab

**Expected Results:**
- ✅ Both tabs redirect to login (sessionStorage shared)
- ✅ No errors in console

---

## Role-Based Access Tests

### Test 12: Super Admin Access ✓
**Login as:** `owner@example.invalid`

**Expected Access:**
- ✅ Licenses (read, create, revoke)
- ✅ Accounts (read, create, suspend)
- ✅ Releases (read, publish)
- ✅ SEO (read, write)
- ✅ API Keys (create)
- ✅ Admins (create, manage)
- ✅ Audit Log (read)

### Test 13: Distributor Access ✓
**Login as:** `test-distributor@example.invalid`

**Expected Access:**
- ✅ Licenses (read, create, revoke)
- ❌ Releases (no access)
- ❌ SEO (no access)
- ❌ Admins (no access)
- ❌ Audit Log (no access)

---

## Error Handling Tests

### Test 14: Expired Token ✓
**Steps:**
1. Login successfully
2. Manually edit token expiration in JWT (or wait 7 days)
3. Try to access dashboard

**Expected Results:**
- ✅ Redirect to login
- ✅ SessionStorage cleared
- ✅ Error message shown (if applicable)

### Test 15: Invalid Token ✓
**Steps:**
1. Login successfully
2. Manually corrupt the JWT token in sessionStorage
3. Try to access dashboard

**Expected Results:**
- ✅ Redirect to login
- ✅ SessionStorage cleared

### Test 16: Suspended Account ✓
**Steps:**
1. Suspend a distributor account
2. Try to login with that account

**Expected Results:**
- ✅ Shows error: "Account is suspended"
- ✅ Status code: 423 or 401
- ✅ No login allowed

---

## Browser Compatibility Tests

### Test 17: Chrome ✓
- ✅ Login works
- ✅ SessionStorage persists
- ✅ Dashboard loads
- ✅ Logout works

### Test 18: Firefox ✓
- ✅ Login works
- ✅ SessionStorage persists
- ✅ Dashboard loads
- ✅ Logout works

### Test 19: Edge ✓
- ✅ Login works
- ✅ SessionStorage persists
- ✅ Dashboard loads
- ✅ Logout works

### Test 20: Safari (if available) ✓
- ✅ Login works
- ✅ SessionStorage persists
- ✅ Dashboard loads
- ✅ Logout works

---

## Migration Verification

### Test 21: No Firebase References ✓
**Steps:**
```powershell
# Search for Firebase references
Get-ChildItem -Recurse -Include *.ts,*.tsx,*.json | Select-String "firebase" -CaseSensitive
```

**Expected Results:**
- ✅ No Firebase imports in source code
- ✅ No firebase packages in package.json
- ✅ Only references in test files (acceptable)

### Test 22: No OTP References ✓
**Steps:**
```powershell
# Search for OTP references
Get-ChildItem -Recurse -Include *.ts,*.tsx | Select-String "otp|OTP" -CaseSensitive
```

**Expected Results:**
- ✅ No OTP components
- ✅ No OTP routes
- ✅ Only references in test files (acceptable)

### Test 23: Email Normalization ✓
**Steps:**
```powershell
# Check database for mixed-case emails
aws dynamodb scan --table-name pdm-portal-admins --region ap-south-1 --output json | ConvertFrom-Json | ForEach-Object { $_.Items.email.S }
aws dynamodb scan --table-name pdm-portal-resellers --region ap-south-1 --output json | ConvertFrom-Json | ForEach-Object { $_.Items.contactEmail.S }
```

**Expected Results:**
- ✅ All emails in lowercase
- ✅ No mixed-case emails in database

---

## Performance Tests

### Test 24: Login Performance ✓
**Steps:**
1. Open Network tab
2. Login
3. Check timing

**Expected Results:**
- ✅ Login completes in <2 seconds
- ✅ No unnecessary requests
- ✅ JWT generation fast (<200ms)

### Test 25: Page Load Performance ✓
**Steps:**
1. Login
2. Navigate to dashboard pages
3. Check Network tab

**Expected Results:**
- ✅ Pages load in <3 seconds
- ✅ API calls fast (<500ms)
- ✅ No JWT verification delays

---

## Security Tests

### Test 26: JWT Secret Validation ✓
**Steps:**
1. Change JWT_SECRET in .env.local
2. Try to use existing token

**Expected Results:**
- ✅ Token verification fails
- ✅ Redirect to login
- ✅ Must re-login with new secret

### Test 27: Password Security ✓
**Steps:**
1. Check database for stored passwords
2. Verify password hashes

**Expected Results:**
- ✅ No plaintext passwords
- ✅ All passwords stored as bcrypt hashes
- ✅ Hashes start with `$2b$10$`

### Test 28: XSS Protection ✓
**Steps:**
1. Try login with email: `<script>alert('xss')</script>@test.com`
2. Try login with password containing special chars

**Expected Results:**
- ✅ No script execution
- ✅ Input properly sanitized
- ✅ Authentication fails gracefully

---

## Final Verification

### Checklist Summary

- [ ] All authentication tests pass
- [ ] All session management tests pass
- [ ] All logout tests pass
- [ ] All role-based access tests pass
- [ ] All error handling tests pass
- [ ] Browser compatibility verified
- [ ] Migration verification complete
- [ ] Performance acceptable
- [ ] Security verified

### Sign-off

**Tested by:** _______________
**Date:** _______________
**Environment:** _______________
**Result:** PASS / FAIL

### Notes:
_____________________________________________
_____________________________________________
_____________________________________________

---

## Post-Testing Actions

If all tests pass:
1. ✅ Update production .env with JWT_SECRET
2. ✅ Run migration scripts on production database
3. ✅ Create production admin accounts
4. ✅ Deploy updated code
5. ✅ Monitor for errors
6. ✅ Clean up legacy Firebase/OTP fields (optional)

If tests fail:
1. Document failures
2. Review error logs
3. Fix issues
4. Re-run tests
5. Rollback if necessary (see MIGRATION-GUIDE.md)
