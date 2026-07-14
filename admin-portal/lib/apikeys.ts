/**
 * Admin_User creation and Api_Key lifecycle management for the Admin & Reseller
 * Portal.
 *
 * This module owns the `super_admin`-only management operations:
 *
 *  - **Create Admin_User** — writes a new row to `pdm-portal-admins` mapping a
 *    Firebase UID to a portal role (`super_admin` / `admin`), starting with the
 *    OTP factor un-enrolled (Req 2.6). The write is collision-free via a
 *    conditional `PutItem` on the `firebaseUid` partition key.
 *  - **Issue Api_Key** — generates a fresh secret, returns the **plaintext
 *    exactly once** at creation, and persists **only its SHA-256 hash** together
 *    with an embedded Usage_Plan (`rateLimitPerSec` / `burst` / `monthlyQuota`).
 *    When no plan (or an incomplete plan) is supplied, the portal
 *    {@link DEFAULT_USAGE_PLAN} fallback is applied (Req 11.1, 11.2, 11.5).
 *  - **Revoke Api_Key** — flips `state` to `revoked` so subsequent Reseller_API
 *    requests authenticated by that key are rejected (Req 11.3).
 *  - **Change Usage_Plan** — reassigns the embedded rate/burst/quota on an
 *    existing key (Req 11.4).
 *
 * Every mutating operation writes an append-only Audit_Entry recording the
 * actor, the Api_Key identifier, and the Reseller_Account — and **never** the
 * plaintext secret or its hash (Req 11.6). The plaintext secret is never passed
 * into an Audit_Entry; the audit layer additionally scrubs any secret-bearing
 * field as defense-in-depth.
 *
 * Every external collaborator — the {@link DynamoClient}, the {@link AuditLog},
 * the clock, the secret generator, the id generator, and the one-way
 * {@link Hasher} — is injected, so the property/unit tests (11.5, 11.6) can
 * drive this module entirely against the in-memory DynamoDB fake.
 *
 * @module lib/apikeys
 * Requirements: 2.6, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
 */

import { randomBytes, randomUUID } from "node:crypto";
import { ConditionalCheckFailedError, type DynamoClient, type DynamoItem } from "./dynamo.ts";
import type { AuditLog } from "./audit.ts";
import { sha256Hasher, type Hasher, type AdminRecord, type ApiKeyRecord } from "./auth.ts";
import type { Role } from "./rbac.ts";
import { resolveUsagePlan, type UsagePlan } from "./ratelimit.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** DynamoDB table mapping Firebase UID → portal role and MFA/session state. */
export const ADMINS_TABLE_NAME = "pdm-portal-admins";

/** Partition key of the admins table. */
export const ADMIN_PARTITION_KEY = "firebaseUid";

/** DynamoDB table holding issued Api_Keys (hash + embedded Usage_Plan). */
export const APIKEYS_TABLE_NAME = "pdm-portal-apikeys";

/** Partition key of the api-keys table (public, safe-to-log identifier). */
export const APIKEY_PARTITION_KEY = "apiKeyId";

/** The `pdm_ak_` prefix borne by every issued Api_Key plaintext secret. */
export const API_KEY_PREFIX = "pdm_ak_";

/** Audit action recorded when an Admin_User is created (Req 2.6). */
export const ADMIN_CREATE_ACTION = "admin.create";

/** Audit action recorded when an Api_Key is issued (Req 11.6). */
export const APIKEY_CREATE_ACTION = "apikey.create";

/** Audit action recorded when an Api_Key is revoked (Req 11.6). */
export const APIKEY_REVOKE_ACTION = "apikey.revoke";

/** Audit action recorded when an Api_Key's Usage_Plan changes (Req 11.6). */
export const APIKEY_PLAN_ACTION = "apikey.plan.update";

/** Number of random bytes behind an Api_Key secret (24 bytes → 48 hex chars). */
const SECRET_BYTES = 24;

/** Roles a created Admin_User may hold. Resellers are not Admin_Users (Req 2.6). */
const ADMIN_ROLES: readonly Role[] = ["super_admin", "admin"];

// ─── Injected collaborators ──────────────────────────────────────────────────

/** Generates a fresh plaintext Api_Key secret. Injected for deterministic tests. */
export type SecretGenerator = () => string;

/**
 * Default Api_Key secret generator: the `pdm_ak_` prefix followed by 48 lowercase
 * hexadecimal characters (192 bits of entropy), matching `validateApiKey`.
 */
export function defaultApiKeySecretGenerator(): string {
  return `${API_KEY_PREFIX}${randomBytes(SECRET_BYTES).toString("hex")}`;
}

