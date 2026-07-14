# Implementation Plan: Admin_Reseller_Portal

## Overview

This plan builds the Admin_Reseller_Portal as a single stateless Next.js 16 (App Router) +
React 19.2 + TypeScript full-stack application on Node.js 24 LTS, layered over the existing
`pdm-licenses` DynamoDB data and SSM signing keys in `ap-south-1`. Work proceeds bottom-up:
foundational shared libraries (validation, rbac, dynamo access + in-memory fake, audit, email,
auth, rate-limit) come first so every feature module can reuse them, then the feature modules
(auth/session, licenses, release, SEO, accounts/API keys, reseller API, audit) are implemented
and finally wired together behind shared middleware and the Nginx/systemd/IAM deployment
artifacts.

Property-based tests use `fast-check` with the Node.js test runner (`node --test`), exercise the
DynamoDB layer through an in-memory fake document client, run a minimum of 100 generated cases
each, and are tagged `// Feature: admin-reseller-portal, Property {n}: {text}`. Property and unit
test sub-tasks are marked optional with `*`.

## Tasks

- [x] 1. Set up the portal project structure and tooling
  - [x] 1.1 Initialize the Next.js + TypeScript project and testing harness
    - Create the separate web-development repository layout: Next.js 16 App Router project with React 19.2 and TypeScript 5.x targeting Node.js 24 LTS
    - Establish the source layout: `lib/` for shared libraries, `app/api/*` for Route Handlers, `test/` for property/unit tests
    - Configure the `node --test` runner and add `fast-check` as a dev dependency; add an npm `test` script that runs with `--run` semantics (single execution, not watch)
    - Add AWS SDK v3 (DynamoDB document client, SSM, S3), Firebase Admin SDK (~v13), Firebase JS SDK (~v11), and a Resend client as dependencies pinned to exact versions
    - _Requirements: 14.1, 14.5, 15.3_

- [x] 2. Implement pure validation and RBAC libraries
  - [x] 2.1 Implement the `validation` library (`lib/validation.ts`)
    - Pure validators/sanitizers returning `{ ok: true, value } | { ok: false, error }` for: license key format, `maxActivations` (integer ≥ 1), ISO 8601 UTC timestamps, status enum, S3 release URLs, 64-char hex checksums, SEO title/description lengths, Api_Key format, and 6-digit email-OTP format
    - _Requirements: 3.4, 3.5, 5.2, 6.2, 6.4, 8.3, 8.4, 9.3, 9.4, 15.4_
  - [x] 2.2 Write property test for maxActivations validation
    - **Property 9: maxActivations validation**
    - **Validates: Requirements 3.4, 6.2**
  - [x] 2.3 Write property test for expiresAt validation and clearing
    - **Property 10: expiresAt validation and clearing**
    - **Validates: Requirements 3.5, 6.4, 6.5**
  - [x] 2.4 Write property test for release URL validation
    - **Property 19: Release URL validation**
    - **Validates: Requirements 8.3**
  - [x] 2.5 Write property test for checksum validation
    - **Property 20: Checksum validation**
    - **Validates: Requirements 8.4**
  - [x] 2.6 Write property test for SEO title validation
    - **Property 22: SEO title validation**
    - **Validates: Requirements 9.3**
  - [x] 2.7 Write property test for SEO meta-description validation
    - **Property 23: SEO meta-description validation**
    - **Validates: Requirements 9.4**
  - [x] 2.8 Write property test for input validation before use
    - **Property 33: Client input is validated before use**
    - **Validates: Requirements 15.4**
  - [x] 2.9 Implement the `rbac` library (`lib/rbac.ts`)
    - Encode the static role→permission matrix and the pure `hasPermission(role, permission)` function for `super_admin`, `admin`, and `reseller`
    - _Requirements: 2.1, 2.2, 2.5, 2.6_
  - [x] 2.10 Write property test for the permission matrix
    - **Property 1: Permission matrix governs authorization**
    - **Validates: Requirements 2.2, 2.3, 2.5, 2.6**

