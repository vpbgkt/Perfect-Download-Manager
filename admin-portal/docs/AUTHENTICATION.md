# PDM Portal Authentication

## Overview

The PDM Admin Portal uses **unified password-based JWT authentication** for all users. All account types (admins, distributors, resellers, and dealers) authenticate using email and password, receiving a JWT token for subsequent requests.

## Authentication Flow

```
┌─────────────┐
│   Browser   │
└──────┬──────┘
       │
       │ 1. POST /api/auth/login-password
       │    { email, password }
       │
       ▼
┌─────────────────────────────────┐
│  Login Route Handler            │
│  - Normalize email to lowercase │
│  - Check admin table (email-index GSI) │
│  - Check reseller table (contactEmail-index GSI) │
│  - Verify password (bcrypt)     │
│  - Generate JWT token (7 days)  │
└──────┬──────────────────────────┘
       │
       │ 2. { success: true, token, account }
       │
       ▼
┌─────────────┐
│   Browser   │
│ - Store JWT in sessionStorage   │
│ - Redirect to dashboard         │
└──────┬──────┘
       │
       │ 3. Subsequent API requests
       │    Authorization: Bearer <JWT>
       │
       ▼
┌─────────────────────────────┐
│  Protected API Routes       │
│  - Extract JWT from header  │
│  - Verify JWT signature     │
│  - Check expiration         │
│  - Authorize action         │
└─────────────────────────────┘
```

## Account Types & Tables

### Admin Accounts (`pdm-portal-admins` table)

**Roles:**
- `super_admin` - Full system access
- `admin` - Standard administrative access
- `readonly_admin` - Read-only access

**Key Fields:**
- `adminId` (Primary Key) - Unique admin identifier (e.g., `adm_uuid`)
- `email` - Normalized to lowercase, unique
- `passwordHash` - Bcrypt hash of password
- `role` - Admin role
- `createdAt` - Account creation timestamp
- `lastSeenAt` - Last login timestamp

**GSI:**
- `email-index` - Query admins by email (used for login)

### Reseller/Distributor/Dealer Accounts (`pdm-portal-resellers` table)

**Roles:**
- `distributor` - Can create reseller accounts
- `reseller` - Can create dealer accounts
- `dealer` - End-user accounts

**Key Fields:**
- `resellerAccountId` (Primary Key) - Unique account ID (e.g., `acc_uuid`)
- `contactEmail` - Normalized to lowercase
- `passwordHash` - Bcrypt hash of password
- `accountType` - One of: distributor, reseller, dealer
- `orgName` - Organization name
- `state` - `active` or `suspended`
- `balance` - Account balance for license purchases
- `discountPercent` - Discount percentage
- `parentAccountId` - Parent account in hierarchy

**GSI:**
- `contactEmail-index` - Query accounts by email (used for login)

## JWT Token Structure

```json
{
  "accountId": "acc_uuid",
  "email": "user@example.invalid",
  "role": "super_admin",
  "resellerAccountId": "acc_uuid",
  "authMethod": "password",
  "sessionVersion": 0,
  "iat": 1234567890,
  "exp": 1235172690,
  "iss": "pdm-portal"
}
```

**Fields:**
- `accountId` - Account identifier (adminId or resellerAccountId)
- `email` - Normalized account email, checked against the current account record
- `role` - Authorization role
- `resellerAccountId` - For resellers/distributors/dealers, same as accountId; null for admins
- `authMethod` - Always "apikey" (legacy field)
- `iat` - Issued at (Unix timestamp)
- `exp` - Expiration (Unix timestamp, 7 days from iat)
- `iss` - Issuer ("pdm-portal")
- `sessionVersion` - Server-side generation; logout and account suspension revoke older tokens

**Token Storage:** `sessionStorage.pdm_account`

```json
{
  "accountId": "acc_uuid",
  "resellerAccountId": "acc_uuid",
  "role": "distributor",
  "authMethod": "password",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

## Creating Accounts

### Creating Admin Accounts

Use the PowerShell script:

```powershell
cd admin-portal/deploy/dynamodb

# Create owner admin
.\create-owner-admin.ps1