/** Table-name overrides for the manager. */
export interface ApiKeyTableNames {
  admins: string;
  apiKeys: string;
}

/** Injected collaborators for {@link createApiKeyManager}. */
export interface ApiKeyManagerDeps {
  /** DynamoDB client (real or the in-memory fake). */
  dynamo: DynamoClient;
  /** Append-only audit log used to record each mutation (Req 11.6). */
  audit: AuditLog;
  /** Clock injection for deterministic timestamps (defaults to `Date`). */
  now?: () => Date;
  /** One-way hasher for the key secret (defaults to SHA-256 hex). */
  hasher?: Hasher;
  /** Plaintext secret generator (defaults to {@link defaultApiKeySecretGenerator}). */
  generateSecret?: SecretGenerator;
  /** Api_Key identifier generator (defaults to a random UUID). */
  generateApiKeyId?: () => string;
  /** Admin identifier generator (defaults to a random UUID). */
  generateAdminId?: () => string;
  /** Table-name overrides. */
  tables?: Partial<ApiKeyTableNames>;
}

// ─── Inputs / outputs ────────────────────────────────────────────────────────

/** The actor context recorded on every management Audit_Entry (Req 11.6). */
export interface ActorContext {
  /** Actor identity (Firebase UID of the super admin). */
  actor: string;
  /** Actor role at the time of the action. */
  actorRole: string;
  /** Source IP of the request. */
  sourceIp: string;
}

/** Attributes for a new Admin_User (Req 2.6). */
export interface CreateAdminInput {
  /** Firebase Authentication UID (identity anchor / partition key). */
  firebaseUid: string;
  /** Contact / login email (as known to Firebase). */
  email: string;
  /** Portal role — `super_admin` or `admin` (never `reseller`). */
  role: Role;
}

/** Attributes for issuing a new Api_Key (Req 11.1). */
export interface IssueApiKeyInput {
  /** Owning Reseller_Account. */
  resellerAccountId: string;
  /**
   * Optional Usage_Plan. Missing / incomplete fields fall back to the portal
   * {@link DEFAULT_USAGE_PLAN} (Req 11.5).
   */
  plan?: Partial<UsagePlan> | null;
}

/** The plaintext secret + persisted record returned once at issuance (Req 11.1). */
export interface IssuedApiKey {
  /** The persisted Api_Key record (hash + embedded Usage_Plan; no plaintext). */
  record: ApiKeyRecord;
  /**
   * The plaintext secret, exposed **exactly once** at creation. It is never
   * stored and never written to an Audit_Entry (Req 11.1, 11.2, 11.6).
   */
  secret: string;
}

/** Arguments for revoking an Api_Key (Req 11.3). */
export interface RevokeApiKeyInput {
  apiKeyId: string;
}

/** Arguments for changing an Api_Key's Usage_Plan (Req 11.4). */
export interface ChangeUsagePlanInput {
  apiKeyId: string;
  /** New Usage_Plan; missing fields fall back to the portal default (Req 11.5). */
  plan: Partial<UsagePlan> | null;
}

/** Failure reasons produced by the manager. */
export interface ApiKeyError {
  code: "validation_error" | "not_found" | "conflict";
  /** Offending field for validation errors, when applicable. */
  field?: string;
  message: string;
}

/** Discriminated-union outcome of an Admin_User creation. */
export type CreateAdminResult =
  | { ok: true; value: AdminRecord }
  | { ok: false; error: ApiKeyError };

/** Discriminated-union outcome of an Api_Key issuance. */
export type IssueApiKeyResult =
  | { ok: true; value: IssuedApiKey }
  | { ok: false; error: ApiKeyError };

/** Discriminated-union outcome of an Api_Key revocation. */
export type RevokeApiKeyResult =
  | { ok: true; value: ApiKeyRecord }
  | { ok: false; error: ApiKeyError };

/** Discriminated-union outcome of a Usage_Plan change. */
export type ChangeUsagePlanResult =
  | { ok: true; value: ApiKeyRecord }
  | { ok: false; error: ApiKeyError };

/** The management API surface returned by {@link createApiKeyManager}. */
export interface ApiKeyManager {
  /** Create a new Admin_User in `pdm-portal-admins` (Req 2.6). */
  createAdmin(input: CreateAdminInput, actor: ActorContext): Promise<CreateAdminResult>;

  /**
   * Issue a new Api_Key: generate a secret, persist only its SHA-256 hash with
   * the embedded Usage_Plan, and return the plaintext exactly once (Req 11.1,
   * 11.2, 11.5).
   */
  issueApiKey(input: IssueApiKeyInput, actor: ActorContext): Promise<IssueApiKeyResult>;

