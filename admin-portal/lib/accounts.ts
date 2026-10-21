/**
 * Multi-tier Account management for the Admin & Reseller Portal.
 *
 * Manages the lifecycle of distributor/reseller/dealer accounts stored in the
 * `pdm-portal-resellers` DynamoDB table. The operations:
 *
 *  - **create** an account (distributor/reseller/dealer) with organization name,
 *    contact email, password, account type, initial balance, and discount
 *    percentage. Mints a unique identifier and sets initial `active` state.
 *  - **suspend** an account, setting its `state` to `suspended` — after which
 *    the auth layer rejects API requests from that account.
 *  - **reactivate** a suspended account, setting its `state` back to `active`.
 *  - write an Audit_Entry recording the actor, the account identifier,
 *    and the action for every create / suspend / reactivate.
 *
 * Every external collaborator — the {@link DynamoClient}, the {@link AuditLog},
 * the {@link PasswordHasher}, the clock, and the id generator — is injected for
 * testability.
 *
 * @module lib/accounts
 */

import { randomUUID } from "node:crypto";
import type { DynamoClient, DynamoItem } from "./dynamo.ts";
import type { AuditLog } from "./audit.ts";
import type { ResellerAccountRecord, PasswordHasher } from "./auth.ts";
import { bcryptPasswordHasher } from "./auth.ts";
import type { Role } from "./rbac.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** DynamoDB table backing Reseller_Accounts (Req 14.5 — separate from licenses). */
export const RESELLERS_TABLE_NAME = "pdm-portal-resellers";

/** Partition key of the resellers table. */
export const RESELLER_PARTITION_KEY = "resellerAccountId";

/** The two states a Reseller_Account can hold. */
export const RESELLER_ACTIVE = "active" as const;
export const RESELLER_SUSPENDED = "suspended" as const;

/** Audit actions recorded for the account lifecycle. */
export const ACCOUNT_CREATE_ACTION = "account.create";
export const ACCOUNT_SUSPEND_ACTION = "account.suspend";
export const ACCOUNT_REACTIVATE_ACTION = "account.reactivate";

// ─── Types ───────────────────────────────────────────────────────────────────

/** The actor context needed to write an account Audit_Entry (Req 10.5). */
export interface AccountActor {
  /** Actor identity (Firebase UID of the super admin). */
  actor: string;
  /** Actor role at the time of the action. */
  actorRole: string;
  /** Source IP of the request. */
  sourceIp: string;
}

/** Caller-supplied, already-authorized create-account attributes. */
export interface CreateAccountInput {
  /** Account type: distributor, reseller, or dealer. */
  accountType: "distributor" | "reseller" | "dealer";
  /** Organization name — required, non-empty. */
  orgName: unknown;
  /** Contact email — required, non-empty. */
  contactEmail: unknown;
  /** Password — required, non-empty (will be hashed with bcrypt). */
  password: unknown;
  /** Initial balance — optional, defaults to 0. */
  initialBalance?: number;
  /** Discount percentage (0-100) — optional, defaults to 0. */
  discountPercent?: number;
  /** Parent account ID for hierarchy tracking — optional. */
  parentAccountId?: string;
}

/** Failure reasons an account operation can produce. */
export interface AccountError {
  code: "validation_error" | "not_found";
  /** Offending field for validation errors, when applicable. */
  field?: string;
  message: string;
}

/** Discriminated-union outcome of a create attempt. */
export type CreateAccountResult =
  | { ok: true; value: ResellerAccountRecord }
  | { ok: false; error: AccountError };

/** Discriminated-union outcome of a suspend/reactivate attempt. */
export type SetStateResult =
  | { ok: true; value: ResellerAccountRecord }
  | { ok: false; error: AccountError };