# Or create any admin
.\create-admin-password.ps1 -Email "admin@example.com" -Password "SecurePass123!" -Role "super_admin"
```

### Creating Distributor/Reseller/Dealer Accounts

Via the admin portal UI:
1. Login as super_admin or admin
2. Navigate to Dashboard → Accounts
3. Click "Create Account"
4. Fill in details and submit

Via API (programmatically):
```typescript
POST /api/accounts
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{
  "accountType": "distributor",
  "orgName": "Example Corp",
  "contactEmail": "contact@example.com",
  "password": "<unique-password-at-least-12-characters>",
  "discountPercent": 10,
  "initialBalance": 1000
}
```

## Password Requirements

- Minimum 12 characters for account provisioning
- Should include mix of uppercase, lowercase, numbers, special characters
- Stored as bcrypt hash with 10 rounds (~100ms per hash)

## Security Features

### Password Hashing
- **Algorithm:** bcrypt
- **Rounds:** 10
- **Salt:** Automatically generated per password

### JWT Revocation
- Protected requests verify the JWT and re-check the account's current role and status.
- Logout increments the account's session version, invalidating all previously issued JWTs for that account.
- Suspending or reactivating a reseller account also advances the session version.

### Email Normalization
- All emails normalized to lowercase
- Prevents case-sensitive duplicate accounts
- Consistent lookup behavior

### JWT Security
- **Algorithm:** HS256 (HMAC-SHA256)
- **Secret:** Configured via `JWT_SECRET` environment variable
- **Expiration:** 7 days
- **Issuer verification:** Ensures token was issued by this portal

### Token Storage
- **Client:** sessionStorage (cleared on browser close)
- **Server:** Stateless (no session storage)

### API Protection
- All protected routes require valid JWT in Authorization header
- Token signature verified on every request
- Expired tokens rejected with 401
- Invalid/malformed tokens rejected with 401

## Authentication Endpoints

### POST /api/auth/login-password

**Purpose:** Authenticate with email + password

**Request:**
```json
{
  "email": "user@example.com",
  "password": "<unique-password-at-least-12-characters>"
}
```

**Success Response (200):**
```json
{
  "success": true,
  "token": "eyJhbGciOi...",
  "account": {
    "accountId": "acc_uuid",
    "resellerAccountId": "acc_uuid",
    "role": "distributor",
    "authMethod": "apikey"
  }
}
```

**Error Response (401):**
```json
{
  "error": "authentication_failed",
  "message": "Authentication failed"
}
```

**Error Response (423):**
```json
{
  "error": "not_authorized",
  "message": "Account is suspended"
}
```

### POST /api/auth/logout

**Purpose:** End session (client-side token clearing)

**Request:**
```json
{}
```

**Response (200):**
```json
{
  "status": "logged_out"
}
```

## Client-Side Session Management

### SessionProvider Component

Located in `components/dashboard/session-provider.tsx`

**Responsibilities:**
- Load session from sessionStorage on mount
- Validate token exists
- Redirect to login if missing/invalid
- Provide session context to child components

**Usage:**
```tsx
import { useSession } from '@/components/dashboard/session-provider';

function MyComponent() {
  const { session, loading, error } = useSession();
  
  if (loading) return <Spinner />;
  if (error) return <Error message={error} />;
  if (!session) return null;
  
  return <div>Welcome, {session.role}!</div>;
}
```

### Logout Flow

```typescript
// 1. Clear sessionStorage
sessionStorage.removeItem('pdm_account');

// 2. Call logout API
await fetch('/api/auth/logout', { method: 'POST' });

// 3. Redirect to login
window.location.assign('/login');
```

## Role-Based Access Control (RBAC)

Defined in `lib/rbac.ts`

**Permission System:**
```typescript
type Permission =
  | "license:read"
  | "license:create"
  | "license:revoke"
  | "release:read"
  | "release:publish"
  | "seo:read"
  | "seo:write"
  | "reseller:manage"
  | "admin:manage"
  | "apikey:create"
  | "audit:read";