  /** Revoke an Api_Key by setting `state` to `revoked` (Req 11.3). */
  revokeApiKey(input: RevokeApiKeyInput, actor: ActorContext): Promise<RevokeApiKeyResult>;

  /** Change an Api_Key's embedded Usage_Plan (Req 11.4). */
  changeUsagePlan(
    input: ChangeUsagePlanInput,
    actor: ActorContext
  ): Promise<ChangeUsagePlanResult>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fail<T extends { ok: false; error: ApiKeyError }>(error: ApiKeyError): T {
  return { ok: false, error } as T;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Minimal email shape check (a single `@` with non-empty local/domain parts). */
function looksLikeEmail(value: string): boolean {
  const at = value.indexOf("@");
  return at > 0 && at < value.length - 1 && value.indexOf("@", at + 1) === -1;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build an {@link ApiKeyManager} from injected collaborators.
 */
export function createApiKeyManager(deps: ApiKeyManagerDeps): ApiKeyManager {
  const dynamo = deps.dynamo;
  const audit = deps.audit;
  const now = deps.now ?? (() => new Date());
  const hasher = deps.hasher ?? sha256Hasher;
  const generateSecret = deps.generateSecret ?? defaultApiKeySecretGenerator;
  const generateApiKeyId = deps.generateApiKeyId ?? (() => randomUUID());
  const generateAdminId = deps.generateAdminId ?? (() => randomUUID());
  const adminsTable = deps.tables?.admins ?? ADMINS_TABLE_NAME;
  const apiKeysTable = deps.tables?.apiKeys ?? APIKEYS_TABLE_NAME;

  return {
    async createAdmin(input, actor) {
      // ── Validate the constrained inputs (defense-in-depth). ──
      if (!isNonEmptyString(input.firebaseUid)) {
        return fail({ code: "validation_error", field: "firebaseUid", message: "firebaseUid is required" });
      }
      if (!isNonEmptyString(input.email) || !looksLikeEmail(input.email.trim())) {
        return fail({ code: "validation_error", field: "email", message: "A valid email is required" });
      }
      if (!ADMIN_ROLES.includes(input.role)) {
        return fail({
          code: "validation_error",
          field: "role",
          message: `role must be one of: ${ADMIN_ROLES.join(", ")}`,
        });
      }

      const createdAt = now().toISOString();
      const record: AdminRecord = {
        firebaseUid: input.firebaseUid.trim(),
        adminId: generateAdminId(),
        email: input.email.trim(),
        role: input.role,
        // A newly-created Admin_User must enroll the OTP factor before any
        // Mutation is permitted (Req 1.5).
        mfaEnrolled: false,
        createdAt,
      };

      // ── Collision-free create: never overwrite an existing UID. ──
      try {
        await dynamo.conditionalPut(
          adminsTable,
          record as unknown as DynamoItem,
          ADMIN_PARTITION_KEY
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedError) {
          return fail({ code: "conflict", message: "An Admin_User with this firebaseUid already exists" });
        }
        throw err;
      }

      // ── Record the create Audit_Entry (no secret involved). ──
      await audit.writeAuditEntry({
        actor: actor.actor,
        actorRole: actor.actorRole,
        action: ADMIN_CREATE_ACTION,
        target: record.adminId ?? record.firebaseUid,
        sourceIp: actor.sourceIp,
        timestamp: createdAt,
        changes: {
          firebaseUid: { before: null, after: record.firebaseUid },
          email: { before: null, after: record.email },
          role: { before: null, after: record.role },
        },
      });

      return { ok: true, value: record };
    },

    async issueApiKey(input, actor) {
      if (!isNonEmptyString(input.resellerAccountId)) {
        return fail({
          code: "validation_error",
          field: "resellerAccountId",
          message: "resellerAccountId is required",
        });
      }

      // ── Resolve the Usage_Plan, filling in portal defaults (Req 11.5). ──
      const plan: UsagePlan = resolveUsagePlan(input.plan);

      // ── Generate the secret; store ONLY its hash (Req 11.2). ──
      const secret = generateSecret();
      const secretHash = hasher.hash(secret);
      const createdAt = now().toISOString();

      const record: ApiKeyRecord = {
        apiKeyId: generateApiKeyId(),
        resellerAccountId: input.resellerAccountId.trim(),
        secretHash,
        rateLimitPerSec: plan.rateLimitPerSec,
        burst: plan.burst,
        monthlyQuota: plan.monthlyQuota,
        state: "active",
        createdAt,
      };

      try {
        await dynamo.conditionalPut(
          apiKeysTable,
          record as unknown as DynamoItem,
          APIKEY_PARTITION_KEY
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedError) {
          return fail({ code: "conflict", message: "An Api_Key with this identifier already exists" });
        }
        throw err;
      }

      // ── Audit the issuance WITHOUT the plaintext secret or its hash (Req 11.6). ──
      await audit.writeAuditEntry({
        actor: actor.actor,
        actorRole: actor.actorRole,
        action: APIKEY_CREATE_ACTION,
        target: record.apiKeyId,
        sourceIp: actor.sourceIp,
        timestamp: createdAt,
        changes: {
          resellerAccountId: { before: null, after: record.resellerAccountId },
          rateLimitPerSec: { before: null, after: record.rateLimitPerSec ?? null },
          burst: { before: null, after: record.burst ?? null },
          monthlyQuota: { before: null, after: record.monthlyQuota ?? null },
          state: { before: null, after: record.state },
        },
      });

      // The plaintext secret escapes only here, in the return value (Req 11.1).
      return { ok: true, value: { record, secret } };
    },

    async revokeApiKey(input, actor) {
      if (!isNonEmptyString(input.apiKeyId)) {
        return fail({ code: "validation_error", field: "apiKeyId", message: "apiKeyId is required" });
      }

      const existing = (await dynamo.get({
        TableName: apiKeysTable,
        Key: { [APIKEY_PARTITION_KEY]: input.apiKeyId },
      })) as ApiKeyRecord | null;

      if (!existing) {
        return fail({ code: "not_found", message: "Not found" });
      }

      const previousState = existing.state;

      const updated = (await dynamo.update({
        TableName: apiKeysTable,
        Key: { [APIKEY_PARTITION_KEY]: input.apiKeyId },
        UpdateExpression: "SET #state = :revoked",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":revoked": "revoked" },
      })) as ApiKeyRecord | undefined;

      const record: ApiKeyRecord = { ...existing, ...(updated ?? {}), state: "revoked" };

      await audit.writeAuditEntry({
        actor: actor.actor,
        actorRole: actor.actorRole,
        action: APIKEY_REVOKE_ACTION,
        target: record.apiKeyId,
        sourceIp: actor.sourceIp,
        timestamp: now().toISOString(),
        changes: {
          resellerAccountId: { before: record.resellerAccountId, after: record.resellerAccountId },
          state: { before: previousState, after: record.state },
        },
      });

      return { ok: true, value: record };
    },

    async changeUsagePlan(input, actor) {
      if (!isNonEmptyString(input.apiKeyId)) {
        return fail({ code: "validation_error", field: "apiKeyId", message: "apiKeyId is required" });
      }

      const existing = (await dynamo.get({
        TableName: apiKeysTable,
        Key: { [APIKEY_PARTITION_KEY]: input.apiKeyId },
      })) as ApiKeyRecord | null;

      if (!existing) {
        return fail({ code: "not_found", message: "Not found" });
      }

      // ── Resolve the new plan, filling in portal defaults (Req 11.5). ──
      const plan: UsagePlan = resolveUsagePlan(input.plan);

      const updated = (await dynamo.update({
        TableName: apiKeysTable,
        Key: { [APIKEY_PARTITION_KEY]: input.apiKeyId },
        UpdateExpression: "SET rateLimitPerSec = :r, burst = :b, monthlyQuota = :q",
        ExpressionAttributeValues: {
          ":r": plan.rateLimitPerSec,
          ":b": plan.burst,
          ":q": plan.monthlyQuota,
        },
      })) as ApiKeyRecord | undefined;

      const record: ApiKeyRecord = {
        ...existing,
        ...(updated ?? {}),
        rateLimitPerSec: plan.rateLimitPerSec,
        burst: plan.burst,
        monthlyQuota: plan.monthlyQuota,
      };

      await audit.writeAuditEntry({
        actor: actor.actor,
        actorRole: actor.actorRole,
        action: APIKEY_PLAN_ACTION,
        target: record.apiKeyId,
        sourceIp: actor.sourceIp,
        timestamp: now().toISOString(),
        changes: {
          resellerAccountId: { before: record.resellerAccountId, after: record.resellerAccountId },
          rateLimitPerSec: { before: existing.rateLimitPerSec ?? null, after: plan.rateLimitPerSec },
          burst: { before: existing.burst ?? null, after: plan.burst },
          monthlyQuota: { before: existing.monthlyQuota ?? null, after: plan.monthlyQuota },
        },
      });

      return { ok: true, value: record };
    },
  };
}