- [x] 3. Implement the DynamoDB access layer, in-memory fake, and audit library
  - [x] 3.1 Implement the `dynamo` library and in-memory fake (`lib/dynamo.ts`, `test/fakes/dynamo-fake.ts`)
    - AWS SDK v3 document-client wrappers with `removeUndefinedValues` marshalling; conditional-write, map-update, and `UpdateItem ADD` atomic-counter helpers; paginated `query`/`scan` helpers returning continuation tokens
    - In-memory fake document client mirroring conditional-write, map-update, and atomic-counter semantics for tests
    - _Requirements: 14.1, 14.2, 14.5_
  - [x] 3.2 Implement the `audit` library (`lib/audit.ts`)
    - `writeAuditEntry(entry)` performing a conditional append-only `PutItem` on a unique ULID/UUID id; secret-field scrubbing; query helpers over actor/target/action/time-range GSIs
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_
  - [x] 3.3 Write property test for audit entries excluding secrets
    - **Property 28: Audit entries never contain secrets**
    - **Validates: Requirements 11.6, 13.5, 15.1**
  - [x] 3.4 Write property test for append-only audit log
    - **Property 29: Audit log is append-only**
    - **Validates: Requirements 13.3**
  - [x] 3.5 Write property test for audit query results
    - **Property 30: Audit query returns exactly matching entries**
    - **Validates: Requirements 13.4**

- [x] 4. Implement authentication, MFA, and session logic
  - [x] 4.1 Implement the pluggable `email` sender (`lib/email.ts`)
    - `EmailSender` interface backed by Resend for delivering the email-OTP second factor; OTP plaintext is never persisted or logged
    - _Requirements: 1.4_
  - [x] 4.2 Implement the `auth` library (`lib/auth.ts`)
    - Firebase ID-token verification via the Firebase Admin SDK (stateless), role/`resellerAccountId` resolution from `pdm-portal-admins`, `requirePermission` and `assertOwnership`
    - Email-OTP issue/verify against hashed `otpHash`/`otpExpiresAt`, `mfaEnrolled` gate, `failedOtp`/`lockUntil` lockout counter, `lastSeenAt` 30-minute idle expiry, and logout invalidation
    - Api_Key authentication by SHA-256 hash match, key-revocation and reseller-suspension checks
    - Uniform `authentication_failed` response that does not disclose which field was wrong
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.1, 2.2, 2.4, 2.7, 12.1, 12.2, 15.7_
  - [x] 4.3 Write property test for the credential validity gate
    - **Property 3: Credential validity gate**
    - **Validates: Requirements 1.7, 12.1, 12.2, 15.7**
  - [x] 4.4 Write property test for the MFA-enrollment gate on mutations
    - **Property 4: MFA-enrollment gate on mutations**
    - **Validates: Requirements 1.5**
  - [x] 4.5 Write property test for the uniform authentication-failure response
    - **Property 5: Uniform authentication-failure response**
    - **Validates: Requirements 1.3**
  - [x] 4.6 Write property test for OTP lockout after repeated failures
    - **Property 6: OTP lockout after repeated failures**
    - **Validates: Requirements 1.6**
  - [x] 4.7 Implement the auth Route Handlers (`app/api/auth/*`)
    - `POST /auth/login` (verify Firebase ID token + initiate OTP), `POST /auth/otp/request`, `POST /auth/otp/verify` (open session-activity record), `POST /auth/logout` (revoke refresh token / delete session-activity)
    - Redirect unauthenticated protected-route access to the login page
    - _Requirements: 1.1, 1.2, 1.4, 1.8_
  - [x] 4.8 Write unit tests for the login round-trip
    - Mocked Firebase Admin SDK verify + mocked Resend `EmailSender`: verified token → OTP requested → OTP verified → session opened; logout invalidates the credential; unauthenticated protected route redirects to login
    - _Requirements: 1.1, 1.2, 1.8_

- [x] 5. Implement Reseller_API rate limiting and monthly quota
  - [x] 5.1 Implement the `ratelimit` library (`lib/ratelimit.ts`)
    - DynamoDB atomic-counter enforcement: per-key request-window counter and per-key per-calendar-month quota counter using `UpdateItem ADD` + conditional expressions with TTL-based monthly reset; returns `{ allowed, reason: "rate" | "quota" | null }` mapping to HTTP 429
    - _Requirements: 12.5, 12.6_
  - [x] 5.2 Write property test for rate-limit window logic
    - **Testing Strategy property (portal-owned rate-limit window logic): for any sequence of request timestamps and a Rate_Limit/burst, requests beyond the window allowance are rejected with 429 and in-window requests pass**
    - **Validates: Requirements 12.5**
  - [x] 5.3 Write property test for monthly quota and reset
    - **Testing Strategy property (portal-owned monthly quota logic): for any request counts across calendar-month boundaries, the key is throttled with 429 once the monthly Quota is reached and the counter resets at the next calendar month**
    - **Validates: Requirements 12.6**

