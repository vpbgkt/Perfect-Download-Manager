# Requirements Document

## Introduction

The Admin_Reseller_Portal is a professional, authenticated web application for the Perfect
Download Manager (PDM) team and their resellers/distributors. It replaces the current
CLI-and-`aws`-command workflow (`backend/licensing/admin/create-license.mjs`, ad-hoc
`aws dynamodb update-item` calls) with a role-based web dashboard and a programmatic reseller
API.

The portal delivers four capabilities:

1. **License management** — full lifecycle CRUD over the existing `pdm-licenses` DynamoDB
   table: mint keys, list/search them, change `status` (active/revoked/suspended), adjust
   `plan`, `maxActivations`, `expiresAt`, `owner`, and `features`, and view/deactivate the
   per-machine `activations` map.
2. **Download & version management** — edit the "latest version" release metadata (current
   version string, MSI URL, portable-zip URL, checksums, release notes) that the marketing
   site and the desktop app's auto-updater consume, backed by the ECDSA-signed
   `manifest.json` in the `pdm-updates-452359090613-aps1` S3 bucket.
3. **SEO settings management** — edit the public marketing site's SEO fields (page titles,
   meta descriptions, Open Graph tags) that the separate static marketing website consumes.
4. **Reseller/distributor API** — scoped, rate-limited API keys that let resellers create and
   manage licenses programmatically, isolated so a reseller sees only its own licenses.

The portal is a distinct system from the existing static marketing website; it manages the
data that site consumes but does not serve that site. The portal reuses the existing
serverless licensing backend in region **ap-south-1** (DynamoDB `pdm-licenses`, the
activate/validate/trial Lambdas, the API Gateway at
`https://pgwoailzqa.execute-api.ap-south-1.amazonaws.com`, and the ECDSA P-256 signing keys in
SSM SecureString) rather than reinventing it. It stores its own operational data — admin role
mappings, reseller accounts, API keys, rate-limit/quota counters, SEO settings, release
metadata, and an append-only audit log — in new AWS DynamoDB tables.

The portal is developed in a **separate web-development repository**; repository
initialization is deferred to an implementation task. The desktop app's activation flow, the
signing private key, and the client-embedded public key are out of scope for modification —
the portal must not weaken license-token integrity.

This document defines the requirements. The recommended technology direction is captured here
as context only; the design phase will finalize technical choices. The current direction is a
stateless full-stack web application (Next.js + React + TypeScript on Node.js) running on a
single, disposable VPS behind Nginx (TLS termination); the VPS stores no data locally so it
can be rehosted at any time. Authentication and user identity are provided by Firebase
Authentication (managed), with the server verifying Firebase-issued ID tokens statelessly via
the Firebase Admin SDK — no session state is stored on the VPS. The MFA second factor is an
email-delivered one-time passcode (OTP) sent through an email provider such as Resend; the
short-lived OTP challenge state is stored in AWS DynamoDB (hashed, with a TTL), not on the
VPS. All of the portal's own operational data — admin role mappings, reseller accounts, API
keys, rate-limit/quota counters, SEO settings, release metadata, and the append-only audit
log — is stored in AWS DynamoDB tables, and API-key rate limiting and monthly quota are
enforced by the portal itself using DynamoDB atomic counters. The existing AWS licensing
backend is retained unchanged and accessed from the VPS via the AWS SDK — the `pdm-licenses`
DynamoDB table, the ECDSA P-256 signing keys in SSM SecureString, and the release S3 bucket
`pdm-updates-452359090613-aps1`. Amazon Cognito, API Gateway usage plans, Cloud Firestore,
Redis, and Postgres are NOT used, while Firebase Authentication IS used (for identity only).

## Glossary

- **Admin_Reseller_Portal**: The complete authenticated web application (frontend + portal
  backend + new data stores) defined by this specification, excluding the existing licensing
  Lambdas, the desktop client, and the static marketing website.
- **Portal_Frontend**: The browser-based dashboard UI of the Admin_Reseller_Portal.
- **Portal_Backend**: The server-side API of the Admin_Reseller_Portal that the
  Portal_Frontend and reseller integrations call, distinct from the existing licensing
  Lambdas.
