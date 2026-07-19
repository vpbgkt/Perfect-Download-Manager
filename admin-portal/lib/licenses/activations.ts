/**
 * Activation management for License_Records in the existing `pdm-licenses`
 * table.
 *
 * The portal helps customers move a license to a new machine by removing a
 * single per-machine Activation_Entry from a License_Record's `activations`
 * map. Removal is *precise*: exactly the targeted fingerprint entry is deleted
 * and every other entry is left untouched (Req 7.3). A fingerprint that is not
 * present — or a record the caller may not view — yields a not-found result and
 * leaves the map unchanged (Req 7.2, 7.4). Every successful removal appends an
 * Audit_Entry recording the actor, the License_Key, and the removed fingerprint
 * (Req 7.5).
 *
 * The map delete uses the injected {@link DynamoClient.mapRemove} helper, which
 * issues a `REMOVE #map.#key` guarded by `attribute_exists(#map.#key)` so only
 * the one nested key is removed and the operation is a no-op-safe conditional.
 *
 * Every external collaborator — the {@link DynamoClient}, the {@link AuditLog},
 * the ownership checker, and the clock — is injected, so the module is driven
 * entirely by the in-memory fake document client in tests.
 *
 * @module lib/licenses/activations
 * Requirements: 7.2, 7.3, 7.4, 7.5
 */

import { ConditionalCheckFailedError } from "../dynamo.ts";
import type { DynamoClient, DynamoItem } from "../dynamo.ts";
import type { AuditLog } from "../audit.ts";
import type {
  Authenticator,
  AuthError,
  AuthOutcome,
  Principal,
} from "../auth.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** The existing licenses table the activate/validate/trial Lambdas also read. */
export const LICENSES_TABLE_NAME = "pdm-licenses";

/** Partition key of the licenses table. */
export const LICENSES_PARTITION_KEY = "licenseKey";

/** Prefix of trial-anchor items, which the portal never modifies (Req 14.4). */
const TRIAL_KEY_PREFIX = "TRIAL#";

/** The audit action recorded for an activation removal. */
export const ACTIVATION_REMOVE_ACTION = "license.activation.remove";

// ─── Types ───────────────────────────────────────────────────────────────────

/** The value stored under each fingerprint in the `activations` map. */
export interface ActivationEntry {
  activatedAt?: string;
  lastSeenAt?: string;
}

/** Minimal shape of the License_Record fields this module reads. */
interface LicenseRecordShape {
  licenseKey: string;
  /** Owning reseller (additive attribute), or absent for admin-created records. */
  resellerAccountId?: string | null;
  /** Per-machine activations keyed by 64-char hex fingerprint. */
  activations?: Record<string, ActivationEntry>;
}

/** Dependency-injection options for {@link createActivationManager}. */
export interface ActivationManagerDeps {
  /** DynamoDB client (real or the in-memory fake used in tests). */
  dynamo: DynamoClient;
  /** Append-only audit log for recording the removal (Req 7.5). */
  audit: AuditLog;
  /**
   * Ownership check reused from the auth layer. A reseller may only touch its
   * own records; a non-owned record is reported as not-found (Req 2.7, 7.2).
   */
  authorizer: Pick<Authenticator, "assertOwnership">;
  /** Clock injection for deterministic audit timestamps in tests. */
  now?: () => string;
  /** Override the licenses table name (defaults to {@link LICENSES_TABLE_NAME}). */
  tableName?: string;
}

/** Input for {@link ActivationManager.removeActivation}. */
export interface RemoveActivationInput {
  /** The authenticated, authorized caller. */
  principal: Principal;
  /** License_Key of the target License_Record. */
  licenseKey: string;
  /** The 64-char hex machine fingerprint (Activation_Entry key) to remove. */
  fingerprint: string;
  /** Source IP of the request, recorded on the Audit_Entry (Req 13.1). */
  sourceIp: string;
}

/** The activation-management API surface. */
export interface ActivationManager {
  /**
   * Remove exactly the targeted fingerprint's Activation_Entry from a viewable
   * License_Record and write a removal Audit_Entry.
   *
   * Returns a `not_found` outcome (leaving the map unchanged) when the record
   * does not exist, is a trial anchor, is not viewable by the caller, or the
   * fingerprint is absent (Req 7.2, 7.4). Returns `ok` on a precise delete.
   */
  removeActivation(input: RemoveActivationInput): Promise<AuthOutcome<void>>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NOT_FOUND: AuthError = Object.freeze({
  code: "not_found",
  message: "Not found",
});

function ok(): AuthOutcome<void> {
  return { ok: true, value: undefined };
}

function fail(error: AuthError): AuthOutcome<void> {
  return { ok: false, error };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build an {@link ActivationManager} from injected collaborators.
 */
export function createActivationManager(
  deps: ActivationManagerDeps
): ActivationManager {
  const { dynamo, audit, authorizer } = deps;
  const tableName = deps.tableName ?? LICENSES_TABLE_NAME;
  const now = deps.now ?? (() => new Date().toISOString());

  async function removeActivation(
    input: RemoveActivationInput
  ): Promise<AuthOutcome<void>> {
    const { principal, licenseKey, fingerprint, sourceIp } = input;

    // Trial anchors are never read or modified by the portal (Req 14.4); a
    // request targeting one is simply not-found.
    if (licenseKey.startsWith(TRIAL_KEY_PREFIX)) {
      return fail(NOT_FOUND);
    }

    const item = (await dynamo.get({
      TableName: tableName,
      Key: { [LICENSES_PARTITION_KEY]: licenseKey },
    })) as (DynamoItem & LicenseRecordShape) | null;

    // Unknown key → not-found, nothing changed (Req 7.4-adjacent, 4.6).
    if (!item) {
      return fail(NOT_FOUND);
    }

    // Reseller ownership scoping: a non-owned record is reported as not-found
    // (Req 2.7, 7.2). Reuses the auth layer's assertOwnership.
    const ownership = authorizer.assertOwnership(principal, item);
    if (!ownership.ok) {
      return fail(ownership.error);
    }

    // Absent fingerprint → not-found, map left unchanged (Req 7.4).
    const activations = item.activations;
    const present =
      activations != null &&
      Object.prototype.hasOwnProperty.call(activations, fingerprint);
    if (!present) {
      return fail(NOT_FOUND);
    }
    const removedEntry = activations[fingerprint];

    // Delete exactly the one nested key (Req 7.3). The conditional guard means
    // a concurrent removal of the same key surfaces as a clean not-found.
    try {
      await dynamo.mapRemove(
        tableName,
        { [LICENSES_PARTITION_KEY]: licenseKey },
        "activations",
        fingerprint
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedError) {
        return fail(NOT_FOUND);
      }
      throw err;
    }

    // Append-only Audit_Entry recording the actor, License_Key, and the removed
    // fingerprint (Req 7.5, 13.1).
    await audit.writeAuditEntry({
      actor: principal.identity,
      actorRole: principal.role,
      action: ACTIVATION_REMOVE_ACTION,
      target: licenseKey,
      sourceIp,
      timestamp: now(),
      changes: {
        [`activations.${fingerprint}`]: {
          before: removedEntry ?? {},
          after: null,
        },
      },
    });

    return ok();
  }

  return { removeActivation };
}