- [x] 6. Implement license creation
  - [x] 6.1 Implement license key generation and create (`lib/licenses/keygen.ts`, `lib/licenses/create.ts`, `app/api/licenses/route.ts` POST)
    - Generate `PDM-XXXX-XXXX-XXXX-XXXX` keys via `crypto.randomBytes`; conditional `PutItem` with `attribute_not_exists(licenseKey)` and bounded regeneration on collision
    - Set `status` = `active`, empty `activations`, ISO 8601 UTC `createdAt`; record `resellerAccountId` for reseller-created records; write a create Audit_Entry; never touch `TRIAL#` items
    - _Requirements: 3.1, 3.2, 3.3, 3.6, 3.7, 14.2, 14.3, 14.4_
  - [x] 6.2 Write property test for unique, well-formed license keys
    - **Property 7: Generated license keys are unique and well-formed**
    - **Validates: Requirements 3.1, 3.3**
  - [x] 6.3 Write property test for new license record defaults
    - **Property 8: New license records have correct defaults**
    - **Validates: Requirements 3.2, 3.6**
  - [x] 6.4 Write property test for license schema compatibility
    - **Property 31: License schema compatibility is preserved**
    - **Validates: Requirements 14.2, 14.3**
  - [x] 6.5 Write property test for trial-anchor immutability
    - **Property 32: Trial anchors are never modified**
    - **Validates: Requirements 14.4**

- [x] 7. Implement license listing, search, and single-record view
  - [x] 7.1 Implement list/search/view (`lib/licenses/query.ts`, `app/api/licenses/route.ts` GET, `app/api/licenses/[key]/route.ts` GET)
    - Paginated list with continuation tokens, excluding `TRIAL#` anchors; reseller-scoped by `resellerAccountId`; search by License_Key or `owner`; single-record view returning the full record shape plus Activation_Entries and the activation count alongside `maxActivations`; non-owned/unknown keys return not-found
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 7.1, 7.6, 2.7, 15.5_
  - [x] 7.2 Write property test for reseller ownership isolation
    - **Property 2: Reseller ownership isolation**
    - **Validates: Requirements 2.4, 2.7, 4.2, 4.6, 7.2, 12.4, 15.5**
  - [x] 7.3 Write property test for the license view record shape
    - **Property 15: License view exposes the full record shape**
    - **Validates: Requirements 4.5, 7.1, 7.6**
  - [x] 7.4 Write property test for excluding trial anchors from lists
    - **Property 16: License list excludes trial anchors**
    - **Validates: Requirements 4.1**
  - [x] 7.5 Write property test for pagination coverage
    - **Property 17: Pagination covers all results exactly once**
    - **Validates: Requirements 4.3**
  - [x] 7.6 Write property test for search results
    - **Property 18: Search returns exactly authorized matches**
    - **Validates: Requirements 4.4**

- [x] 8. Implement license status, attribute updates, and activation management
  - [x] 8.1 Implement status change (`lib/licenses/status.ts`, `app/api/licenses/[key]/status/route.ts` PATCH)
    - Update `status` to `active`/`revoked`/`suspended` on the same `pdm-licenses` item the Lambdas read; reject other values leaving `status` unchanged; write a status Audit_Entry with previous and new status
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_
  - [x] 8.2 Write property test for status validation and persistence
    - **Property 11: License status validation and persistence**
    - **Validates: Requirements 5.1, 5.2, 5.5**
  - [x] 8.3 Implement attribute update (`lib/licenses/attributes.ts`, `app/api/licenses/[key]/route.ts` PATCH)
    - Update only submitted `plan`/`maxActivations`/`expiresAt`/`owner`/`features`; reject `maxActivations` below current activation count with the count; clear `expiresAt` to make perpetual; write an Audit_Entry with before/after values
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_
  - [x] 8.4 Write property test for partial attribute updates
    - **Property 12: Partial attribute update preserves untouched attributes**
    - **Validates: Requirements 6.1**
  - [x] 8.5 Write property test for the activation cap floor
    - **Property 13: Activation cap cannot drop below current activations**
    - **Validates: Requirements 6.3**
  - [x] 8.6 Implement activation removal (`lib/licenses/activations.ts`, `app/api/licenses/[key]/activations/[fp]/route.ts` DELETE)
    - Delete exactly the targeted fingerprint from the `activations` map; return not-found for absent fingerprints leaving the map unchanged; write a removal Audit_Entry
    - _Requirements: 7.2, 7.3, 7.4, 7.5_
  - [x] 8.7 Write property test for precise activation removal
    - **Property 14: Activation removal is precise**
    - **Validates: Requirements 7.3, 7.4**