- **Licensing_Backend**: The pre-existing serverless licensing service in region
  `ap-south-1`, comprising the `pdm-licenses` DynamoDB table, the activate/validate/trial
  Lambda functions, the HTTP API Gateway at
  `https://pgwoailzqa.execute-api.ap-south-1.amazonaws.com`, and the ECDSA P-256 signing keys
  in SSM SecureString.
- **Licenses_Table**: The existing DynamoDB table `pdm-licenses` in `ap-south-1`, partition
  key `licenseKey`, holding License_Record and trial-anchor items.
- **License_Record**: An item in the Licenses_Table representing one license, with attributes
  `licenseKey`, `status`, `plan`, `owner`, `features`, `maxActivations`, `expiresAt`,
  `activations`, `createdAt`.
- **License_Key**: The identifier of a License_Record, formatted `PDM-XXXX-XXXX-XXXX-XXXX`
  where each `XXXX` group is four uppercase hexadecimal characters.
- **License_Status**: The `status` attribute of a License_Record, one of the exact values
  `active`, `revoked`, or `suspended`.
- **Activation_Entry**: One key/value pair in a License_Record's `activations` map, where the
  key is a 64-character hexadecimal machine fingerprint and the value is
  `{ activatedAt, lastSeenAt }`.
- **Portal_User**: Any authenticated principal of the Admin_Reseller_Portal, either an
  Admin_User or a Reseller_User.
- **Admin_User**: A Portal_User belonging to the PDM team, holding an Admin_Role.
- **Reseller_User**: A Portal_User belonging to a Reseller_Account, permitted to manage only
  licenses owned by that Reseller_Account.
- **Reseller_Account**: A record representing a reseller or distributor organization, owning a
  set of License_Records and one or more Api_Keys.
- **Admin_Role**: One of the exact role values `super_admin` or `admin` assigned to an
  Admin_User; `super_admin` additionally may manage Admin_Users and Reseller_Accounts.
- **Permission**: A named capability (for example `license:create`, `license:revoke`,
  `release:update`, `seo:update`, `apikey:create`) that gates a Portal_Backend operation.
- **Session**: An authenticated, time-bounded context established after a Portal_User
  completes login (including MFA where required).
- **MFA**: Multi-factor authentication using an email-delivered one-time passcode (OTP) as
  the second factor.
- **Api_Key**: A secret credential issued to a Reseller_Account for programmatic access to the
  Reseller_API, associated with a Usage_Plan.
- **Reseller_API**: The subset of Portal_Backend endpoints callable with an Api_Key that let a
  Reseller_Account create and manage its own License_Records programmatically.
- **Usage_Plan**: The rate-limit and quota configuration bound to an Api_Key, defining a
  sustained request rate, a burst allowance, and a maximum request count per calendar month.
- **Rate_Limit**: The maximum sustained request rate and burst allowance enforced per Api_Key.
- **Quota**: The maximum number of requests an Api_Key may make within one calendar month.
- **Release_Metadata**: The current-release information the marketing site and desktop
  auto-updater consume: version string, MSI_Url, Portable_Zip_Url, their SHA-256 checksums,
  and release notes.
- **Release_Manifest**: The ECDSA-signed `manifest.json` in the S3 bucket
  `pdm-updates-452359090613-aps1` (region `ap-south-1`) produced by
  `backend/updates/sign-release.ps1`, which the desktop auto-updater trusts.
- **MSI_Url**: The S3 URL of the current release's Windows MSI installer.
- **Portable_Zip_Url**: The S3 URL of the current release's portable/update zip.
- **Signing_Key**: The ECDSA P-256 private key (for release manifests and/or license tokens)
  held only in AWS SSM SecureString and never exposed to the Portal_Frontend or a
  Reseller_User.
- **Seo_Settings**: The set of editable SEO fields per marketing-site page: page title, meta
  description, and Open Graph tags (`og:title`, `og:description`, `og:image`).
- **Audit_Log**: An append-only store recording every mutating action performed through the
  Admin_Reseller_Portal.
- **Audit_Entry**: One immutable record in the Audit_Log capturing actor identity, action,
  target, before/after values where applicable, timestamp, and source IP.
