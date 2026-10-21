# Login Fix Test Checklist

## Prerequisites

Restart the development server to apply all code changes:
```powershell
# Stop current server (Ctrl+C if running)
cd admin-portal
npm run dev
```

## Test 1: Verify No Deprecation Warnings ✓

**Expected:** No middleware deprecation warning in console

**Console should NOT show:**
```
⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.
```

**Status:** Should show proxy.ts in startup logs instead

---

## Test 2: Distributor Login (Password Auth) ✓

**URL:** http://localhost:3000/login

**Credentials:**
- Email: `test-distributor@example.invalid`
- Password: `[REDACTED: provision a unique credential out-of-band]`

**Expected Results:**
1. No errors in browser console
2. Server logs show:
   ```
   [login-password] Attempt for email: test-distributor@example.invalid
   [login-password] Authenticator result: { ok: true, error: null }
   [login-password] Generating JWT for: acc_example
   [login-password] Authentication successful
   POST /api/auth/login-password 200
   ```
3. Browser redirects to `/dashboard`
4. SessionStorage contains `pdm_account` with JWT token

**Check SessionStorage:**
Open browser DevTools → Application → Session Storage → http://localhost:3000
Should see `pdm_account` with:
```json
{
  "accountId": "acc_example",
  "resellerAccountId": "acc_example",
  "role": "distributor",
  "authMethod": "password",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

## Test 3: Case-Insensitive Email Login ✓

**URL:** http://localhost:3000/login

**Test with different case variations:**

### Test 3a: All lowercase
- Email: `test-distributor@example.invalid`
- Password: `[REDACTED: provision a unique credential out-of-band]`
- **Expected:** ✅ Success

### Test 3b: Capital D
- Email: `test-distributor@example.invalid`
- Password: `[REDACTED: provision a unique credential out-of-band]`
- **Expected:** ✅ Success (normalized to lowercase)

### Test 3c: All uppercase
- Email: `TEST-DISTRIBUTOR@example.invalid`
- Password: `[REDACTED: provision a unique credential out-of-band]`
- **Expected:** ✅ Success (normalized to lowercase)

---

## Test 4: Wrong Password ✓

**URL:** http://localhost:3000/login

**Credentials:**
- Email: `test-distributor@example.invalid`
- Password: `wrongpassword`

**Expected Results:**
1. Error message: "Authentication failed" or "Invalid email or password"
2. Status code: 401
3. No redirect
4. No token in sessionStorage

---

## Test 5: Non-existent Account ✓

**URL:** http://localhost:3000/login

**Credentials:**
- Email: `nonexistent@example.com`
- Password: `anypassword`

**Expected Results:**
1. Error message: "Authentication failed" or "Invalid email or password"
2. Status code: 401
3. No redirect
4. No token in sessionStorage

---

## Test 6: Proxy Protection ✓

### Test 6a: Unauthenticated Access
1. Open browser in incognito/private mode
2. Navigate to: http://localhost:3000/dashboard
3. **Expected:** Redirect to `/login?next=%2Fdashboard`

### Test 6b: Authenticated Access
1. Login with `test-distributor@example.invalid`
2. Navigate to: http://localhost:3000/dashboard
3. **Expected:** Dashboard loads successfully

### Test 6c: Public Routes (No Redirect)
Test these URLs should NOT redirect (accessible without login):
- http://localhost:3000/login ✓
- http://localhost:3000/verify-otp ✓
- http://localhost:3000/api/health ✓
- http://localhost:3000/robots.txt ✓

---

## Test 7: JWT Token Validation ✓

After successful login, check the JWT token structure:

**Tool:** https://jwt.io

1. Copy token from sessionStorage (`pdm_account.token`)
2. Paste into jwt.io debugger
3. **Expected Decoded Payload:**
   ```json
   {
     "accountId": "acc_example",
     "role": "distributor",
     "resellerAccountId": "acc_example",
     "authMethod": "password",
     "iat": <unix_timestamp>,
     "exp": <unix_timestamp>,
     "iss": "pdm-portal"
   }
   ```

**Verify:**
- ✓ `iss` (issuer) is present and equals "pdm-portal"
- ✓ No duplicate issuer
- ✓ `exp` is ~7 days after `iat`
- ✓ All required fields present

---

## Test 8: Dashboard Access with JWT ✓

After login, test API calls work with JWT token:

**Open Browser DevTools → Network Tab**

1. Navigate to various dashboard pages
2. Check API requests include Authorization header
3. **Expected:** API calls should succeed (200 status)

Example API calls that should work:
- GET /api/auth/session
- GET /api/accounts (if accessible to distributors)
- GET /api/licenses (if accessible to distributors)

---

## Test 9: Logout ✓

1. Click logout button in dashboard
2. **Expected:** 
   - Redirect to /login
   - sessionStorage cleared
   - Cannot access /dashboard (redirects to login)

---

## Test 10: Other Existing Accounts ✓

Test the other accounts in the database still work:

### Test 10a: distributor@example.invalid
- Email: `distributor@example.invalid`
- **Note:** Password unknown - cannot test login
- **Status:** Account exists, normalized to lowercase ✓

### Test 10b: reseller@example.invalid
- Email: `reseller@example.invalid`
- **Status:** Account exists, normalized to lowercase ✓
- **Issue:** No passwordHash - cannot login until password is set

---

## Known Issues

### admin@example.invalid Account Missing

**Issue:** Account does not exist in any table

**Solution Options:**

**Option A: Create as Firebase Admin**
```powershell
# 1. Create Firebase user in console first
# 2. Run script with Firebase UID:
cd admin-portal\deploy\dynamodb
.\create-admin-gsmmeta.ps1 -FirebaseUid "<FIREBASE_UID>"
```

**Option B: Create as Distributor/Reseller**
1. Login with existing admin: `admin@example.invalid`
2. Dashboard → Accounts → Create Account
3. Email: `admin@example.invalid`
4. Password: `[REDACTED: provision a unique credential out-of-band]`
5. Type: distributor/reseller/dealer

---

## Success Criteria

All tests should pass:
- ✅ No deprecation warnings
- ✅ Distributor login successful
- ✅ Case-insensitive email matching works
- ✅ JWT token generated correctly (no duplicate issuer error)
- ✅ Proxy redirects unauthenticated users
- ✅ Dashboard accessible after login
- ✅ Logout works correctly

---

## Rollback (If Needed)

If issues occur, revert these files:
1. `lib/jwt.ts` - JWT token generation
2. `proxy.ts` - Proxy (formerly middleware)
3. `lib/auth.ts` - Email normalization in authentication
4. `lib/accounts.ts` - Email normalization in account creation

**Database rollback:**
```powershell
# Revert email normalization if needed (would require manual SQL or script)
# Not recommended unless absolutely necessary
```