- [x] 9. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Implement release and SEO management
  - [x] 10.1 Implement the release module and signing (`lib/signing.ts`, `lib/release.ts`, `app/api/release/route.ts`)
    - `GET /release` returns current Release_Metadata; `PUT /release` validates S3 URLs and checksums, persists to `pdm-portal-releases`, projects to the client-compatible manifest shape, signs server-side with the SSM updates key (never exposed), publishes `manifest.json` to the release bucket, and writes an Audit_Entry
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 15.1, 15.2_
  - [x] 10.2 Implement the SEO module (`lib/seo.ts`, `app/api/seo/route.ts`, `app/api/seo/[pageId]/route.ts`, `app/api/seo/public/route.ts`)
    - `GET /seo` returns all managed pages; `PUT /seo/{pageId}` validates title (1–70) and meta description (50–160) and persists title/meta/OG tags with an Audit_Entry; `GET /seo/public` returns machine-readable JSON
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_
  - [x] 10.3 Write property test for release and SEO metadata round-trip
    - **Property 21: Metadata persistence round-trip (release and SEO)**
    - **Validates: Requirements 8.2, 9.2**
  - [x] 10.4 Write unit tests for release/SEO read and manifest projection
    - `GET /release` and `GET /seo` return seeded fields; `GET /seo/public` returns valid JSON with expected keys; manifest projection contains no key material
    - _Requirements: 8.1, 8.5, 9.1, 9.5_

- [x] 11. Implement reseller account, admin, and API key management (super_admin)
  - [x] 11.1 Implement reseller account management (`lib/accounts.ts`, `app/api/resellers/route.ts`, `app/api/resellers/[id]/state/route.ts`)
    - Create Reseller_Account (require orgName + contactEmail, unique id, `active` state); suspend/reactivate toggling `state`; write Audit_Entries
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_
  - [x] 11.2 Write property test for reseller account creation validation and defaults
    - **Property 24: Reseller account creation validation and defaults**
    - **Validates: Requirements 10.1, 10.4**
  - [x] 11.3 Write property test for reseller suspend/reactivate round-trip
    - **Property 25: Reseller suspend/reactivate round-trip**
    - **Validates: Requirements 10.2, 10.3**
  - [x] 11.4 Implement admin creation and API key management (`lib/apikeys.ts`, `app/api/admins/route.ts`, `app/api/resellers/[id]/apikeys/route.ts`, `app/api/apikeys/[id]/route.ts`, `app/api/apikeys/[id]/plan/route.ts`)
    - Create Admin_User; issue Api_Key returning the plaintext secret once and storing only its SHA-256 hash with an embedded Usage_Plan (rate/burst/quota, default when unassigned); revoke keys; change Usage_Plan; write Audit_Entries without secrets
    - _Requirements: 2.6, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6_
  - [x] 11.5 Write property test for one-time, non-reversible API key secrets
    - **Property 26: API key secret is one-time and non-reversible**
    - **Validates: Requirements 11.1, 11.2, 11.3**
  - [x] 11.6 Write unit test for default Usage_Plan fallback
    - Api_Keys without an explicit Usage_Plan fall back to portal default rate/burst/quota
    - _Requirements: 11.5_

- [x] 12. Implement the audit query route
  - [x] 12.1 Implement `GET /audit` (`app/api/audit/route.ts`)
    - Query Audit_Entries by actor, target, action, or time range for callers holding `audit:read`
    - _Requirements: 13.4_

