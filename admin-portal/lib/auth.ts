/**
 * Authentication, MFA (email-OTP), session, and Api_Key authorization library.
 *
 * The portal uses password-based JWT authentication for all users (admins,
 * distributors, resellers, and dealers).
 *
 *  - Role / `resellerAccountId` resolution from `pdm-portal-admins` and
 *    `pdm-portal-resellers` tables.
 *  - Password authentication using bcrypt hashing.
 *  - JWT token generation and verification with 7-day expiration.
 *  - `lastSeenAt` 30-minute idle-expiry (Req 1.7) and logout invalidation
 *    (Req 1.8).
 *  - Api_Key authentication by SHA-256 hash match plus key-revocation and
 *    reseller-suspension checks (Req 12.1, 12.2).
 *  - A uniform `authentication_failed` result that never discloses which field
 *    was wrong (Req 1.3, 15.7).
 *
 * Everything external is injected — the {@link DynamoClient}, the one-way
 * {@link Hasher}, the clock, and the password hasher — so property/unit tests
 * can drive the module entirely with in-memory fakes and never touch live AWS.
 *
 * @module lib/auth
 * Requirements: 1.2, 1.3, 1.4, 1.7, 1.8, 2.1, 2.2, 2.4, 2.7,
 *               12.1, 12.2, 15.7
 */

import { createHash, randomInt } from "node:crypto";
import bcrypt from "bcryptjs";
import type { DynamoClient, DynamoItem } from "./dynamo.ts";
import type { EmailSender } from "./email.ts";
import { hasPermission, type Permission, type Role } from "./rbac.ts";
import { validateApiKey, validateEmailOtp } from "./validation.ts";

// ─── Outcome / error types ───────────────────────────────────────────────────

/**
 * Every rejection maps to one of these codes. The interactive credential
 * failures (invalid token, wrong OTP, unknown user) always collapse to the
 * single opaque `authentication_failed` code so callers cannot learn which
 * field was wrong (Req 1.3, 15.7).
 */
export type AuthErrorCode =
  | "authentication_failed"
  | "not_authorized"
  | "not_found"
  | "mfa_required"
  | "account_locked"
  | "session_expired";

/** A rejection reason. */
export interface AuthError {
  code: AuthErrorCode;
  message: string;
}

/** Discriminated-union outcome returned by every auth operation. */
export type AuthOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: AuthError };

/**
 * The single, uniform authentication-failure error. Reused verbatim for every
 * invalid-credential path so the response cannot leak which field was wrong.
 */
export const AUTHENTICATION_FAILED: AuthError = Object.freeze({
  code: "authentication_failed",
  message: "Authentication failed",
});

function ok<T>(value: T): AuthOutcome<T> {
  return { ok: true, value };
}

function fail<T = never>(error: AuthError): AuthOutcome<T> {
  return { ok: false, error };
}

/** The uniform authentication-failure outcome. */
function authFailed<T = never>(): AuthOutcome<T> {
  return { ok: false, error: AUTHENTICATION_FAILED };
}

// ─── Principal ─────────────────────────────────────────────────────────────

/** How the caller authenticated. */
export type AuthMethod = "password" | "apikey" | "firebase";

/** The resolved caller identity, recomputed server-side on every request. */
export interface Principal {
  /** Firebase UID for interactive users, or apiKeyId for Reseller_API callers. */
  identity: string;
  /** Authorization role. */
  role: Role;
  /** Owning reseller account, or null for admin/super_admin principals. */
  resellerAccountId: string | null;
  /** True once an email-OTP verification has succeeded (always true for keys). */
  mfaEnrolled: boolean;
  /** Which credential type authenticated this principal. */
  authMethod: AuthMethod;
  /** Password-session generation used to revoke previously issued JWTs. */
  sessionVersion?: number;
}

// ─── Injected collaborators ──────────────────────────────────────────────────

/** Monotonic-ish clock. Injected so tests can pin/advance time. */
export type Clock = () => Date;

/** A verified Firebase ID token. */
export interface VerifiedToken {
  uid: string;
  /** Decoded custom claims (may carry `role` / `resellerAccountId`). */
  claims?: Record<string, unknown>;
}