- **Mutation**: Any Portal_Backend operation that creates, updates, or deletes persistent
  state (a License_Record, Reseller_Account, Admin_User, Api_Key, Release_Metadata, or
  Seo_Settings).

## Requirements

### Requirement 1: Admin Authentication

**User Story:** As an Admin_User, I want to sign in with a password and a second factor, so
that only authorized PDM staff can reach the management dashboard.

#### Acceptance Criteria

1. WHEN an unauthenticated request is made to any Portal_Frontend management page, THE
   Admin_Reseller_Portal SHALL redirect the request to the login page.
2. WHEN an Admin_User submits valid credentials and a valid MFA code, THE Portal_Backend
   SHALL establish a Session and return a session credential to the Portal_Frontend.
3. IF an Admin_User submits invalid credentials, THEN THE Portal_Backend SHALL reject the
   login attempt and return an authentication-failed response that does not disclose which
   credential field was incorrect.
4. WHERE an Admin_User account has MFA enrolled, THE Portal_Backend SHALL require a valid MFA
   code in addition to the password before establishing a Session.
5. WHEN an Admin_User has no MFA factor enrolled and completes a password login, THE
   Portal_Backend SHALL require MFA enrollment before granting access to any Mutation
   operation.
6. IF 5 consecutive failed login attempts occur for one Admin_User within 15 minutes, THEN
   THE Portal_Backend SHALL temporarily lock that account for at least 15 minutes and reject
   further login attempts during the lock window.
7. WHEN a Session has been idle for 30 minutes, THE Portal_Backend SHALL treat the Session as
   expired and require re-authentication before performing any further operation.
8. WHEN an Admin_User signs out, THE Portal_Backend SHALL invalidate the Session credential
   such that subsequent requests using that credential are rejected.

### Requirement 2: Role-Based Authorization

**User Story:** As a PDM team lead, I want each Portal_User's actions gated by role and
permission, so that resellers cannot touch admin-only settings and only super admins can
manage other users.

#### Acceptance Criteria

1. THE Portal_Backend SHALL assign each Portal_User exactly one of the roles `super_admin`,
   `admin`, or `reseller`.
2. WHEN a Portal_User requests an operation, THE Portal_Backend SHALL authorize the operation
   only when the Portal_User's role holds the Permission required by that operation.
3. IF a Portal_User requests an operation for which the Portal_User's role lacks the required
   Permission, THEN THE Portal_Backend SHALL reject the operation with a not-authorized
   response and SHALL NOT modify any persistent state.
4. WHERE a Portal_User holds the `reseller` role, THE Portal_Backend SHALL restrict that
   user's license operations to License_Records owned by the user's Reseller_Account.
5. WHERE a Portal_User holds the `admin` role, THE Portal_Backend SHALL deny operations that
   create, modify, or delete Admin_Users and Reseller_Accounts.
6. WHERE a Portal_User holds the `super_admin` role, THE Portal_Backend SHALL permit
   management of Admin_Users, Reseller_Accounts, License_Records, Release_Metadata,
   Seo_Settings, and Api_Keys.
7. WHEN a Reseller_User requests a License_Record that is not owned by the user's
   Reseller_Account, THE Portal_Backend SHALL respond as though the License_Record does not
   exist for that user.

### Requirement 3: Create License

**User Story:** As an Admin_User or authorized Reseller_User, I want to mint a new license
through the portal, so that I can issue keys without running CLI scripts.

#### Acceptance Criteria

1. WHEN a Portal_User with the `license:create` Permission submits a create-license request
   with a `plan`, a `maxActivations` value, an optional `owner`, an optional `expiresAt`, and
   an optional `features` list, THE Portal_Backend SHALL generate a unique License_Key in the
   format `PDM-XXXX-XXXX-XXXX-XXXX` and write a new License_Record to the Licenses_Table.
2. WHEN a License_Record is created, THE Portal_Backend SHALL set its `status` to `active`,
   its `activations` to an empty map, and its `createdAt` to the creation time in ISO 8601
   UTC.
3. THE Portal_Backend SHALL write each new License_Record only when no existing License_Record
   shares the same License_Key.
4. IF the submitted `maxActivations` is not an integer of at least 1, THEN THE Portal_Backend
   SHALL reject the request with a validation error and SHALL NOT write a License_Record.
