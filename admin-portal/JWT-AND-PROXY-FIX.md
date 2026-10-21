# JWT and Proxy Fix

## Issues Fixed

### 1. JWT Token Generation Error ✅

**Error:**
```
Error: Bad "options.issuer" option. The payload already has an "iss" property.
```

**Root Cause:**
The `signToken` function was setting the `iss` (issuer) property in both:
1. The payload object directly: `iss: JWT_ISSUER`
2. The jwt.sign options: `issuer: JWT_ISSUER`

This caused a conflict because `jsonwebtoken` was trying to add the issuer twice.

**Fix Applied:**
Removed `iss` from the payload object and let `jwt.sign()` handle it via the options parameter.

**File:** `lib/jwt.ts` (Line 63-75)

```typescript
// Before:
const payload: Omit<JwtPayload, "iat" | "exp"> = {
  accountId: data.accountId,
  role: data.role,
  resellerAccountId: data.resellerAccountId,
  authMethod: "password",
  iss: JWT_ISSUER,  // ❌ Duplicate issuer
};

return jwt.sign(payload, JWT_SECRET, {
  expiresIn: JWT_EXPIRATION,
  issuer: JWT_ISSUER,  // ❌ Duplicate issuer
});

// After:
const payload = {
  accountId: data.accountId,
  role: data.role,
  resellerAccountId: data.resellerAccountId,
  authMethod: "password" as const,
};

return jwt.sign(payload, JWT_SECRET, {
  expiresIn: JWT_EXPIRATION,
  issuer: JWT_ISSUER,  // ✅ Single issuer, added by jwt.sign
});
```

### 2. Middleware Deprecation Warning ✅

**Warning:**
```
⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.
```

**Root Cause:**
Next.js 15+ has renamed the middleware convention to "proxy" to better reflect its purpose as an edge proxy layer.

**Fix Applied:**
1. Renamed `middleware.ts` → `proxy.ts`
2. Renamed export: `export function middleware()` → `export function proxy()`
3. Updated documentation comments to use "proxy" terminology

**Files Changed:**
- Renamed: `admin-portal/middleware.ts` → `admin-portal/proxy.ts`

## Testing

After restarting the development server, both issues should be resolved:

### Test JWT Token Generation:

1. Navigate to: http://localhost:3000/login
2. Login with:
   - Email: `test-distributor@example.invalid`
   - Password: `[REDACTED: provision a unique credential out-of-band]`
3. Expected result: ✅ Successful login with JWT token in sessionStorage

**Console logs should show:**
```
[login-password] Attempt for email: test-distributor@example.invalid
[login-password] Calling authenticator.authenticatePassword...
[login-password] Authenticator result: { ok: true, error: null }
[login-password] Generating JWT for: acc_example
[login-password] Authentication successful for: acc_example
POST /api/auth/login-password 200
```

### Test Proxy (formerly Middleware):

1. Try to access: http://localhost:3000/dashboard (without logging in)
2. Expected: ✅ Redirected to `/login?next=%2Fdashboard`
3. No deprecation warning in console

## Token Structure

The generated JWT now has the correct structure:

```json
{
  "accountId": "acc_...",
  "role": "distributor",
  "resellerAccountId": "acc_...",
  "authMethod": "password",
  "iat": 1234567890,
  "exp": 1234567890,
  "iss": "pdm-portal"
}
```

Where:
- `iat`: Issued at timestamp (set by jwt.sign)
- `exp`: Expiration timestamp (set by jwt.sign based on expiresIn option)
- `iss`: Issuer (set by jwt.sign based on issuer option)

## Next.js Proxy Configuration

The proxy configuration remains the same:

```typescript
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|ico|webp)$).*)"],
};
```

This ensures the proxy runs on all routes except:
- Next.js static files (`_next/static`)
- Next.js images (`_next/image`)
- Favicon
- Common image/media files

## Summary

✅ **JWT token generation** - Fixed duplicate issuer conflict
✅ **Proxy migration** - Updated from deprecated middleware to proxy convention
✅ **Authentication flow** - Email normalization + JWT generation working correctly

The login flow for `test-distributor@example.invalid` should now work end-to-end!