/**
 * Abstraction over Firebase Admin SDK ID-token verification. Injecting this
 * means tests supply a fake and never require live Firebase.
 */
export interface TokenVerifier {
  /**
   * Verify a Firebase ID token. MUST reject (throw) on an absent, malformed,
   * expired, or (when `checkRevoked`) revoked token.
   */
  verifyIdToken(idToken: string, checkRevoked?: boolean): Promise<VerifiedToken>;
  /** Revoke a user's refresh tokens (logout). Optional. */
  revokeRefreshTokens?(uid: string): Promise<void>;
}

/** One-way hasher used for OTP and Api_Key secrets. */
export interface Hasher {
  hash(input: string): string;
}

/** Default SHA-256 hex hasher backed by node:crypto. */
export const sha256Hasher: Hasher = {
  hash(input: string): string {
    return createHash("sha256").update(input, "utf8").digest("hex");
  },
};

// ─── Password Hashing (bcrypt) ───────────────────────────────────────────────

/** Number of bcrypt rounds for password hashing (10 = ~100ms per hash). */
const BCRYPT_ROUNDS = 10;

/**
 * Password hasher interface for distributor/reseller/dealer authentication.
 * Uses bcrypt for secure password storage with salt + hashing.
 */
export interface PasswordHasher {
  /** Hash a plaintext password into a bcrypt hash string. */
  hash(password: string): Promise<string>;
  /** Verify a plaintext password against a stored bcrypt hash. */
  verify(password: string, hash: string): Promise<boolean>;
}

/** Default bcrypt-based password hasher. */
export const bcryptPasswordHasher: PasswordHasher = {
  async hash(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
  },
  async verify(password: string, hash: string): Promise<boolean> {
    try {
      return await bcrypt.compare(password, hash);
    } catch {
      // Invalid hash format or bcrypt error
      return false;
    }
  },
};

// ───────────────────────────────────────────────────────────────────────────────

