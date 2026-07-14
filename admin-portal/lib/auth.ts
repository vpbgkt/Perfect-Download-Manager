/**
 * Authentication, MFA (email-OTP), session, and Api_Key authorization library.
 *
 * The portal delegates *identity* (password login) to Firebase Authentication
 * and verifies Firebase ID tokens statelessly. On top of that it owns:
 *
 *  - Role / `resellerAccountId` resolution from `pdm-portal-admins` (and/or
 *    Firebase custom claims).
 *  - An email-delivered one-time passcode (OTP) second factor. Only a one-way
 *    hash of the OTP is ever persisted; the plaintext is never stored or logged.
 *  - `mfaEnrolled` gating: a principal that has never completed an OTP
 *    verification is blocked from Mutations (Req 1.5).
 *  - `failedOtp` / `lockUntil` lockout: ≥5 failed OTP attempts inside a 15-minute
 *    window lock the account for ≥15 minutes (Req 1.6).
 *  - `lastSeenAt` 30-minute idle-expiry (Req 1.7) and logout invalidation
 *    (Req 1.8).
 *  - Api_Key authentication by SHA-256 hash match plus key-revocation and
 *    reseller-suspension checks (Req 12.1, 12.2).
 *  - A uniform `authentication_failed` result that never discloses which field
 *    was wrong (Req 1.3, 15.7).
 *
 * Everything external is injected — the Firebase token verifier, the
 * {@link DynamoClient}, the {@link EmailSender}, the one-way {@link Hasher}, the
 * clock, and the OTP generator — so property/unit tests can drive the module
 * entirely with in-memory fakes and never touch live Firebase.
 *
 * @module lib/auth
 * Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.1, 2.2, 2.4, 2.7,
 *               12.1, 12.2, 15.7
 */

import { createHash, randomInt } from "node:crypto";
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
export type AuthMethod = "firebase" | "apikey";

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
  tokenVerifier: TokenVerifier;
  emailSender: EmailSender;
  /** One-way hasher (defaults to SHA-256 hex). */
  hasher?: Hasher;
  /** Clock (defaults to `() => new Date()`). */
  now?: Clock;
  /** OTP generator (defaults to a random 6-digit code). */
  otpGenerator?: () => string;
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

/** Row in `pdm-portal-admins`. No password hash is ever stored. */
export interface AdminRecord {
  firebaseUid: string;
  adminId?: string;
  email: string;
  role: Role;
  resellerAccountId?: string | null;
  mfaEnrolled?: boolean;
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
  orgName: string;
  contactEmail: string;
  state: "active" | "suspended";
  createdAt?: string;
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
  const tokenVerifier = deps.tokenVerifier;
  const emailSender = deps.emailSender;
  const hasher = deps.hasher ?? sha256Hasher;
  const now: Clock = deps.now ?? (() => new Date());
  const generateOtp = deps.otpGenerator ?? defaultOtpGenerator;
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
    if (record.role === "super_admin" || record.role === "admin" || record.role === "reseller") {
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
      identity: record.firebaseUid,
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
    // Non-reseller roles are not ownership-scoped.
    if (principal.role !== "reseller") {
      return ok(undefined);
    }
    // A reseller with no account, or a record it does not own, is not-found.
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
    requirePermission,
    requireMfaEnrolled,
    assertOwnership,
  };
}

// ─── Firebase Admin SDK adapter (production) ─────────────────────────────────

/**
 * Real {@link TokenVerifier} backed by the Firebase Admin SDK. `firebase-admin`
 * is imported lazily inside each method so merely importing this module (as the
 * tests do) never loads or requires a live Firebase environment.
 */
/**
 * Idempotently initialize the Firebase Admin app so `getAuth()` works. Uses
 * Application Default Credentials, which read the service-account JSON pointed
 * to by `GOOGLE_APPLICATION_CREDENTIALS`.
 */
async function ensureFirebaseApp(): Promise<void> {
  const { getApps, initializeApp, applicationDefault } = await import("firebase-admin/app");
  if (getApps().length === 0) {
    initializeApp({ credential: applicationDefault() });
  }
}

export function createFirebaseTokenVerifier(): TokenVerifier {
  return {
    async verifyIdToken(idToken: string, checkRevoked = true): Promise<VerifiedToken> {
      await ensureFirebaseApp();
      const { getAuth } = await import("firebase-admin/auth");
      const decoded = await getAuth().verifyIdToken(idToken, checkRevoked);
      return { uid: decoded.uid, claims: decoded as Record<string, unknown> };
    },
    async revokeRefreshTokens(uid: string): Promise<void> {
      await ensureFirebaseApp();
      const { getAuth } = await import("firebase-admin/auth");
      await getAuth().revokeRefreshTokens(uid);
    },
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
