/**
 * Reseller_Account management for the Admin & Reseller Portal.
 *
 * Super-admin-only lifecycle over Reseller_Accounts stored in the
 * `pdm-portal-resellers` DynamoDB table. The operations:
 *
 *  - **create** a Reseller_Account from an organization name and a contact
 *    email, minting a unique identifier and an initial `active` state
 *    (Req 10.1); a request that omits either field is rejected with a
 *    validation error and nothing is written (Req 10.4);
 *  - **suspend** an account, setting its `state` to `suspended` — after which
 *    the auth layer rejects Reseller_API requests from its Api_Keys (Req 10.2);
 *  - **reactivate** a suspended account, setting its `state` back to `active`
 *    so its active Api_Keys are honored again (Req 10.3); and
 *  - write an Audit_Entry recording the actor, the Reseller_Account identifier,
 *    and the action for every create / suspend / reactivate (Req 10.5).
 *
 * Every external collaborator — the {@link DynamoClient}, the {@link AuditLog},
 * the clock, and the id generator — is injected, so the property/unit tests
 * (11.2, 11.3) can drive this module entirely against the in-memory DynamoDB
 * fake.
 *
 * @module lib/accounts
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
 */

import { randomUUID } from "node:crypto";
import type { DynamoClient, DynamoItem } from "./dynamo.ts";
import type { AuditLog } from "./audit.ts";
import type { ResellerAccountRecord } from "./auth.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** DynamoDB table backing Reseller_Accounts (Req 14.5 — separate from licenses). */
export const RESELLERS_TABLE_NAME = "pdm-portal-resellers";

/** Partition key of the resellers table. */
export const RESELLER_PARTITION_KEY = "resellerAccountId";

/** The two states a Reseller_Account can hold. */
export const RESELLER_ACTIVE = "active" as const;
export const RESELLER_SUSPENDED = "suspended" as const;

/** Audit actions recorded for the account lifecycle (Req 10.5). */
export const RESELLER_CREATE_ACTION = "reseller.create";
export const RESELLER_SUSPEND_ACTION = "reseller.suspend";
export const RESELLER_REACTIVATE_ACTION = "reseller.reactivate";

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

/** Caller-supplied, already-authorized create-reseller attributes. */
export interface CreateResellerInput {
  /** Organization name — required, non-empty (Req 10.1, 10.4). */
  orgName: unknown;
  /** Contact email — required, non-empty (Req 10.1, 10.4). */
  contactEmail: unknown;
}

/** Failure reasons an account operation can produce. */
export interface AccountError {
  code: "validation_error" | "not_found";
  /** Offending field for validation errors, when applicable. */
  field?: string;
  message: string;
}

/** Discriminated-union outcome of a create attempt. */
export type CreateResellerResult =
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
  /** Append-only audit log used to record the action (Req 10.5). */
  audit: AuditLog;
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
   * Validate the org name + contact email, mint a unique identifier, persist a
   * new Reseller_Account in the `active` state via a collision-free conditional
   * put, and append a create Audit_Entry (Req 10.1, 10.4, 10.5).
   */
  createReseller(
    input: CreateResellerInput,
    actor: AccountActor
  ): Promise<CreateResellerResult>;

  /**
   * Set a Reseller_Account's `state` to `suspended` and append a suspend
   * Audit_Entry; an unknown account is reported as not-found (Req 10.2, 10.5).
   */
  suspend(
    input: { resellerAccountId: string },
    actor: AccountActor
  ): Promise<SetStateResult>;

  /**
   * Set a suspended Reseller_Account's `state` back to `active` and append a
   * reactivate Audit_Entry; an unknown account is not-found (Req 10.3, 10.5).
   */
  reactivate(
    input: { resellerAccountId: string },
    actor: AccountActor
  ): Promise<SetStateResult>;
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
  const now = deps.now ?? (() => new Date());
  const generateId = deps.generateId ?? (() => `res_${randomUUID()}`);
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
      UpdateExpression: "SET #state = :state",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: { ":state": targetState },
    });

    const record: ResellerAccountRecord = {
      ...(updated as ResellerAccountRecord | undefined ?? existing),
      resellerAccountId,
      state: targetState,
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
    async createReseller(input, actor) {
      // ── Both fields are required; reject and write nothing otherwise
      //    (Req 10.4). Validation happens BEFORE any write. ──
      const orgName = requireNonEmptyString(input.orgName, "orgName");
      if (!orgName.ok) {
        return fail(orgName.error);
      }
      const contactEmail = requireNonEmptyString(input.contactEmail, "contactEmail");
      if (!contactEmail.ok) {
        return fail(contactEmail.error);
      }

      const createdAt = now().toISOString();
      const record: ResellerAccountRecord = {
        resellerAccountId: generateId(),
        orgName: orgName.value,
        contactEmail: contactEmail.value,
        // New accounts start active (Req 10.1).
        state: RESELLER_ACTIVE,
        createdAt,
      };

      // Collision-free write on the unique identifier (Req 10.1).
      await dynamo.conditionalPut(
        tableName,
        record as unknown as DynamoItem,
        RESELLER_PARTITION_KEY
      );

      // Audit_Entry: actor, Reseller_Account identifier, action (Req 10.5).
      await audit.writeAuditEntry({
        actor: actor.actor,
        actorRole: actor.actorRole,
        action: RESELLER_CREATE_ACTION,
        target: record.resellerAccountId,
        sourceIp: actor.sourceIp,
        timestamp: createdAt,
        changes: {
          orgName: { before: null, after: record.orgName },
          contactEmail: { before: null, after: record.contactEmail },
          state: { before: null, after: record.state },
        },
      });

      return { ok: true, value: record };
    },

    suspend(input, actor) {
      return transition(
        input.resellerAccountId,
        RESELLER_SUSPENDED,
        RESELLER_SUSPEND_ACTION,
        actor
      );
    },

    reactivate(input, actor) {
      return transition(
        input.resellerAccountId,
        RESELLER_ACTIVE,
        RESELLER_REACTIVATE_ACTION,
        actor
      );
    },
  };
}
