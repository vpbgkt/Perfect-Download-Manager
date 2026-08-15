# Implementation Plan: License Key Management Enhancements

## Overview

The work is sequenced so that the pure, AWS-free modules land first (Key_Generator,
Customer_Field evaluation, continuation-token guard), then the portal storage layer that consumes
them, then authorization and route wiring, then the frontend, then the licensing Lambdas and the
CLI minter mirror, and finally the configuration/smoke tests, CI job, and the scripted deployment
and post-deployment verification.

Languages and tooling follow the existing codebase: TypeScript in `admin-portal` (Next.js, tested
with `node --test "test/**/*.test.ts"` under Node's type stripping), ES modules (`.mjs`) in
`backend/licensing` (tested with `node --test`), **fast-check 4.1.1** for property tests, and the
in-memory DynamoDB fake at `admin-portal/lib/dev/in-memory-dynamo.ts` for storage tests. Every new
property test file follows the design's convention: `<area>.<concern>.property.test.ts`,
`const RUNS = 100;` with `{ numRuns: RUNS }`, and a header comment tagging the design property and
the requirements it validates.

## Tasks

- [x] 1. Rewrite the portal Key_Generator
  - [x] 1.1 Rewrite `admin-portal/lib/licenses/keygen.ts`
    - Export `KEY_ALPHABET` (32 symbols: `0123456789ABCDEFGHJKMNPQRSTVWXYZ`), `LICENSE_KEY_PREFIX`, `SECRET_GROUPS = 7`, `SECRET_GROUP_SIZE = 4`, `MIN_CUSTOM_PREFIX_LENGTH`, `MAX_CUSTOM_PREFIX_LENGTH`, and keep `LICENSE_KEY_GROUPS` as a deprecated alias so no importer breaks
    - Implement `normalizeKeyPrefix` with the ordered steps of Req 5.3 and `validateKeyPrefix` returning `ok(undefined)` for absent input, an error for a non-string non-null value, and errors for charset/length violations
    - Implement `generateSecretComponent(random?: RandomBytes)` drawing from an injectable `node:crypto` byte source, mapping `symbol = KEY_ALPHABET[b >>> 3]` with an explicit `ACCEPT_LIMIT = 256 - (256 % 32)` rejection/redraw branch and no remainder reduction, emitting 7 hyphen-separated groups of 4 symbols
    - Implement `generateLicenseKey(prefix?, random?)` producing `PDM-<PREFIX>-<secret>` or `PDM-<secret>`, and add `KeyGenerationError` thrown on a source error or short read with no fallback source
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.1, 6.2, 6.3, 6.6, 6.7, 6.8_

  - [x] 1.2 Write property test for key grammar and length bounds
    - **Property 1: Generated keys always match the key grammar and length bounds**
    - Extend `admin-portal/test/licenses.keygen.property.test.ts`
    - **Validates: Requirements 5.1, 5.2, 5.6, 6.2, 6.6, 6.7, 11.4**

  - [x] 1.3 Write property test for the byte-to-symbol mapping
    - **Property 3: The byte-to-symbol mapping is uniform and free of remainder reduction**
    - New file `admin-portal/test/licenses.keygen-mapping.property.test.ts`, exhaustive over all 256 byte values plus the rejection/redraw path with an injected byte source
    - **Validates: Requirements 6.3**

  - [x] 1.4 Write property test for secret independence and uniqueness
    - **Property 2: Key_Secret_Components are independent of every request input and mutually distinct**
    - New file `admin-portal/test/licenses.keygen-entropy.property.test.ts`, including a ≥1000-key batch per iteration for Req 6.5
    - **Validates: Requirements 6.1, 6.4, 6.5, 11.5**

  - [x] 1.5 Write property test for prefix normalization and acceptance
    - **Property 4: Prefix normalization is idempotent and acceptance is exactly the legal charset and length**
    - New file `admin-portal/test/licenses.prefix-normalization.property.test.ts`, with the prefix arbitrary mixing legal prefixes, underscore/whitespace forms, hyphen runs, illegal characters, and lengths 0–40
    - **Validates: Requirements 5.3, 5.4, 5.5, 5.12, 11.8**

- [x] 2. Implement Customer_Field normalization and validation
  - [x] 2.1 Create `admin-portal/lib/licenses/customer.ts`
    - Export `CUSTOMER_FIELDS`, `SEARCHABLE_CUSTOMER_FIELDS`, `MAX_NAME_LENGTH = 120`, `MAX_NOTES_LENGTH = 1000`, and the `CustomerProfile` type
    - Implement `normalizeCustomerField` per field (email: trim + lowercase; country: trim + uppercase; name/company/phone: trim + collapse whitespace runs; notes: trim only) as an idempotent function
    - Implement `isEmailFormat`, `isCountryCode`, `isPhoneFormat` directly from the glossary rules rather than permissive regexes
    - Implement `evaluateCustomerProfile(body)` returning `{ set, clear, errors }`: normalize first, then validate every submitted field, collect every offending field, never throw, never partially apply; a present non-string non-null value yields an error and no normalized form; a value normalizing to empty lands in `clear`
    - _Requirements: 1.2, 1.3, 1.4, 2.1, 2.2, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9, 4.10, 4.11, 4.12, 4.13_

  - [x] 2.2 Write unit tests for Customer_Field normalization and predicates
    - New file `admin-portal/test/licenses.customer-normalization.test.ts`
    - Cover the boundary examples in the design's normalization table: 120/1000-character straddles, interior whitespace collapse, mixed-case email, two-letter country, phone digit counts and the single leading `+`, Unicode values, and whitespace-only values landing in `clear`
    - _Requirements: 4.2, 4.4, 4.6, 4.11, 4.12, 4.13, 11.1_

- [x] 3. Implement the license continuation-token guard
  - [x] 3.1 Create `admin-portal/lib/licenses/pagination.ts`
    - Implement `parseLicenseContinuationToken(token: unknown)` accepting only a base64url string decoding to JSON of the exact shape `{ "licenseKey": "<string>" }` that `lib/dynamo.encodeToken` produces for this table, and returning a validation error naming `nextToken` otherwise
    - Document the deliberate limitation that a structurally valid but never-issued token cannot be distinguished without server-side token state
    - _Requirements: 3.11_

- [x] 4. Checkpoint - foundation modules
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Extend license creation
  - [x] 5.1 Extend `admin-portal/lib/licenses/create.ts`
    - Add `keyPrefix?` and `customer?` to `CreateLicenseInput`, persist `keyPrefix` verbatim as one additive attribute when present, and spread the normalized Customer_Profile onto the item so absent fields never appear
    - Keep the retry loop bound at `DEFAULT_MAX_KEY_ATTEMPTS = 5`, calling `generateLicenseKey(input.keyPrefix)` on every attempt so a collision regenerates only the secret component
    - Catch `KeyGenerationError` before any write and map it to `{ code: "key_generation_failed" }`; report a non-collision write rejection without a partial write
    - Extend the create Audit_Entry with `keyPrefix` (value) and `customerFieldsSet` (sorted names only, no values), each written only when non-empty
    - _Requirements: 1.2, 1.3, 1.8, 1.10, 5.1, 5.2, 5.8, 5.9, 5.10, 5.14, 6.8_

  - [x] 5.2 Write property test for the collision retry loop
    - **Property 20: Collision retry keeps the prefix, is bounded at five attempts, and reports the key it wrote**
    - New file `admin-portal/test/licenses.collision-retry.property.test.ts` using the in-memory DynamoDB fake with a scripted collision sequence
    - **Validates: Requirements 5.8, 5.9, 5.14**

  - [x] 5.3 Write property test for a failing random source
    - **Property 6: A failing random source produces no key and no write**
    - New file `admin-portal/test/licenses.keygen-failure.property.test.ts`, injecting a byte source that throws or under-delivers at arbitrary points and asserting the table snapshot is deep-equal afterwards
    - **Validates: Requirements 6.8**

  - [x] 5.4 Write unit tests for the create write-failure path
    - New file `admin-portal/test/licenses.write-failure.test.ts`
    - Inject a `put` rejection and assert the not-created error plus a deep-equal table snapshot
    - _Requirements: 1.10, 11.1_

- [x] 6. Extend license attribute updates
  - [x] 6.1 Extend `admin-portal/lib/licenses/attributes.ts`
    - Add the six Customer_Field keys to `LicenseAttributeUpdates` as `unknown` and evaluate them through `evaluateCustomerProfile` before the record is read, so a rejected update never mutates state
    - Build `SET #customerX` for non-empty normalized values and `REMOVE #customerX` for null/empty/whitespace-only submissions, with a no-op when the attribute is already absent
    - Extend the `RL#` guard alongside the existing `TRIAL#` guard so counter items are unreachable through the license API
    - Add `customerFieldsSet` / `customerFieldsCleared` sorted name arrays to the audit `changes`, written only when a Customer_Field actually changed, leaving other mutations' entries byte-identical to today
    - _Requirements: 2.1, 2.2, 2.4, 2.6, 2.7, 2.9, 4.9, 4.13, 9.1, 9.2, 9.7, 10.13_

  - [x] 6.2 Write property test for absent and blank Customer_Fields
    - **Property 9: Absent and blank Customer_Fields leave no attribute behind**
    - New file `admin-portal/test/licenses.customer-absence.property.test.ts`
    - **Validates: Requirements 1.2, 1.3, 2.1, 2.2, 4.13, 10.3**

  - [x] 6.3 Write property test for Customer_Profile round-trip
    - **Property 7: Customer_Profile storage round-trips and normalization is a fixed point**
    - New file `admin-portal/test/licenses.customer-roundtrip.property.test.ts`
    - **Validates: Requirements 2.4, 3.1, 4.2, 4.4, 4.8, 4.10, 4.11, 4.12, 7.9, 11.3**

  - [x] 6.4 Write property test for all-or-nothing Customer_Field validation
    - **Property 8: Customer_Field validation is all-or-nothing and names every offending field**
    - New file `admin-portal/test/licenses.customer-validation.property.test.ts`
    - **Validates: Requirements 4.1, 4.3, 4.5, 4.6, 4.7, 4.9, 11.6**

  - [x] 6.5 Write property test for Customer_Field auditing
    - **Property 13: Audit entries name changed Customer_Fields and never carry their values**
    - New file `admin-portal/test/licenses.customer-audit.property.test.ts`
    - **Validates: Requirements 1.8, 2.7, 5.10, 9.1, 9.2, 9.3, 9.7**

  - [x] 6.6 Write property test for single-copy storage
    - **Property 10: Key and customer values are stored in exactly one place**
    - New file `admin-portal/test/licenses.single-copy.property.test.ts`, scanning every table in the in-memory fake for the key and profile values
    - **Validates: Requirements 1.4, 7.1**

- [x] 7. Extend license search and projection
  - [x] 7.1 Extend `admin-portal/lib/licenses/query.ts`
    - Add `keyPrefix` and the six Customer_Fields to `LicenseSummary` and the detail view, omitting absent attributes rather than emitting `null`
    - Extend `matchesSearch` to compare the trimmed, lowercased term against lowercased `licenseKey`, `owner`, `customerEmail`, `customerName`, `customerCompany`, and `customerPhone`, with an empty or whitespace-only term matching every row
    - Add `MAX_SEARCH_TERM_LENGTH = 128` and the term-length guard, and route `continuationToken` through `parseLicenseContinuationToken`
    - Exclude `RL#` items alongside `TRIAL#` in both the `FilterExpression` and the authoritative in-memory predicate, and keep reseller scoping applied to the result set and the count
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 3.10, 3.11, 7.9, 10.3_

  - [x] 7.2 Write property test for search and pagination completeness
    - **Property 11: Search yields exactly the viewable matches, each exactly once, across pages**
    - New file `admin-portal/test/licenses.customer-search.property.test.ts`, with a population arbitrary mixing prefixed/legacy records, reseller- and admin-owned records, profiles, `TRIAL#` anchors, and `RL#` counters
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6, 3.8, 3.10**

  - [x] 7.3 Write property test for malformed search parameters
    - **Property 19: Malformed search parameters are rejected without results**
    - New file `admin-portal/test/licenses.search-params.property.test.ts`
    - **Validates: Requirements 3.11**

- [x] 8. Checkpoint - portal storage layer
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Resolve principals and wire the license routes
  - [x] 9.1 Create `admin-portal/lib/principal.ts`
    - Implement `resolvePrincipal(req, body)`: an `x-api-key` header authenticates a Reseller_API caller through the existing `Authenticator.authenticateApiKey`; otherwise the Firebase ID token path runs exactly as today, with unchanged ordering and errors
    - Keep the MFA-enrollment gate firebase-only and feed the same `resellerAccountId` scoping for both credentials
    - _Requirements: 1.7, 3.5, 5.7, 7.12_

  - [x] 9.2 Wire the license routes to the new modules
    - Update `admin-portal/app/api/licenses/route.ts` (POST create, GET list/search) and `admin-portal/app/api/licenses/[key]/route.ts` (GET view, PATCH update) to resolve the principal, evaluate `license:create` / `license:read` / `license:update` before any Licenses_Table read, gate a supplied `keyPrefix` to `admin`/`super_admin` with a 403, validate prefix and profile before any write, and return the complete generated License_Key plus `keyPrefix` and present Customer_Fields
    - Extend `validationErrorResponse` in `admin-portal/lib/http.ts` to carry a `fields:[{field,reason}]` array alongside the existing `field`/`reason` pair so several offending Customer_Fields are named at once without breaking current clients
    - Collapse unknown, `TRIAL#`, `RL#`, and non-owned targets into one 404 body
    - _Requirements: 1.7, 1.9, 2.5, 2.6, 2.8, 3.9, 3.11, 4.9, 5.7, 5.14, 7.3, 7.8, 7.10, 7.12, 10.6_

  - [x] 9.3 Write property test for authorization gating
    - **Property 12: Unauthorized requests return nothing and change nothing**
    - New file `admin-portal/test/licenses.authorization.property.test.ts`
    - **Validates: Requirements 1.9, 2.5, 2.6, 2.8, 3.9, 5.7, 7.7, 7.8, 7.10, 7.12, 9.9, 11.9**

  - [x] 9.4 Write property test for non-unique email and credential-path equivalence
    - **Property 21: Customer email is non-unique and both credential paths behave identically**
    - New file `admin-portal/test/licenses.customer-duplicates.property.test.ts`
    - **Validates: Requirements 1.5, 1.6, 1.7, 2.10**

  - [x] 9.5 Write property test for backward compatibility
    - **Property 16: Existing records, requests, responses, and outcomes keep their behavior**
    - New file `admin-portal/test/licenses.backward-compat.property.test.ts`, covering Legacy_License_Keys, pre-feature request shapes, additive responses on both credential paths, and adding Customer_Fields to a pre-feature record without changing its `licenseKey`
    - **Validates: Requirements 10.1, 10.2, 10.5, 10.6, 10.8, 10.9, 10.12, 10.13**

- [x] 10. Extend the portal DTOs and frontend
  - [x] 10.1 Add the additive DTO fields
    - Update `admin-portal/models/types.ts` with `keyPrefix` and the six Customer_Fields on the license summary and detail types, and `admin-portal/models/api-client.ts` with the optional create/update request fields and the `fields` array on `ApiError`, without renaming or removing any existing field
    - _Requirements: 10.6_

  - [x] 10.2 Extend the create-license page
    - Update `admin-portal/app/dashboard/licenses/new/page.tsx` with a "Customer information" block of six inputs under helper text stating the fields are optional and recommended, and a `Custom key prefix (optional)` input with `maxLength={32}` rendered only for an `admin`/`super_admin` session, reusing the existing `Card`/`Input`/`Button` primitives
    - _Requirements: 1.1, 5.7, 5.13, 5.14_

  - [x] 10.3 Extend the license detail page
    - Update `admin-portal/app/dashboard/licenses/[key]/page.tsx` with a "Customer information" card holding the six editable controls pre-filled from the view response and empty where the attribute is absent, sending only those fields through `api.updateLicense` and sending `""` for an emptied control so the attribute is removed
    - _Requirements: 2.3, 2.2, 3.1_

  - [x] 10.4 Extend the license list page
    - Update `admin-portal/app/dashboard/licenses/page.tsx` so the search placeholder and description mention the customer fields and each row shows a `No customer info` badge when all six Customer_Fields are absent from the summary
    - _Requirements: 3.7, 3.2_

  - [x] 10.5 Write unit tests for the new UI rendering
    - New file `admin-portal/test/licenses.customer-ui.test.ts`
    - Assert the create form renders six customer inputs plus the optional/recommended text, the prefix input exists with `maxLength=32` for an admin and is absent for a reseller, the detail form pre-fills stored values and leaves absent fields empty, and the list badge appears only when all six fields are absent
    - _Requirements: 1.1, 2.3, 3.7, 5.13_

- [x] 11. Checkpoint - portal end to end
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Add attempt limiting to the licensing backend
  - [x] 12.1 Create `backend/licensing/src/lib/attemptLimit.mjs`
    - Export the bucket constants (`ACT`, `ACTUNKNOWN`, `VAL`, `TRIAL`), the defaults (60 requests, 3600 s, 10 unknown keys) and the bounds (`LIMIT_BOUNDS` 1–10000, `WINDOW_BOUNDS` 60–86400)
    - Implement the pure `resolveSetting`/`resolveLimits` env readers and `clientIp(event)` reading only `requestContext.http.sourceIp` and falling back to `"unknown"`
    - Implement `createAttemptLimiter({ docClient, tableName, limits, now })` with `increment` as one atomic `UpdateItem` on `RL#<bucket>#<ip>` (`ADD reqCount`, `SET ttl`/`windowStart` with `if_not_exists`) plus the in-place window reset to `reqCount = 1`, `allowed = count <= limit`, and `peek` as a non-writing `GetItem`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.9, 8.10, 8.11_

  - [x] 12.2 Write property test for the Attempt_Counter windows
    - **Property 14: Attempt_Counters are independent per-bucket fixed windows**
    - New file `admin-portal/test/licensing.attempt-limit.property.test.ts` importing the backend module directly, with a request-sequence arbitrary over (bucket, IP, elapsed time) and an injected clock
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.10, 8.11, 11.10**

  - [x] 12.3 Write property test for environment-supplied limits
    - **Property 17: Environment-supplied limits are clamped or replaced by defaults**
    - New file `admin-portal/test/licensing.limit-config.property.test.ts`
    - **Validates: Requirements 8.9**

  - [x] 12.4 Delegate the existing trial limiter
    - Update `backend/licensing/src/lib/rateLimit.mjs` to keep exporting `clientIp` and `checkRateLimit("TRIAL", ip)` as thin delegates over `attemptLimit.mjs`, leaving `trial.mjs` and its behaviour unchanged
    - _Requirements: 10.1_

  - [x] 12.5 Add limiting to the activation handler
    - Update `backend/licensing/src/activate.mjs` with the preamble in the design sequence: `increment("ACT", ip)`, then `peek("ACTUNKNOWN", ip)`, then the existing input validation and key lookup, incrementing `ACTUNKNOWN` only when no License_Record resolves
    - Return the shared frozen `{ valid:false, message:"rate_limited" }` body with status 429 before `recordActivation`, `touchActivation`, and `issueToken`, and wrap every counter call so a failure is treated as not limited and logged as `{ event:"attempt_counter_failure", bucket }` with no key material
    - Leave every non-limited response byte-identical to today
    - _Requirements: 8.1, 8.3, 8.4, 8.5, 8.7, 8.8, 8.12, 10.1, 7.6_

  - [x] 12.6 Add limiting to the validation handler
    - Update `backend/licensing/src/validate.mjs` with `increment("VAL", ip)` and the same uniform 429 rejection and fail-open wrapper, leaving every other response unchanged
    - _Requirements: 8.2, 8.3, 8.7, 8.8, 8.12, 10.1_

  - [x] 12.7 Write property test for rejection uniformity
    - **Property 15: Rejections and unknown keys are uniform and free of side effects**
    - New file `admin-portal/test/licensing.rejection-uniformity.property.test.ts`
    - **Validates: Requirements 7.6, 8.8, 8.12**

  - [x] 12.8 Write property test for absence of key and customer data leakage
    - **Property 18: Key material and customer data never reach tokens, licensing responses, or logs**
    - New file `admin-portal/test/licenses.no-leak.property.test.ts`, capturing an injected logger and inspecting token payloads and every activate/validate/deactivate and portal error body
    - **Validates: Requirements 7.4, 7.5, 7.11, 9.4, 9.6**

  - [x] 12.9 Write unit tests for fail-open limiter behaviour
    - New file `admin-portal/test/licensing.fail-open.test.ts`
    - Inject `increment`/`peek` failures and assert the activate and validate requests are still processed, with the log line free of key material; add an injected audit-write rejection case asserting the portal mutation outcome is unchanged and no value is logged
    - _Requirements: 8.7, 9.8, 11.10_

  - [x] 12.10 Add the limiter configuration to the template
    - Update `backend/licensing/template.yaml` with the `ActivateRateLimit`, `ValidateRateLimit`, `ActivateUnknownKeyLimit`, and `AttemptWindowSeconds` parameters and the five environment variables on `ActivateFunction` and `ValidateFunction`, changing no table, index, IAM, route, or stage configuration
    - _Requirements: 8.9, 12.2, 12.4_

- [x] 13. Mirror the Key_Generator in the CLI minter
  - [x] 13.1 Create `backend/licensing/admin/lib/keygen.mjs`
    - Mirror `KEY_ALPHABET`, `normalizeKeyPrefix`, `validateKeyPrefix`, `generateSecretComponent`, and `generateLicenseKey` with semantics identical to the portal module, against the same written specification
    - _Requirements: 6.9, 5.11, 6.1, 6.2, 6.3, 6.6, 6.7_

  - [x] 13.2 Add `--prefix` to the CLI minter
    - Update `backend/licensing/admin/create-license.mjs` to parse `--prefix <value>`, normalize and validate it through the mirror before constructing the item, print `invalid prefix: <reason>` and exit non-zero issuing no `PutCommand` when it is rejected, store the normalized value in the item's `keyPrefix` attribute, and retain the `attribute_not_exists(licenseKey)` condition
    - _Requirements: 5.11_

  - [x] 13.3 Write property test for generator parity
    - **Property 5: The two Key_Generator implementations agree**
    - New file `admin-portal/test/licenses.keygen-parity.property.test.ts` importing both `admin-portal/lib/licenses/keygen.ts` and `backend/licensing/admin/lib/keygen.mjs`
    - **Validates: Requirements 6.9, 5.11**

  - [x] 13.4 Write unit tests for the CLI minter
    - New file `admin-portal/test/licensing.cli-minter.test.ts`
    - Cover `--prefix` normalization, rejection of an illegal prefix with a non-zero exit and no write, and acceptance of a legal prefix producing a conforming key
    - _Requirements: 5.11, 11.1_

- [x] 14. Checkpoint - licensing backend and CLI
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Extend the configuration smoke tests and CI
  - [x] 15.1 Extend `admin-portal/test/deploy.smoke.test.ts`
    - Assert the licenses table keeps `SSESpecification.SSEEnabled: true` and `TimeToLiveSpecification.AttributeName: ttl`, declares no `GlobalSecondaryIndexes`, that the Activate/Validate functions declare the five new environment variables while the IAM policy still grants only `GetItem`/`PutItem`/`UpdateItem` on the table, that the nginx HTTPS-only assertions still hold, and that `deploy.ps1` contains no delete/replace operation and aborts on a non-zero exit code
    - _Requirements: 7.2, 7.3, 8.6, 10.7, 10.10, 10.11, 12.2, 12.3, 12.4_

  - [x] 15.2 Add the portal and licensing test job to CI
    - Add the `portal-test` job to `.github/workflows/ci.yml` running `npm ci` and `npm test` in `admin-portal` and `npm test` in `backend/licensing` on Node 22.x, so the suites are enforced on every push rather than by hand
    - _Requirements: 11.2, 11.7, 12.1_

- [x] 16. Script the deployment and post-deployment verification
  - [x] 16.1 Extend the deployment script
    - Update `backend/licensing/deploy.ps1` to run the portal build and the portal and licensing test commands as gating steps before `cloudformation deploy`, pass the new limiter parameters, keep `Assert-LastExit` aborting on the first non-zero exit code, and keep the region `ap-south-1` and table name `pdm-licenses` from the existing environment configuration with no delete or replace operation on any table
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 10.10, 10.11_

  - [x] 16.2 Implement the post-deployment verification script
    - Create `backend/licensing/verify-deployment.mjs` implementing the six checks as assertions: portal health returns 200; a license created with Customer_Field values returns those values on read; a license created with a Custom_Key_Prefix activates through `POST /activate`; a Legacy_License_Key activates through `POST /activate`; exceeding the activation limit returns 429; and error-severity Lambda and portal log entries from the verification window are retrieved and reported
    - Create every record it needs as a new License_Record marked identifiably (`owner: "verification"` plus a `VERIFY` Custom_Key_Prefix), modify no pre-existing record, present only its own keys to the 429 check while reporting the source IP and Attempt_Window used, report an unreachable environment as *not verified* rather than passed, report each failing check and withhold a success report, and perform no rollback without an explicit operator flag
    - _Requirements: 12.5, 12.6, 12.7, 12.8, 12.10, 12.11, 12.12_

  - [x] 16.3 Implement the deployment summary writer
    - Add a report writer to the verification script that emits a written summary from the recorded check results, covering the code changes, the License_Record attribute additions, the API changes, the Portal_Frontend changes, the security changes, the tests performed, the deployment outcome, and the remaining limitations and follow-up recommendations
    - _Requirements: 12.9_

  - [x] 16.4 Write unit tests for the verification result logic
    - New file `admin-portal/test/deploy.verification.test.ts`
    - Test the check-result aggregation with injected transports: any failing check blocks a success report, an unreachable environment yields *not verified*, rollback is never triggered without the operator flag, and the emitted summary contains every required section
    - _Requirements: 12.7, 12.8, 12.9, 12.12_

- [x] 17. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate the 21 universal correctness properties of the design, one file per property
- Unit tests cover the criteria the design routes to example tests: UI rendering, write-failure paths, fail-open limiter behaviour, audit-failure tolerance, the CLI minter, and configuration smoke assertions
- The pre-existing portal suite (notably `licenses.schema-compat.property.test.ts`, `licenses.mutations.property.test.ts`, `licenses.trial-immutability.property.test.ts`, `mutation-auditing.property.test.ts`, `validation.test.ts`, `rbac.test.ts`) must stay green unchanged (Req 11.7)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "10.1", "12.1", "13.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4", "1.5", "2.2", "5.1", "12.2", "12.3", "12.4", "12.10", "13.2"] },
    { "id": 2, "tasks": ["5.2", "5.3", "5.4", "6.1", "7.1", "9.1", "12.5", "12.6", "13.3", "13.4"] },
    { "id": 3, "tasks": ["6.2", "6.3", "6.4", "6.5", "6.6", "7.2", "7.3", "9.2", "12.7", "12.9"] },
    { "id": 4, "tasks": ["9.3", "9.4", "9.5", "10.2", "10.3", "10.4", "12.8", "15.1", "15.2"] },
    { "id": 5, "tasks": ["10.5", "16.1", "16.2"] },
    { "id": 6, "tasks": ["16.3"] },
    { "id": 7, "tasks": ["16.4"] }
  ]
}
```