/** Injected collaborators for {@link createAccountManager}. */
export interface AccountManagerDeps {
  /** DynamoDB client (real or the in-memory fake). */
  dynamo: DynamoClient;
  /** Append-only audit log used to record the action. */
  audit: AuditLog;
  /** Password hasher (bcrypt). */
  passwordHasher?: PasswordHasher;
  /** Clock injection for a deterministic `createdAt` / audit timestamp. */
  now?: () => Date;
  /** Unique id generator injection (defaults to a UUID-based id). */
  generateId?: () => string;
  /** Override the resellers table name (defaults to {@link RESELLERS_TABLE_NAME}). */
  tableName?: string;
}

/** The account-management API surface returned by {@link createAccountManager}. */
export interface AccountManager {
  /**
   * Validate inputs, hash the password, mint a unique identifier, persist a
   * new account in the `active` state via a collision-free conditional
   * put, and append a create Audit_Entry.
   */
  createAccount(
    input: CreateAccountInput,
    actor: AccountActor
  ): Promise<CreateAccountResult>;

  /**
   * Set an account's `state` to `suspended` and append a suspend
   * Audit_Entry; an unknown account is reported as not-found.
   */
  suspend(
    input: { resellerAccountId: string },
    actor: AccountActor
  ): Promise<SetStateResult>;

  /**
   * Set a suspended account's `state` back to `active` and append a
   * reactivate Audit_Entry; an unknown account is not-found.
   */
  reactivate(
    input: { resellerAccountId: string },
    actor: AccountActor
  ): Promise<SetStateResult>;

  /**
   * List accounts via a paginated scan. Returns the records plus an optional continuation token.
   */
  listResellers(options?: {
    pageSize?: number;
    continuationToken?: string;
  }): Promise<{ items: ResellerAccountRecord[]; nextToken?: string }>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fail(error: AccountError): { ok: false; error: AccountError } {
  return { ok: false, error };
}

const NOT_FOUND: AccountError = { code: "not_found", message: "Not found" };

/**
 * Validate a required, non-empty string field. Returns the trimmed value or a
 * validation error naming the field (Req 10.4).
 */
function requireNonEmptyString(
  value: unknown,
  field: string
): { ok: true; value: string } | { ok: false; error: AccountError } {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      ok: false,
      error: { code: "validation_error", field, message: `${field} is required` },
    };
  }
  return { ok: true, value: value.trim() };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build an {@link AccountManager} from injected collaborators.
 */