5. IF the submitted `expiresAt` is present and is not a valid ISO 8601 date-time, THEN THE
   Portal_Backend SHALL reject the request with a validation error and SHALL NOT write a
   License_Record.
6. WHERE a Reseller_User creates a License_Record, THE Portal_Backend SHALL record the
   creating Reseller_Account as the owner association of that License_Record.
7. WHEN a License_Record is created, THE Portal_Backend SHALL write an Audit_Entry recording
   the actor, the generated License_Key, and the submitted attributes.

### Requirement 4: List and View Licenses

**User Story:** As a Portal_User, I want to list, search, and open individual licenses, so
that I can find a customer's key and inspect its state.

#### Acceptance Criteria

1. WHEN an Admin_User requests the license list, THE Portal_Backend SHALL return License_Records
   from the Licenses_Table excluding trial-anchor items whose `licenseKey` begins with
   `TRIAL#`.
2. WHEN a Reseller_User requests the license list, THE Portal_Backend SHALL return only
   License_Records owned by the user's Reseller_Account.
3. WHEN a Portal_User requests a license list larger than one page, THE Portal_Backend SHALL
   return results in pages and provide a continuation token for retrieving the next page.
4. WHEN a Portal_User submits a search by License_Key or by `owner`, THE Portal_Backend SHALL
   return the matching License_Records the user is authorized to view.
5. WHEN a Portal_User opens a single License_Record the user is authorized to view, THE
   Portal_Backend SHALL return its `licenseKey`, `status`, `plan`, `owner`, `features`,
   `maxActivations`, `expiresAt`, `createdAt`, and its Activation_Entries.
6. IF a Portal_User requests a License_Key that does not correspond to a viewable
   License_Record, THEN THE Portal_Backend SHALL return a not-found response.

### Requirement 5: Update License Status

**User Story:** As a Portal_User, I want to change a license's status, so that I can revoke or
suspend a compromised or non-paying customer's license and reactivate it later.

#### Acceptance Criteria

1. WHEN a Portal_User with the `license:update` Permission sets a License_Record's
   License_Status to one of `active`, `revoked`, or `suspended`, THE Portal_Backend SHALL
   update the License_Record's `status` attribute to that value.
2. IF a status-change request specifies a value other than `active`, `revoked`, or
   `suspended`, THEN THE Portal_Backend SHALL reject the request with a validation error and
   SHALL leave the License_Record's `status` unchanged.
3. WHEN a License_Record's License_Status is changed, THE Portal_Backend SHALL write an
   Audit_Entry recording the actor, the License_Key, the previous status, and the new status.
4. WHEN a Portal_User changes a License_Record's License_Status, THE Portal_Backend SHALL
   apply the change to the same Licenses_Table item that the Licensing_Backend
   validate/activate Lambdas read, so that the change takes effect on the license's next
   validation.
5. WHEN a status-change request completes successfully, THE Portal_Backend SHALL guarantee
   that the persisted `status` attribute of the License_Record equals the requested
   License_Status.

### Requirement 6: Update License Attributes

**User Story:** As a Portal_User, I want to adjust a license's plan, activation limit, expiry,
owner, and features, so that I can upgrade, extend, or correct a customer's license.

#### Acceptance Criteria

1. WHEN a Portal_User with the `license:update` Permission submits new values for any of
   `plan`, `maxActivations`, `expiresAt`, `owner`, or `features` on a viewable License_Record,
   THE Portal_Backend SHALL update exactly the submitted attributes on that License_Record and
   leave unsubmitted attributes unchanged.
2. IF a submitted `maxActivations` is not an integer of at least 1, THEN THE Portal_Backend
   SHALL reject the request with a validation error and SHALL leave the License_Record
   unchanged.
3. IF a submitted `maxActivations` is less than the current number of Activation_Entries on
   the License_Record, THEN THE Portal_Backend SHALL reject the request with a validation
   error identifying the current activation count and SHALL leave the License_Record unchanged.
4. IF a submitted `expiresAt` is present and is not a valid ISO 8601 date-time, THEN THE
   Portal_Backend SHALL reject the request with a validation error and SHALL leave the
   License_Record unchanged.
