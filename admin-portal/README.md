# PDM Admin & Reseller Portal

Web-based administration portal for Perfect Download Manager. Supports license management, account management, release publishing, and more.

## Features

- ✅ **Unified Authentication** - Password + JWT for all users
- ✅ **License Management** - Create, view, revoke licenses
- ✅ **Account Management** - Manage admins, distributors, resellers, dealers
- ✅ **Release Publishing** - Publish and sign software updates
- ✅ **API Key Management** - Generate API keys for reseller integration
- ✅ **Audit Logging** - Track all administrative actions
- ✅ **SEO Management** - Edit marketing site metadata
- ✅ **Role-Based Access Control** - Fine-grained permissions

## Quick Start

### Prerequisites

- Node.js 18+ and npm
- AWS CLI configured with credentials
- Access to DynamoDB tables in `ap-south-1` region

### Installation

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.local.example .env.local

# Edit .env.local and set:
# - JWT_SECRET (generate with: openssl rand -hex 32; use at least 32 characters)
# - AWS credentials (or use AWS CLI profile)
```

### Database Setup

```powershell
# Run migration to set up admin table
cd deploy/dynamodb
.\migrate-admins-to-password-auth.ps1

# Create owner admin account
.\create-owner-admin.ps1
# When prompted, enter a secure password
```

### Development

```bash
# Start development server
npm run dev

# Open browser
# Navigate to: http://localhost:3000/login
# Login with the admin credentials you created
```

### Production Build

```bash
# Build for production
npm run build

# Start production server
npm start
```

## Authentication

All users authenticate with **email + password** and receive a **JWT token** (7-day expiration).

**Account Types:**
- **Admins** - Manage system (super_admin, admin, readonly_admin)
- **Distributors** - Create reseller accounts
- **Resellers** - Create dealer accounts  
- **Dealers** - Purchase and manage licenses

See [docs/AUTHENTICATION.md](docs/AUTHENTICATION.md) for complete details.

## Project Structure

```
admin-portal/
├── app/                    # Next.js app directory
│   ├── api/               # API routes
│   │   ├── auth/         # Authentication endpoints
│   │   ├── accounts/     # Account management
│   │   ├── licenses/     # License management
│   │   └── ...
│   ├── dashboard/        # Dashboard pages
│   └── login/            # Login page
├── components/            # React components
│   ├── auth/            # Authentication components
│   ├── dashboard/       # Dashboard components
│   └── ui/              # Reusable UI components
├── lib/                   # Core business logic
│   ├── auth.ts          # Authentication & authorization
│   ├── accounts.ts      # Account management
│   ├── licenses.ts      # License management
│   ├── jwt.ts           # JWT token generation/verification
│   ├── dynamo.ts        # DynamoDB client
│   └── ...
├── deploy/                # Deployment scripts
│   └── dynamodb/        # DynamoDB table schemas & migrations
├── docs/                  # Documentation
└── test/                  # Tests
```

## Environment Variables

```bash
# Required
JWT_SECRET=
AWS_REGION=ap-south-1

# Optional (uses AWS CLI profile if not set)
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=

# Release publishing
RELEASE_BUCKET=
UPDATES_SIGNING_KEY_PARAM=

# Local development
PORTAL_LOCAL_DEV=0
DEV_ADMIN_EMAIL=
DEV_ADMIN_PASSWORD=
DEV_ADMIN_ROLE=super_admin
```

Set a unique `DEV_ADMIN_EMAIL` and a locally generated `DEV_ADMIN_PASSWORD` of at least 12 characters before enabling local development mode. Never reuse production credentials.

## Scripts

```bash
# Development
npm run dev          # Start dev server with hot reload

# Production
npm run build        # Build for production
npm start            # Start production server

# Testing
npm test             # Run tests