```

**Role Permissions:**

| Permission | super_admin | admin | readonly_admin | distributor | reseller | dealer |
|-----------|-------------|-------|----------------|-------------|----------|--------|
| license:read | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| license:create | ✓ | ✓ | | ✓ | ✓ | ✓ |
| license:revoke | ✓ | ✓ | | ✓ | ✓ | |
| release:read | ✓ | ✓ | ✓ | | | |
| release:publish | ✓ | ✓ | | | | |
| seo:read | ✓ | ✓ | ✓ | | | |
| seo:write | ✓ | ✓ | | | | |
| reseller:manage | ✓ | ✓ | | | | |
| admin:manage | ✓ | | | | | |
| apikey:create | ✓ | ✓ | | | | |
| audit:read | ✓ | ✓ | ✓ | | | |

## Local Development

### In-Memory Mode

Set `PORTAL_LOCAL_DEV=1` in `.env.local` to use in-memory DynamoDB:

```bash
PORTAL_LOCAL_DEV=1
DEV_ADMIN_EMAIL=admin@example.com
DEV_ADMIN_PASSWORD=
DEV_ADMIN_ROLE=super_admin
```

**Features:**
- No AWS credentials required
- Data resets on server restart
- Pre-seeded admin account
- Perfect for UI development

### Production Mode (Local)

Set `PORTAL_LOCAL_DEV=0` and configure AWS:

```bash
PORTAL_LOCAL_DEV=0
AWS_REGION=ap-south-1
# Use AWS CLI credentials or explicit keys
```

## Troubleshooting

### "Authentication failed" on login

**Possible causes:**
1. Wrong email or password
2. Email case mismatch (should be lowercase)
3. Account doesn't exist
4. Password hash not set

**Solutions:**
```powershell
# Recreate admin account with password
cd admin-portal/deploy/dynamodb
.\create-admin-password.ps1 -Email "user@example.com" -Password "NewPassword123!"
```

### "Not signed in" error in dashboard

**Possible causes:**
1. JWT token expired (>7 days)
2. SessionStorage cleared
3. JWT secret changed

**Solutions:**
1. Login again
2. Check browser DevTools → Application → Session Storage → pdm_account
3. Verify JWT_SECRET hasn't changed

### Token verification fails

**Possible causes:**
1. JWT_SECRET mismatch between environments
2. Token tampered with
3. Token expired

**Solutions:**
1. Ensure JWT_SECRET is consistent
2. Login again to get fresh token
3. Check token expiration: https://jwt.io

### Email not found during login

**Possible causes:**
1. Email not normalized in database
2. GSI not created
3. Wrong table

**Solutions:**
```powershell
# Run migration script to normalize emails
cd admin-portal/deploy/dynamodb
.\migrate-admins-to-password-auth.ps1
```

## Migration from Firebase

See [MIGRATION-GUIDE.md](../deploy/dynamodb/MIGRATION-GUIDE.md) for complete migration instructions from Firebase authentication to password-based authentication.

## Security Best Practices

1. **JWT Secret**
   - Generate strong random secret: `openssl rand -hex 32`
   - Never commit to version control
   - Rotate periodically in production
   - Use different secrets per environment

2. **Passwords**
   - Enforce minimum 12 characters
   - Require complexity (uppercase, lowercase, numbers, special chars)
   - Never log passwords
   - Use bcrypt with ≥10 rounds

3. **Token Storage**
   - Use sessionStorage (clears on browser close)
   - Never store in localStorage (persists after close)
   - Never store in cookies without HttpOnly flag

4. **HTTPS**
   - Always use HTTPS in production
   - JWT tokens contain sensitive data
   - Prevent man-in-the-middle attacks

5. **Account Lockout**
   - Consider implementing after N failed attempts
   - Currently not implemented (removed with OTP)
   - Could be added to authenticatePassword if needed

6. **Password Reset**
   - Implement secure password reset flow
   - Send reset links via email
   - Use time-limited tokens
   - Password reset is not available through an unauthenticated endpoint. Use an authorized, verified password setup process.

## API Integration

### Using JWT in API Calls

```typescript
const token = JSON.parse(sessionStorage.getItem('pdm_account') || '{}').token;

const response = await fetch('/api/licenses', {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
});
```

### Handling 401 Unauthorized

```typescript
if (response.status === 401) {
  // Token expired or invalid
  sessionStorage.removeItem('pdm_account');
  window.location.assign('/login');
}
```

## References

- JWT: https://jwt.io/
- bcrypt: https://www.npmjs.com/package/bcryptjs
- Next.js authentication: https://nextjs.org/docs/authentication
- OWASP Password Storage: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