5. WHEN a Portal_User submits an empty `expiresAt` clearing the value, THE Portal_Backend
   SHALL remove the `expiresAt` attribute so the License_Record becomes perpetual.
6. WHEN any License_Record attribute is updated, THE Portal_Backend SHALL write an Audit_Entry
   recording the actor, the License_Key, and the changed attributes with their previous and
   new values.

### Requirement 7: Activation Management

**User Story:** As a Portal_User, I want to view and remove a license's per-machine
activations, so that I can help a customer move their license to a new computer.

#### Acceptance Criteria

1. WHEN a Portal_User opens a viewable License_Record, THE Portal_Backend SHALL return each
   Activation_Entry's machine fingerprint, `activatedAt`, and `lastSeenAt`.
2. IF a Portal_User requests the Activation_Entries of a License_Record that is not viewable
   by that user, THEN THE Portal_Backend SHALL return a not-found response and SHALL NOT
   return any Activation_Entry.
3. WHEN a Portal_User with the `license:update` Permission removes an Activation_Entry from a
   viewable License_Record, THE Portal_Backend SHALL delete that fingerprint's entry from the
   License_Record's `activations` map.
4. IF a Portal_User requests removal of a fingerprint that is not present in the
   License_Record's `activations` map, THEN THE Portal_Backend SHALL return a not-found
   response and SHALL leave the `activations` map unchanged.
5. WHEN an Activation_Entry is removed, THE Portal_Backend SHALL write an Audit_Entry recording
   the actor, the License_Key, and the removed fingerprint.
6. THE Portal_Backend SHALL display the current count of Activation_Entries alongside the
   License_Record's `maxActivations` value.

### Requirement 8: Release and Download Management

**User Story:** As an Admin_User, I want to update the current release's version, download
links, checksums, and notes, so that the marketing site and the app's auto-updater point at
the right build.

#### Acceptance Criteria

1. WHEN an Admin_User with the `release:update` Permission views the release section, THE
   Portal_Backend SHALL return the current Release_Metadata including version string, MSI_Url,
   Portable_Zip_Url, the MSI and portable SHA-256 checksums, and release notes.
2. WHEN an Admin_User submits updated Release_Metadata, THE Portal_Backend SHALL persist the
   new version string, MSI_Url, Portable_Zip_Url, checksums, and release notes as the current
   release.
3. IF a submitted MSI_Url or Portable_Zip_Url is not an `https` URL under the S3 bucket
   `pdm-updates-452359090613-aps1`, THEN THE Portal_Backend SHALL reject the request with a
   validation error and SHALL leave the Release_Metadata unchanged.
4. IF a submitted checksum is not a 64-character hexadecimal string, THEN THE Portal_Backend
   SHALL reject the request with a validation error and SHALL leave the Release_Metadata
   unchanged.
5. WHERE publishing Release_Metadata requires updating the ECDSA-signed Release_Manifest, THE
   Portal_Backend SHALL perform the signing on the server using the Signing_Key held in SSM
   SecureString and SHALL NOT expose the Signing_Key to the Portal_Frontend.
6. WHEN Release_Metadata is updated, THE Portal_Backend SHALL write an Audit_Entry recording
   the actor, the previous version string, and the new version string.

### Requirement 9: SEO Settings Management

**User Story:** As an Admin_User, I want to edit the marketing site's SEO fields, so that I
can tune search titles, descriptions, and social previews without editing site code.

#### Acceptance Criteria

1. WHEN an Admin_User with the `seo:update` Permission opens the SEO section, THE
   Portal_Backend SHALL return the current Seo_Settings for each managed marketing-site page,
   comprising page title, meta description, and Open Graph tags.
2. WHEN an Admin_User submits updated Seo_Settings for a page, THE Portal_Backend SHALL persist
   the submitted page title, meta description, and Open Graph tag values for that page.
3. IF a submitted page title is empty or longer than 70 characters, THEN THE Portal_Backend
   SHALL reject the request with a validation error and SHALL leave that page's Seo_Settings
   unchanged.
4. IF a submitted meta description is shorter than 50 characters or longer than 160
   characters, THEN THE Portal_Backend SHALL reject the request with a validation error and
   SHALL leave that page's Seo_Settings unchanged.
