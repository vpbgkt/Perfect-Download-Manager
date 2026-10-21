# Authentication Debug Guide

## Problem
Dashboard shows "authentication_failed" for Balance Overview and Releases pages.

## Steps to Debug

### 1. Check SessionStorage
Open browser console (F12) and run:
```javascript
JSON.parse(sessionStorage.getItem("pdm_account"))
```

Expected output should have:
- `accountId`: string (e.g., "adm_...")
- `role`: string (e.g., "super_admin")
- `resellerAccountId`: string or null
- `token`: JWT string starting with "eyJ..."
- `authMethod`: "password"

### 2. Decode JWT Token
Copy the token from step 1 and paste it at https://jwt.io

Check the payload should have:
- `accountId`: matches sessionStorage
- `role`: matches sessionStorage
- `resellerAccountId`: matches sessionStorage
- `authMethod`: "password"
- `exp`: expiration timestamp (should be in the future)
- `iat`: issued at timestamp

### 3. Check Network Request
1. Open Network tab in dev tools
2. Navigate to /dashboard
3. Find the failing API request (e.g., GET /api/resellers)
4. Click on it and check:
   - **Request Headers** → Should have `Authorization: Bearer eyJ...`
   - **Response** → Should show the actual error

### 4. Check Server Logs
Look at the terminal running `npm run dev` for error messages.

## Common Issues

### Issue 1: Token not being sent
**Symptom:** Network request doesn't have Authorization header
**Fix:** Clear sessionStorage and login again

### Issue 2: JWT verification failing
**Symptom:** Server logs show "invalid_token" or "expired_token"
**Fix:** Check JWT_SECRET environment variable is set correctly

### Issue 3: Role mismatch
**Symptom:** API responds with "not_authorized"
**Fix:** Check if the role in JWT matches what the API endpoint expects

### Issue 4: Wrong key used in DynamoDB update
**Symptom:** "ValidationException: The provided key element does not match the schema"
**Fix:** Verify firebaseUid is being used as the key, not adminId

## Quick Fixes

### Clear everything and start fresh:
```javascript
// Run in browser console
sessionStorage.clear();
localStorage.clear();
window.location.href = '/login';
```

### Force re-login:
```javascript
// Run in browser console
sessionStorage.removeItem('pdm_account');
window.location.reload();
```

## Next Steps

If issue persists after trying above:
1. Copy the exact error from Network tab → Response
2. Copy the JWT token from sessionStorage
3. Copy the server logs from terminal
4. Share all three for further debugging