/** Default OTP generator: a cryptographically random 6-digit code. */
export function defaultOtpGenerator(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** DynamoDB table names the auth layer reads/writes. */
export interface AuthTableNames {
  admins: string;
  apiKeys: string;
  resellers: string;
  /** GSI on the api-keys table keyed by `secretHash`. */
  apiKeySecretHashIndex: string;
}

const DEFAULT_TABLES: AuthTableNames = {
  admins: "pdm-portal-admins",
  apiKeys: "pdm-portal-apikeys",
  resellers: "pdm-portal-resellers",
  apiKeySecretHashIndex: "secretHash-index",
};

/** Dependencies for {@link createAuthenticator}. */
export interface AuthDeps {
  dynamo: DynamoClient;
  /** Legacy Firebase verifier; not configured by the password-only portal. */
  tokenVerifier?: TokenVerifier;
  /** Legacy OTP email sender; not configured by the password-only portal. */
  emailSender?: EmailSender;
  /** OTP generator override for tests. */
  otpGenerator?: () => string;
  /** One-way hasher (defaults to SHA-256 hex). */
  hasher?: Hasher;
  /** Password hasher for all accounts (defaults to bcrypt). */
  passwordHasher?: PasswordHasher;
  /** Clock (defaults to `() => new Date()`). */
  now?: Clock;
  /** Table-name overrides. */
  tables?: Partial<AuthTableNames>;
}

// ─── Tunable policy constants ────────────────────────────────────────────────

/** Idle window after which a session must re-authenticate (Req 1.7). */
export const SESSION_IDLE_LIMIT_MS = 30 * 60 * 1000;
/** Lifetime of a pending OTP challenge (Req 1.4). */
export const OTP_TTL_MS = 10 * 60 * 1000;
/** Window over which failed OTP attempts accumulate toward a lockout (Req 1.6). */
export const OTP_FAILURE_WINDOW_MS = 15 * 60 * 1000;
/** Minimum duration an account stays locked after too many failures (Req 1.6). */
export const OTP_LOCK_DURATION_MS = 15 * 60 * 1000;
/** Number of failed OTP attempts within the window that triggers a lock (Req 1.6). */
export const MAX_OTP_FAILURES = 5;

// ─── Persisted record shapes ─────────────────────────────────────────────────

/** Row in `pdm-portal-admins`. Supports both legacy Firebase auth and new password auth. */
export interface AdminRecord {
  adminId: string;
  email: string;
  role: Role;
  passwordHash?: string; // Password hash for password-based authentication
  sessionVersion?: number;
  state?: "active" | "suspended";
  resellerAccountId?: string | null;
  mfaEnrolled?: boolean;
  /** @deprecated Legacy Firebase UID - will be removed after migration */
  firebaseUid?: string;
  /** One-way hash of the pending OTP (never plaintext). */
  otpHash?: string;
  otpExpiresAt?: string;
  otpAttempts?: number;
  failedOtp?: number;
  failedOtpWindowStart?: string;
  lockUntil?: string;
  /** Last authorized-request time; absent means no open session (logged out). */
  lastSeenAt?: string;
  sessionTtl?: number;
  createdAt?: string;
}

/** Row in `pdm-portal-apikeys`. */
export interface ApiKeyRecord {
  apiKeyId: string;
  resellerAccountId: string;
  secretHash: string;
  rateLimitPerSec?: number;
  burst?: number;
  monthlyQuota?: number;
  state: "active" | "revoked";
  createdAt?: string;
}

/** Row in `pdm-portal-resellers`. */
export interface ResellerAccountRecord {
  resellerAccountId: string;
  accountType: "distributor" | "reseller" | "dealer";
  orgName: string;
  contactEmail: string;
  passwordHash: string;
  state: "active" | "suspended";
  sessionVersion?: number;
  
  // Balance & pricing
  balance: number;
  discountPercent: number;
  
  // Hierarchy
  parentAccountId?: string;
  
  // Timestamps
  createdAt?: string;
  lastLoginAt?: string;
}

/** Minimal shape needed for the ownership check on a License_Record. */
export interface OwnableRecord {
  resellerAccountId?: string | null;
}

// ─── The Authenticator ───────────────────────────────────────────────────────

/** Public auth API produced by {@link createAuthenticator}. */
export interface Authenticator {
  /**
   * Per-request interactive gate: verify the Firebase ID token, resolve the
   * role, enforce logout invalidation and 30-minute idle expiry, then refresh
   * the activity timestamp and return the principal (Req 1.2, 1.7, 1.8).
   */
  authenticate(input: { idToken: string }): Promise<AuthOutcome<Principal>>;

  /** Issue a fresh single-use OTP, persist only its hash, and email it (Req 1.4). */
  requestOtp(input: { firebaseUid: string }): Promise<AuthOutcome<void>>;

  /**
   * Verify a submitted OTP against the stored hash within its TTL. On success
   * marks the factor enrolled and opens the session; on failure advances the
   * lockout counter (Req 1.4, 1.5, 1.6).
   */
  verifyOtp(input: {
    firebaseUid: string;
    otp: string;
  }): Promise<AuthOutcome<Principal>>;

  /**
   * Open a session WITHOUT the email-OTP factor. Used only when the OTP step is
   * intentionally disabled (local dev / PORTAL_DISABLE_OTP): resolves the admin,
   * marks the factor satisfied, and opens the session-activity record. Never
   * wired up in production auth flows.
   */
  openSession(input: { firebaseUid: string }): Promise<AuthOutcome<Principal>>;

  /** Invalidate the session: revoke refresh tokens and clear activity (Req 1.8). */
  logout(input: { firebaseUid: string }): Promise<AuthOutcome<void>>;

  /**
   * Authenticate a Reseller_API request by Api_Key: SHA-256 hash match, key
   * not revoked, owning account not suspended (Req 12.1, 12.2).
   */
  authenticateApiKey(input: {
    apiKey: string;
  }): Promise<AuthOutcome<Principal>>;

  /**
   * Authenticate a distributor/reseller/dealer by email and password.
   * Verifies password hash, checks account state, and updates lastLoginAt.
   * Returns a Principal with the account's role derived from accountType.
   */
  authenticatePassword(input: {
    email: string;
    password: string;
  }): Promise<AuthOutcome<Principal>>;

  /** Resolve and validate a password JWT against the current account record. */
  authenticateJwtSession(input: {
    accountId: string;
    email: string;
    role: Role;
    resellerAccountId: string | null;
    sessionVersion: number;
  }): Promise<AuthOutcome<Principal>>;

  /** Revoke all password JWTs for the account by advancing its session version. */
  logoutPasswordSession(input: {
    accountId: string;
    email: string;
    role: Role;
  }): Promise<AuthOutcome<void>>;

  /** RBAC check delegating to `lib/rbac.hasPermission` (Req 2.2). */
  requirePermission(
    principal: Principal,
    permission: Permission
  ): AuthOutcome<void>;

  /** Block Mutations for principals that have not enrolled the OTP factor (Req 1.5). */
  requireMfaEnrolled(principal: Principal): AuthOutcome<void>;

  /**
   * Ownership scoping for resellers: a reseller may only touch its own
   * `resellerAccountId`; a non-owned record is reported as not-found (Req 2.7).
   */
  assertOwnership(
    principal: Principal,
    record: OwnableRecord
  ): AuthOutcome<void>;
}

/**
 * Build an {@link Authenticator} from injected collaborators.
 */
export function createAuthenticator(deps: AuthDeps): Authenticator {
  const dynamo = deps.dynamo;
  const tokenVerifier = deps.tokenVerifier ?? {
    async verifyIdToken(): Promise<VerifiedToken> {
      throw new Error("Firebase token verification is not configured");
    },
  };
  const emailSender = deps.emailSender ?? {
    async sendOtp(): Promise<void> {
      throw new Error("OTP email delivery is not configured");
    },
  };
  const generateOtp = deps.otpGenerator ?? defaultOtpGenerator;
  const hasher = deps.hasher ?? sha256Hasher;
  const passwordHasher = deps.passwordHasher ?? bcryptPasswordHasher;
  const now: Clock = deps.now ?? (() => new Date());
  const tables: AuthTableNames = { ...DEFAULT_TABLES, ...deps.tables };

  // ── admin-record helpers ──

  async function getAdmin(firebaseUid: string): Promise<AdminRecord | null> {
    const item = await dynamo.get({
      TableName: tables.admins,
      Key: { firebaseUid },
    });
    return (item as AdminRecord | null) ?? null;
  }

  async function putAdmin(record: AdminRecord): Promise<void> {
    await dynamo.put({ TableName: tables.admins, Item: record as unknown as DynamoItem });
  }

  function resolveRole(record: AdminRecord): Role | null {
    if (record.role === "super_admin" || record.role === "admin" || record.role === "reseller" || record.role === "distributor" || record.role === "dealer") {
      return record.role;
    }
    return null;
  }

  function isLocked(record: AdminRecord, at: Date): boolean {
    if (!record.lockUntil) return false;
    const until = Date.parse(record.lockUntil);
    return Number.isFinite(until) && at.getTime() < until;
  }

  function toPrincipal(record: AdminRecord, role: Role): Principal {
    return {
      identity: record.firebaseUid ?? record.adminId,
      role,
      resellerAccountId: record.resellerAccountId ?? null,
      mfaEnrolled: record.mfaEnrolled === true,
      authMethod: "firebase",
    };
  }

  // ── interactive per-request gate ──

  async function authenticate(input: {
    idToken: string;
  }): Promise<AuthOutcome<Principal>> {
    let verified: VerifiedToken;
    try {
      // checkRevoked=true so a logout (refresh-token revocation) is honored.
      verified = await tokenVerifier.verifyIdToken(input.idToken, true);
    } catch {
      return authFailed();
    }

    const record = await getAdmin(verified.uid);
    if (!record) return authFailed();

    const role = resolveRole(record);
    if (!role) return authFailed();

    // Logout invalidation / never-opened session: no activity record.
    if (!record.lastSeenAt) {
      return fail({
        code: "session_expired",
        message: "Session is not active; re-authentication required",
      });
    }

    // 30-minute idle expiry (Req 1.7).
    const at = now();
    const lastSeen = Date.parse(record.lastSeenAt);
    if (!Number.isFinite(lastSeen) || at.getTime() - lastSeen > SESSION_IDLE_LIMIT_MS) {
      return fail({
        code: "session_expired",
        message: "Session expired due to inactivity",
      });
    }

    // Refresh activity so the sliding idle window advances.
    const iso = at.toISOString();
    await putAdmin({
      ...record,
      lastSeenAt: iso,
      sessionTtl: Math.floor((at.getTime() + SESSION_IDLE_LIMIT_MS) / 1000),
    });

    return ok(toPrincipal(record, role));
  }

  // ── OTP issue ──

  async function requestOtp(input: {
    firebaseUid: string;
  }): Promise<AuthOutcome<void>> {
    const record = await getAdmin(input.firebaseUid);
    if (!record) return authFailed();

    const at = now();
    if (isLocked(record, at)) {
      return fail({ code: "account_locked", message: "Account is temporarily locked" });
    }

    const otp = generateOtp();
    // Persist ONLY the hash — the plaintext is never stored or logged.
    await putAdmin({
      ...record,
      otpHash: hasher.hash(otp),
      otpExpiresAt: new Date(at.getTime() + OTP_TTL_MS).toISOString(),
      otpAttempts: (record.otpAttempts ?? 0) + 1,
    });

    // The plaintext OTP escapes only to the email transport, never to any log.
    await emailSender.sendOtp(record.email, otp);
    return ok(undefined);
  }

  // ── OTP verify ──

  async function verifyOtp(input: {
    firebaseUid: string;
    otp: string;
  }): Promise<AuthOutcome<Principal>> {
    const record = await getAdmin(input.firebaseUid);
    if (!record) return authFailed();

    const role = resolveRole(record);
    if (!role) return authFailed();

    const at = now();

    // Reject every attempt while the lock window is in force (Req 1.6).
    if (isLocked(record, at)) {
      return fail({ code: "account_locked", message: "Account is temporarily locked" });
    }

    // Malformed OTP is an ordinary credential failure (counts toward lockout).
    const format = validateEmailOtp(input.otp);
    if (!format.ok) {
      return registerFailure(record, at);
    }

    const expired =
      !record.otpExpiresAt || Date.parse(record.otpExpiresAt) <= at.getTime();
    const matches =
      !!record.otpHash && record.otpHash === hasher.hash(format.value);

    if (!record.otpHash || expired || !matches) {
      return registerFailure(record, at);
    }

    // Success: clear the challenge, reset the lockout counter, enroll the
    // factor, and open the session-activity record.
    const iso = at.toISOString();
    const updated: AdminRecord = {
      ...record,
      mfaEnrolled: true,
      otpHash: undefined,
      otpExpiresAt: undefined,
      otpAttempts: 0,
      failedOtp: 0,
      failedOtpWindowStart: undefined,
      lockUntil: undefined,
      lastSeenAt: iso,
      sessionTtl: Math.floor((at.getTime() + SESSION_IDLE_LIMIT_MS) / 1000),
    };
    await putAdmin(updated);
    return ok(toPrincipal(updated, role));
  }

  /**
   * Record a failed OTP attempt, advancing the rolling window counter and
   * locking the account once it reaches {@link MAX_OTP_FAILURES} within
   * {@link OTP_FAILURE_WINDOW_MS}. Always returns the uniform failure.
   */
  async function registerFailure(
    record: AdminRecord,
    at: Date
  ): Promise<AuthOutcome<Principal>> {
    const windowStart = record.failedOtpWindowStart
      ? Date.parse(record.failedOtpWindowStart)
      : NaN;
    const withinWindow =
      Number.isFinite(windowStart) &&
      at.getTime() - windowStart <= OTP_FAILURE_WINDOW_MS;

    const failedOtp = withinWindow ? (record.failedOtp ?? 0) + 1 : 1;
    const newWindowStart = withinWindow
      ? record.failedOtpWindowStart!
      : at.toISOString();

    const updated: AdminRecord = {
      ...record,
      failedOtp,
      failedOtpWindowStart: newWindowStart,
    };

    if (failedOtp >= MAX_OTP_FAILURES) {
      updated.lockUntil = new Date(at.getTime() + OTP_LOCK_DURATION_MS).toISOString();
    }

    await putAdmin(updated);
    return authFailed();
  }

  // ── OTP-free session open (dev / OTP disabled) ──

  async function openSession(input: {
    firebaseUid: string;
  }): Promise<AuthOutcome<Principal>> {
    const record = await getAdmin(input.firebaseUid);
    if (!record) return authFailed();

    const role = resolveRole(record);
    if (!role) return authFailed();

    const at = now();
    const updated: AdminRecord = {
      ...record,
      mfaEnrolled: true,
      lastSeenAt: at.toISOString(),
      sessionTtl: Math.floor((at.getTime() + SESSION_IDLE_LIMIT_MS) / 1000),
    };
    await putAdmin(updated);
    return ok(toPrincipal(updated, role));
  }

  // ── logout ──

  async function logout(input: {
    firebaseUid: string;
  }): Promise<AuthOutcome<void>> {
    if (tokenVerifier.revokeRefreshTokens) {
      try {
        await tokenVerifier.revokeRefreshTokens(input.firebaseUid);
      } catch {
        // Best-effort refresh-token revocation; clearing activity below still
        // invalidates the portal-side session.
      }
    }

    const record = await getAdmin(input.firebaseUid);
    if (record) {
      await putAdmin({
        ...record,
        lastSeenAt: undefined,
        sessionTtl: undefined,
      });
    }
    return ok(undefined);
  }

  // ── Api_Key auth ──

  async function authenticateApiKey(input: {
    apiKey: string;
  }): Promise<AuthOutcome<Principal>> {
    // Missing/malformed keys fail uniformly (Req 12.2).
    const format = validateApiKey(input.apiKey);
    if (!format.ok) return authFailed();

    const secretHash = hasher.hash(format.value);
    const result = await dynamo.query({
      TableName: tables.apiKeys,
      IndexName: tables.apiKeySecretHashIndex,
      KeyConditionExpression: "#h = :h",
      ExpressionAttributeNames: { "#h": "secretHash" },
      ExpressionAttributeValues: { ":h": secretHash },
    });

    const keyRecord = result.items[0] as unknown as ApiKeyRecord | undefined;
    if (!keyRecord) return authFailed();

    // Revoked keys are rejected (Req 11.3, 12.2).
    if (keyRecord.state !== "active") return authFailed();

    // Owning account must exist and not be suspended (Req 10.2, 12.1).
    const reseller = (await dynamo.get({
      TableName: tables.resellers,
      Key: { resellerAccountId: keyRecord.resellerAccountId },
    })) as ResellerAccountRecord | null;
    if (!reseller || reseller.state !== "active") return authFailed();

    return ok({
      identity: keyRecord.apiKeyId,
      role: "reseller",
      resellerAccountId: keyRecord.resellerAccountId,
      // Api_Key callers are not subject to the interactive email-OTP factor.
      mfaEnrolled: true,
      authMethod: "apikey",
    });
  }

  // ── Password auth (all users: admins, distributors, resellers, dealers) ──

  async function authenticatePassword(input: {
    email: string;
    password: string;
  }): Promise<AuthOutcome<Principal>> {
    // Validate input format
    if (!input.email || typeof input.email !== "string" || input.email.trim().length === 0) {
      return authFailed();
    }
    if (!input.password || typeof input.password !== "string") {
      return authFailed();
    }

    const normalizedEmail = input.email.trim().toLowerCase();

    // Try admin table first (super_admin, admin, readonly_admin)
    const adminResult = await dynamo.query({
      TableName: tables.admins,
      IndexName: "email-index",
      KeyConditionExpression: "email = :email",
      ExpressionAttributeValues: { ":email": normalizedEmail },
    });

    const admin = adminResult.items[0] as unknown as AdminRecord | undefined;
    
    if (admin && admin.passwordHash) {
      // Verify password
      const passwordMatches = await passwordHasher.verify(input.password, admin.passwordHash);
      if (!passwordMatches) return authFailed();

      // Update lastSeenAt using firebaseUid as the key (table still uses it as PK)
      const loginTime = now().toISOString();
      const keyToUse = admin.firebaseUid ? { firebaseUid: admin.firebaseUid } : { adminId: admin.adminId };
      await dynamo.update({
        TableName: tables.admins,
        Key: keyToUse,
        UpdateExpression: "SET lastSeenAt = :time",
        ExpressionAttributeValues: { ":time": loginTime },
      });

      return ok({
        identity: admin.adminId,
        role: admin.role,
        resellerAccountId: admin.resellerAccountId || null,
        mfaEnrolled: true, // Password auth doesn't require additional MFA
        authMethod: "password",
        sessionVersion: admin.sessionVersion ?? 0,
      });
    }

    // Try reseller/distributor/dealer table
    const resellerResult = await dynamo.query({
      TableName: tables.resellers,
      IndexName: "contactEmail-index",
      KeyConditionExpression: "contactEmail = :email",
      ExpressionAttributeValues: { ":email": normalizedEmail },
    });

    const account = resellerResult.items[0] as unknown as ResellerAccountRecord | undefined;
    if (!account) return authFailed();

    // Check account state
    if (account.state !== "active") {
      return fail({
        code: "not_authorized",
        message: "Account is suspended",
      });
    }

    // Verify password
    const passwordMatches = await passwordHasher.verify(input.password, account.passwordHash);
    if (!passwordMatches) return authFailed();

    // Map accountType to role
    const role: Role = account.accountType;

    // Update lastLoginAt
    const loginTime = now().toISOString();
    await dynamo.update({
      TableName: tables.resellers,
      Key: { resellerAccountId: account.resellerAccountId },
      UpdateExpression: "SET lastLoginAt = :loginTime",
      ExpressionAttributeValues: { ":loginTime": loginTime },
    });

    return ok({
      identity: account.resellerAccountId,
      role,
      resellerAccountId: account.resellerAccountId,
      mfaEnrolled: true, // Password auth doesn't require additional MFA
      authMethod: "password",
      sessionVersion: account.sessionVersion ?? 0,
    });
  }

  async function authenticateJwtSession(input: {
    accountId: string;
    email: string;
    role: Role;
    resellerAccountId: string | null;
    sessionVersion: number;
  }): Promise<AuthOutcome<Principal>> {
    if (
      typeof input.sessionVersion !== "number" ||
      !Number.isInteger(input.sessionVersion) ||
      input.sessionVersion < 0
    ) {
      return authFailed();
    }

    if (
      input.role === "distributor" ||
      input.role === "reseller" ||
      input.role === "dealer"
    ) {
      const account = (await dynamo.get({
        TableName: tables.resellers,
        Key: { resellerAccountId: input.accountId },
      })) as ResellerAccountRecord | null;

      if (
        !account ||
        account.state !== "active" ||
        account.accountType !== input.role ||
        account.resellerAccountId !== input.resellerAccountId ||
        (account.sessionVersion ?? 0) !== input.sessionVersion
      ) {
        return authFailed();
      }

      return ok({
        identity: account.resellerAccountId,
        role: account.accountType,
        resellerAccountId: account.resellerAccountId,
        mfaEnrolled: true,
        authMethod: "password",
        sessionVersion: account.sessionVersion ?? 0,
      });
    }

    const result = await dynamo.query({
      TableName: tables.admins,
      IndexName: "email-index",
      KeyConditionExpression: "email = :email",
      ExpressionAttributeValues: { ":email": input.email.toLowerCase() },
    });
    const admin = result.items[0] as unknown as AdminRecord | undefined;
    if (
      !admin ||
      admin.adminId !== input.accountId ||
      admin.role !== input.role ||
      admin.state === "suspended" ||
      (admin.sessionVersion ?? 0) !== input.sessionVersion
    ) {
      return authFailed();
    }

    return ok({
      identity: admin.adminId,
      role: admin.role,
      resellerAccountId: admin.resellerAccountId ?? null,
      mfaEnrolled: true,
      authMethod: "password",
      sessionVersion: admin.sessionVersion ?? 0,
    });
  }

  async function logoutPasswordSession(input: {
    accountId: string;
    email: string;
    role: Role;
  }): Promise<AuthOutcome<void>> {
    if (
      input.role === "distributor" ||
      input.role === "reseller" ||
      input.role === "dealer"
    ) {
      const account = (await dynamo.get({
        TableName: tables.resellers,
        Key: { resellerAccountId: input.accountId },
      })) as ResellerAccountRecord | null;
      if (!account || account.accountType !== input.role) return authFailed();

      await dynamo.atomicIncrement(
        tables.resellers,
        { resellerAccountId: input.accountId },
        "sessionVersion",
        1
      );
      return ok(undefined);
    }

    const result = await dynamo.query({
      TableName: tables.admins,
      IndexName: "email-index",
      KeyConditionExpression: "email = :email",
      ExpressionAttributeValues: { ":email": input.email.toLowerCase() },
    });
    const admin = result.items[0] as unknown as AdminRecord | undefined;
    if (!admin || admin.adminId !== input.accountId || admin.role !== input.role) {
      return authFailed();
    }

    const key =
      admin.firebaseUid !== undefined
        ? { firebaseUid: admin.firebaseUid }
        : { adminId: admin.adminId };
    await dynamo.atomicIncrement(tables.admins, key, "sessionVersion", 1);
    return ok(undefined);
  }

  // ── pure authorization checks ──

  function requirePermission(
    principal: Principal,
    permission: Permission
  ): AuthOutcome<void> {
    if (!hasPermission(principal.role, permission)) {
      return fail({ code: "not_authorized", message: "Not authorized" });
    }
    return ok(undefined);
  }

  function requireMfaEnrolled(principal: Principal): AuthOutcome<void> {
    if (!principal.mfaEnrolled) {
      return fail({ code: "mfa_required", message: "MFA enrollment required" });
    }
    return ok(undefined);
  }

  function assertOwnership(
    principal: Principal,
    record: OwnableRecord
  ): AuthOutcome<void> {
    // Admin / super_admin roles are not ownership-scoped.
    if (principal.role === "admin" || principal.role === "super_admin") {
      return ok(undefined);
    }
    // Non-admin with no account, or a record it does not own, is not-found.
    if (
      principal.resellerAccountId != null &&
      record.resellerAccountId === principal.resellerAccountId
    ) {
      return ok(undefined);
    }
    return fail({ code: "not_found", message: "Not found" });
  }

  return {
    authenticate,
    requestOtp,
    verifyOtp,
    openSession,
    logout,
    authenticateApiKey,
    authenticatePassword,
    authenticateJwtSession,
    logoutPasswordSession,
    requirePermission,
    requireMfaEnrolled,
    assertOwnership,
  };
}

// ─── In-memory Firebase verifier fake (tests) ────────────────────────────────

/**
 * In-memory {@link TokenVerifier} for tests. Register `idToken → VerifiedToken`
 * pairs; `verifyIdToken` rejects unknown tokens and (when `checkRevoked`)
 * rejects tokens whose UID has been revoked via {@link revokeRefreshTokens}.
 */
export class FakeTokenVerifier implements TokenVerifier {
  private readonly tokens = new Map<string, VerifiedToken>();
  private readonly revoked = new Set<string>();

  /** Register a token that will verify to the given uid/claims. */
  setToken(idToken: string, verified: VerifiedToken): void {
    this.tokens.set(idToken, verified);
  }

  async verifyIdToken(idToken: string, checkRevoked = false): Promise<VerifiedToken> {
    const verified = this.tokens.get(idToken);
    if (!verified) {
      throw new Error("invalid token");
    }
    if (checkRevoked && this.revoked.has(verified.uid)) {
      throw new Error("token revoked");
    }
    return verified;
  }

  async revokeRefreshTokens(uid: string): Promise<void> {
    this.revoked.add(uid);
  }
}