5. WHEN the marketing site or another authorized consumer requests the current Seo_Settings,
   THE Portal_Backend SHALL return them in a machine-readable JSON form.
6. WHEN Seo_Settings for a page are updated, THE Portal_Backend SHALL write an Audit_Entry
   recording the actor, the page identifier, and the changed fields with previous and new
   values.

### Requirement 10: Reseller Account Management

**User Story:** As a super admin, I want to create and manage reseller accounts, so that I can
onboard distributors and control their access.

#### Acceptance Criteria

1. WHEN an Admin_User with the `super_admin` role creates a Reseller_Account with an
   organization name and a contact email, THE Portal_Backend SHALL persist a new
   Reseller_Account with a unique identifier and an `active` state.
2. WHEN a super admin suspends a Reseller_Account, THE Portal_Backend SHALL set that account's
   state to `suspended` and SHALL reject subsequent Reseller_API requests authenticated by any
   Api_Key belonging to that account.
3. WHEN a super admin reactivates a suspended Reseller_Account, THE Portal_Backend SHALL set
   that account's state to `active` and SHALL again accept Reseller_API requests from its
   active Api_Keys.
4. IF a create-reseller request omits the organization name or the contact email, THEN THE
   Portal_Backend SHALL reject the request with a validation error and SHALL NOT create a
   Reseller_Account.
5. WHEN a Reseller_Account is created, suspended, or reactivated, THE Portal_Backend SHALL
   write an Audit_Entry recording the actor, the Reseller_Account identifier, and the action.

### Requirement 11: API Key and Usage Plan Management

**User Story:** As a super admin, I want to issue scoped API keys with rate limits and quotas
to resellers, so that distributors can automate license management without unbounded access.

#### Acceptance Criteria

1. WHEN a super admin issues an Api_Key for a Reseller_Account, THE Portal_Backend SHALL
   generate a new secret Api_Key bound to that Reseller_Account and a Usage_Plan, and SHALL
   return the secret value exactly once at creation time.
2. THE Portal_Backend SHALL store only a non-reversible representation of each Api_Key secret
   such that the plaintext secret cannot be retrieved after creation.
3. WHEN a super admin revokes an Api_Key, THE Portal_Backend SHALL reject Reseller_API
   requests authenticated by that Api_Key that arrive after the revocation, while permitting
   requests already in flight at the moment of revocation to complete.
4. WHEN a super admin assigns a Usage_Plan to an Api_Key, THE Portal_Backend SHALL enforce
   that plan's sustained Rate_Limit, burst allowance, and monthly Quota for requests using
   that Api_Key.
5. WHERE an Api_Key has no Usage_Plan assigned, THE Portal_Backend SHALL enforce a default
   Rate_Limit, burst allowance, and monthly Quota for requests using that Api_Key.
6. WHEN an Api_Key is created, revoked, or has its Usage_Plan changed, THE Portal_Backend SHALL
   write an Audit_Entry recording the actor, the Api_Key identifier, the Reseller_Account, and
   the action, and SHALL NOT record the plaintext secret in the Audit_Entry.

### Requirement 12: Reseller API Access

**User Story:** As a Reseller_User, I want to create and manage my own licenses over an
authenticated API, so that I can integrate PDM licensing into my own systems.

#### Acceptance Criteria

1. WHEN a Reseller_API request presents a valid, non-revoked Api_Key belonging to an active
   Reseller_Account, THE Portal_Backend SHALL authenticate the request as that
   Reseller_Account.
2. IF a Reseller_API request presents a missing, malformed, revoked, or unknown Api_Key, THEN
   THE Portal_Backend SHALL reject the request with an authentication-failed response and
   SHALL NOT perform the requested operation.
3. WHEN an authenticated Reseller_API request creates or updates a License_Record, THE
   Portal_Backend SHALL apply the same validation and Audit_Entry rules defined in
   Requirements 3, 5, 6, and 7.
4. WHEN an authenticated Reseller_API request reads or modifies licenses, THE Portal_Backend
   SHALL restrict the request to License_Records owned by the authenticated Reseller_Account.
5. IF a Reseller_API request exceeds its Api_Key's Rate_Limit, THEN THE Portal_Backend SHALL
   reject the excess requests with a rate-limit-exceeded response carrying HTTP status 429.