- [x] 13. Implement the Reseller_API surface
  - [x] 13.1 Implement reseller-scoped API routes (`app/api/reseller/licenses/route.ts`, `app/api/reseller/licenses/[key]/route.ts`, `app/api/reseller/licenses/[key]/activations/[fp]/route.ts`)
    - Api_Key-authenticated, reseller-scoped create/list/read/update/activation-management reusing the license modules; apply the same validation and Audit_Entry rules; enforce rate-limit and monthly quota via `ratelimit` (HTTP 429); JSON only
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7_
  - [x] 13.2 Write unit tests for Reseller_API throttling and isolation
    - Exceeding rate limit returns 429 `rate_limit_exceeded`; exceeding monthly quota returns 429 `quota_exceeded`; suspended-account and revoked-key requests are rejected; non-owned keys return not-found
    - _Requirements: 12.2, 12.4, 12.5, 12.6_

- [x] 14. Wire the portal together and add cross-cutting audit coverage
  - [x] 14.1 Wire shared middleware around all Route Handlers (`lib/middleware.ts`)
    - Compose `auth` → `ratelimit` (reseller) → `validation` → permission check → mutation → `audit` uniformly across every route; apply the error taxonomy (401/403/404/400/423/429) with non-leaking bodies
    - _Requirements: 1.1, 2.2, 2.3, 12.5, 12.6, 15.4, 15.7_
  - [x] 14.2 Write property test for full mutation auditing
    - **Property 27: Every successful mutation is fully audited**
    - **Validates: Requirements 3.7, 5.3, 6.6, 7.5, 8.6, 9.6, 10.5, 11.6, 13.1, 13.2**
  - [x] 14.3 Write integration tests for external boundaries
    - Firebase ID-token verification accepts genuine / rejects forged tokens and resolves the expected role; portal status change is read back through the same `pdm-licenses` item; SSM signing round-trip does not persist/return the key; signed `manifest.json` published to S3; portal operational data read back from its own DynamoDB tables
    - _Requirements: 1.2, 2.1, 5.4, 8.2, 8.5, 14.1, 14.5, 15.1, 15.2_

- [x] 15. Author deployment and least-privilege configuration artifacts
  - [x] 15.1 Create the Nginx, systemd, and IAM configuration files
    - Nginx reverse-proxy config terminating HTTPS with no plaintext HTTP listener; systemd unit (or Docker Compose) supervising the Next.js process; least-privilege IAM policy JSON scoped to `pdm-licenses` + the portal tables, the SSM signing-key path, and the S3 release bucket only
    - _Requirements: 12.7, 15.3, 15.6_
  - [x] 15.2 Write smoke/configuration tests
    - Assert HTTPS-only reachability (no plaintext HTTP listener), portal tables separate from `pdm-licenses`, and the IAM policy snapshot is least-privilege with no browser AWS credentials
    - _Requirements: 12.7, 14.5, 15.3, 15.6_

- [x] 16. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional test tasks and can be skipped for a faster MVP.
- Each task references specific requirement sub-clauses for traceability.
- Property tests use `fast-check` + `node --test` (≥100 cases each) against the in-memory
  DynamoDB fake; Firebase Admin SDK verification and Resend sends are mocked in unit/property
  tests and confirmed by the integration tests in 14.3.
- Rate-limit/quota property tests (5.2, 5.3) validate the portal-owned window/quota logic
  described in the design's Testing Strategy; the remaining property tests map to the numbered
  Correctness Properties 1–33.
- Checkpoints (tasks 9 and 16) ensure incremental validation.
- Identity/login is delegated to Firebase; MFA (email-OTP), lockout, session idle expiry,
  authorization, Api_Key validation, rate limiting, and quota are enforced in portal code and
  are directly tested.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "2.9", "3.1", "4.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "2.5", "2.6", "2.7", "2.8", "2.10", "3.2", "5.1"] },
    { "id": 3, "tasks": ["3.3", "3.4", "3.5", "4.2", "5.2", "5.3"] },
    { "id": 4, "tasks": ["4.3", "4.4", "4.5", "4.6", "4.7", "6.1", "7.1", "8.1", "8.3", "8.6", "10.1", "10.2", "11.1", "11.4", "12.1"] },
    { "id": 5, "tasks": ["4.8", "6.2", "6.3", "6.4", "6.5", "7.2", "7.3", "7.4", "7.5", "7.6", "8.2", "8.4", "8.5", "8.7", "10.3", "10.4", "11.2", "11.3", "11.5", "11.6", "13.1"] },
    { "id": 6, "tasks": ["13.2", "14.1"] },
    { "id": 7, "tasks": ["14.2", "14.3", "15.1"] },
    { "id": 8, "tasks": ["15.2"] }
  ]
}
```