export function createAccountManager(deps: AccountManagerDeps): AccountManager {
  const dynamo = deps.dynamo;
  const audit = deps.audit;
  const passwordHasher = deps.passwordHasher ?? bcryptPasswordHasher;
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? (() => `acc_${randomUUID()}`);
  const tableName = deps.tableName ?? RESELLERS_TABLE_NAME;

  /** Load an existing Reseller_Account record, or null. */
  async function getReseller(
    resellerAccountId: string
  ): Promise<ResellerAccountRecord | null> {
    const item = await dynamo.get({
      TableName: tableName,
      Key: { [RESELLER_PARTITION_KEY]: resellerAccountId },
    });
    return (item as ResellerAccountRecord | null) ?? null;
  }

  /**
   * Shared suspend/reactivate transition. Loads the record, sets the target
   * `state`, and records the given audit action with previous + new state.
   */
  async function transition(
    resellerAccountId: string,
    targetState: "active" | "suspended",
    action: string,
    actor: AccountActor
  ): Promise<SetStateResult> {
    const existing = await getReseller(resellerAccountId);
    if (!existing) {
      return fail(NOT_FOUND);
    }

    const previousState =
      typeof existing.state === "string" ? existing.state : null;

    // Update `state` on the same item the Reseller_API auth path reads. `state`
    // is a DynamoDB reserved word, so alias it.
    const updated = await dynamo.update({
      TableName: tableName,
      Key: { [RESELLER_PARTITION_KEY]: resellerAccountId },
      UpdateExpression: "SET #state = :state ADD sessionVersion :increment",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":state": targetState, ":increment": 1 },
    });

    const record: ResellerAccountRecord = {
      ...(updated as ResellerAccountRecord | undefined ?? existing),
      resellerAccountId,
      state: targetState,
      sessionVersion: (existing.sessionVersion ?? 0) + 1,
    };

    // Audit_Entry: actor, Reseller_Account identifier, action (Req 10.5).
    await audit.writeAuditEntry({
      actor: actor.actor,
      actorRole: actor.actorRole,
      action,
      target: resellerAccountId,
      sourceIp: actor.sourceIp,
      timestamp: now().toISOString(),
      changes: {
        state: { before: previousState, after: targetState },
      },
    });

    return { ok: true, value: record };
  }

  return {
    async createAccount(input, actor) {
      // ── Validate all required fields ──
      const orgName = requireNonEmptyString(input.orgName, "orgName");
      if (!orgName.ok) {
        return fail(orgName.error);
      }
      const contactEmail = requireNonEmptyString(input.contactEmail, "contactEmail");
      if (!contactEmail.ok) {
        return fail(contactEmail.error);
      }
      const password = requireNonEmptyString(input.password, "password");
      if (!password.ok) {
        return fail(password.error);
      }

      // Validate account type
      const validTypes = ["distributor", "reseller", "dealer"];
      if (!validTypes.includes(input.accountType)) {
        return fail({
          code: "validation_error",
          field: "accountType",
          message: "accountType must be distributor, reseller, or dealer",
        });
      }

      // Validate discount percent if provided
      if (input.discountPercent !== undefined) {
        if (
          typeof input.discountPercent !== "number" ||
          input.discountPercent < 0 ||
          input.discountPercent > 100
        ) {
          return fail({
            code: "validation_error",
            field: "discountPercent",
            message: "discountPercent must be between 0 and 100",
          });
        }
      }

      // Validate initial balance if provided
      if (input.initialBalance !== undefined) {
        if (
          typeof input.initialBalance !== "number" ||
          input.initialBalance < 0
        ) {
          return fail({
            code: "validation_error",
            field: "initialBalance",
            message: "initialBalance must be a non-negative number",
          });
        }
      }

      // Hash the password
      const passwordHash = await passwordHasher.hash(password.value);

      const createdAt = now().toISOString();
      const record: ResellerAccountRecord = {
        resellerAccountId: generateId(),
        accountType: input.accountType,
        orgName: orgName.value,
        contactEmail: contactEmail.value.toLowerCase(), // Normalize email to lowercase
        passwordHash,
        state: RESELLER_ACTIVE,
        sessionVersion: 0,
        balance: input.initialBalance ?? 0,
        discountPercent: input.discountPercent ?? 0,
        parentAccountId: input.parentAccountId,
        createdAt,
      };

      // Collision-free write on the unique identifier
      await dynamo.conditionalPut(
        tableName,
        record as unknown as DynamoItem,
        RESELLER_PARTITION_KEY
      );

      // Audit_Entry: actor, account identifier, action
      await audit.writeAuditEntry({
        actor: actor.actor,
        actorRole: actor.actorRole,
        action: ACCOUNT_CREATE_ACTION,
        target: record.resellerAccountId,
        sourceIp: actor.sourceIp,
        timestamp: createdAt,
        changes: {
          accountType: { before: null, after: record.accountType },
          orgName: { before: null, after: record.orgName },
          contactEmail: { before: null, after: record.contactEmail },
          balance: { before: null, after: record.balance },
          discountPercent: { before: null, after: record.discountPercent },
          parentAccountId: { before: null, after: record.parentAccountId ?? null },
          state: { before: null, after: record.state },
        },
      });

      return { ok: true, value: record };
    },

    suspend(input, actor) {
      return transition(
        input.resellerAccountId,
        RESELLER_SUSPENDED,
        ACCOUNT_SUSPEND_ACTION,
        actor
      );
    },

    reactivate(input, actor) {
      return transition(
        input.resellerAccountId,
        RESELLER_ACTIVE,
        ACCOUNT_REACTIVATE_ACTION,
        actor
      );
    },

    async listResellers(options) {
      const page = await dynamo.paginatedScan(
        { TableName: tableName },
        options?.pageSize ?? 100,
        options?.continuationToken
      );
      return {
        items: page.items as unknown as ResellerAccountRecord[],
        nextToken: page.nextToken,
      };
    },
  };
}