6. IF a Reseller_API request exceeds its Api_Key's monthly Quota, THEN THE Portal_Backend
   SHALL reject the request with a quota-exceeded response carrying HTTP status 429 until the
   next calendar month.
7. THE Reseller_API SHALL accept and return JSON and SHALL be served only over HTTPS.

### Requirement 13: Audit Logging

**User Story:** As a super admin, I want every change recorded in an immutable audit log, so
that I can investigate incidents and prove who changed what.

#### Acceptance Criteria

1. WHEN any Mutation completes successfully, THE Portal_Backend SHALL append an Audit_Entry
   recording the actor identity, the actor's role, the action, the target identifier, the
   source IP address, and a timestamp in ISO 8601 UTC.
2. WHERE a Mutation changes attribute values, THE Audit_Entry SHALL record the previous and
   new values of each changed attribute, excluding any secret value.
3. THE Portal_Backend SHALL store Audit_Entries in an append-only manner such that no
   Portal_User operation updates or deletes an existing Audit_Entry.
4. WHEN an Admin_User with the `audit:read` Permission queries the Audit_Log by actor, target,
   action, or time range, THE Portal_Backend SHALL return the matching Audit_Entries.
5. THE Portal_Backend SHALL NOT record any Signing_Key, Api_Key plaintext secret, password, or
   MFA secret in any Audit_Entry.

### Requirement 14: Reuse of Existing Licensing Backend

**User Story:** As a maintainer, I want the portal to operate on the existing licensing data
and infrastructure, so that portal changes are immediately honored by the desktop app without
duplicating or migrating data.

#### Acceptance Criteria

1. THE Portal_Backend SHALL read and write License_Records in the existing `pdm-licenses`
   DynamoDB table in region `ap-south-1` and SHALL NOT create a duplicate copy of
   License_Records.
2. THE Portal_Backend SHALL preserve the existing License_Record schema attributes
   (`licenseKey`, `status`, `plan`, `owner`, `features`, `maxActivations`, `expiresAt`,
   `activations`, `createdAt`) so that the activate/validate/trial Lambdas continue to read
   them without modification.
3. WHERE the Portal_Backend adds owner-association or reseller metadata to a License_Record,
   THE Portal_Backend SHALL store it in attributes that do not collide with the existing
   schema attributes named in criterion 2.
4. THE Portal_Backend SHALL NOT modify trial-anchor items whose `licenseKey` begins with
   `TRIAL#`.
5. THE Admin_Reseller_Portal SHALL store its own operational data (Admin_Users,
   Reseller_Accounts, Api_Keys, Audit_Log) in data stores separate from the Licenses_Table.

### Requirement 15: Security Posture and Signing-Key Protection

**User Story:** As a security owner, I want the portal to protect the signing keys and license
integrity, so that adding a management UI does not create a path to forge licenses or serve
tampered releases.

#### Acceptance Criteria

1. THE Admin_Reseller_Portal SHALL NOT transmit, display, or expose any Signing_Key to the
   Portal_Frontend, a Reseller_User, or the Reseller_API.
2. WHERE a Portal_Backend operation requires the Signing_Key, THE Portal_Backend SHALL access
   it only from AWS SSM SecureString at the time of use and SHALL NOT persist it outside SSM.
3. THE Admin_Reseller_Portal SHALL serve all Portal_Frontend and Portal_Backend traffic only
   over HTTPS.
4. THE Portal_Backend SHALL validate and sanitize every client-supplied input against its
   expected type and format before using it in a DynamoDB operation or a response.
5. WHEN the Portal_Backend returns a License_Record to a Reseller_User, THE Portal_Backend
   SHALL exclude License_Records not owned by that user's Reseller_Account.
6. THE Portal_Backend SHALL apply the least-privilege IAM permissions required for its
   DynamoDB, SSM, and S3 operations and SHALL NOT grant the Portal_Frontend direct write
   access to the Licenses_Table, the SSM Signing_Key, or the S3 release bucket.
7. IF the Portal_Backend detects a request whose session credential or Api_Key is expired,
   revoked, or invalid, THEN THE Portal_Backend SHALL reject the request without performing
   the requested operation.