# Linting
npm run lint         # Run ESLint
```

## API Documentation

### Authentication

- `POST /api/auth/login-password` - Login with email/password
- `POST /api/auth/logout` - Logout (clear token)

### Licenses

- `GET /api/licenses` - List licenses
- `POST /api/licenses` - Create license
- `GET /api/licenses/:key` - Get license details
- `POST /api/licenses/:key/revoke` - Revoke license

### Accounts

- `GET /api/accounts` - List accounts
- `POST /api/accounts` - Create account
- `POST /api/accounts/:id/suspend` - Suspend account
- `POST /api/accounts/:id/reactivate` - Reactivate account

### API Keys

- `GET /api/apikeys` - List API keys
- `POST /api/apikeys` - Generate API key
- `POST /api/apikeys/:id/revoke` - Revoke API key

### Releases

- `GET /api/release` - Get latest release
- `POST /api/release` - Publish new release

All API endpoints require `Authorization: Bearer <jwt-token>` header.

## Database Tables

### pdm-portal-admins
- Primary Key: `adminId`
- GSI: `email-index` (email)
- Fields: adminId, email, passwordHash, role, createdAt, lastSeenAt

### pdm-portal-resellers
- Primary Key: `resellerAccountId`
- GSI: `contactEmail-index` (contactEmail)
- Fields: resellerAccountId, accountType, orgName, contactEmail, passwordHash, state, balance, discountPercent, parentAccountId

### pdm-licenses
- Primary Key: `licenseKey`
- GSI: `resellerAccountId-index` (resellerAccountId)
- Fields: licenseKey, status, type, maxActivations, resellerAccountId, customerName, customerEmail, createdAt, expiresAt

### pdm-portal-apikeys
- Primary Key: `apiKeyId`
- GSI: `secretHash-index` (secretHash)
- Fields: apiKeyId, resellerAccountId, secretHash, state, rateLimitPerSec, monthlyQuota

### pdm-portal-audit
- Primary Key: `auditId`
- Fields: auditId, actor, actorRole, action, target, sourceIp, timestamp, changes

## User Management

### Creating Admin Accounts

```powershell
cd deploy/dynamodb

# Create owner admin
.\create-owner-admin.ps1

# Create other admins
.\create-admin-password.ps1 -Email "admin@example.com" -Password "SecurePass!" -Role "admin"
```

### Creating Reseller/Distributor Accounts

Via UI:
1. Login as super_admin or admin
2. Navigate to Dashboard → Accounts
3. Click "Create Account"
4. Fill in details and submit

Via API:
```bash
POST /api/accounts
Authorization: Bearer <admin-jwt>
Content-Type: application/json

{
  "accountType": "distributor",
  "orgName": "Example Corp",
  "contactEmail": "contact@example.com",
  "password": "SecurePassword!",
  "discountPercent": 10,
  "initialBalance": 1000
}
```

## Security

- **Password Hashing:** bcrypt with 10 rounds
- **JWT Algorithm:** HS256 (HMAC-SHA256)
- **Token Expiration:** 7 days
- **Token Storage:** sessionStorage (client-side)
- **Email Normalization:** All lowercase
- **HTTPS Required:** In production

## Troubleshooting

### Cannot login

1. Verify account exists:
   ```bash
   aws dynamodb scan --table-name pdm-portal-admins --region ap-south-1
   ```

2. Recreate account with password:
   ```powershell
   cd deploy/dynamodb
   .\create-admin-password.ps1 -Email "your-email@example.com" -Password "NewPassword!"
   ```

3. Check browser console for errors
4. Verify JWT_SECRET is set

### "Not signed in" error

1. Check sessionStorage:
   - Open DevTools (F12)
   - Application → Session Storage
   - Look for `pdm_account` entry

2. Clear and re-login:
   ```javascript
   sessionStorage.clear();
   window.location.reload();
   ```

### GSI not found

Run the migration script:
```powershell
cd deploy/dynamodb
.\migrate-admins-to-password-auth.ps1
```

## Migration

Migrating from Firebase authentication? See [deploy/dynamodb/MIGRATION-GUIDE.md](deploy/dynamodb/MIGRATION-GUIDE.md) for complete instructions.

## Documentation

- [Authentication Guide](docs/AUTHENTICATION.md) - Complete authentication documentation
- [Migration Guide](deploy/dynamodb/MIGRATION-GUIDE.md) - Firebase to password migration
- [Deployment Guide](../docs/DEPLOYMENT.md) - Production deployment

## Support

For issues or questions:
1. Check troubleshooting section above
2. Review authentication documentation
3. Check console logs for errors
4. Verify environment variables are set correctly

## License

Proprietary - Perfect Download Manager
