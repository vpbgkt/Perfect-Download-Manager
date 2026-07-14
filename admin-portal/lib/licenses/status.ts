/**
 * License_Status change for the Admin & Reseller Portal.
 *
 * Updates a License_Record's `status` to one of `active`, `revoked`, or
 * `suspended` on the **same** `pdm-licenses` DynamoDB item the activate/validate
 * Lambdas read, so the change is honored on the license's next validation
 * (Req 5.1, 5.4). The operation:
 *
 *  - validates the requested value and rejects anything outside the enum,
 *    leaving the persisted `status` unchanged (Req 5.2);
 *  - scopes reseller callers to their own records via `assertOwnership` /
 *    `resellerAccountId` — a non-owned or unknown key is reported as not-found
 *    (Req 2.7);
 *  - never touches `TRIAL#` anchor items (Req 14.4);
 *  - writes a status Audit_Entry recording the actor, the License_Key, and the
 *    previous and new status (Req 5.3); and
 *  - guarantees that on success the persisted `status` equals the requested
 *    value (Req 5.5).
 *
 * Every external collaborator — the {@link DynamoClient}, the {@link AuditLog},
 * the clock, and the ownership check — is injected, so the property/unit tests
 * can drive this module entirely against the in-memory DynamoDB fake.
 *
 * @module lib/licenses/status
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import type { DynamoClient, DynamoItem } from "../dynamo.ts";
import type { AuditLog } from "../audit.ts";
import type { AuthOutcome, OwnableRecord, Principal } from "../auth.ts";
import { validateStatus, type LicenseStatus } from "../validation.ts";
import {
  LICENSES_TABLE_NAME,
  LICENSE_PARTITION_KEY,
  TRIAL_ANCHOR_PREFIX,
} from "./create.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Audit action recorded for a license status change (Req 5.3). */
export const LICENSE_STATUS_ACTION = "license.status.update";

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A License_Record as returned after a status change. The existing schema
 * attributes are preserved verbatim (Req 14.2); only `status` is guaranteed to
 * equal the requested value (Req 5.5).
 */
export interface UpdatedLicenseRecord extends DynamoItem {
  licenseKey: string;
  status: LicenseStatus;
}

/** Discriminated-union outcome of a status-change attempt. */
export type UpdateStatusResult =
  | { ok: true; value: UpdatedLicenseRecord }
  | { ok: false; error: UpdateStatusError };

/** Failure reasons a status-change attempt can produce. */
export interface UpdateStatusError {
  code: "validation_error" | "not_found";
  /** Offending field for validation errors, when applicable. */
  field?: string;
  message: string;
}

/** Arguments for a single status-change request. */
export interface UpdateStatusInput {
  /** Target License_Key. */
  licenseKey: string;
  /** Requested status — validated internally against the License_Status enum. */
  status: unknown;
  /** The authenticated caller; role + `resellerAccountId` drive ownership. */
  principal: Principal;
  /** Source IP of the request (recorded on the Audit_Entry). */
  sourceIp: string;
}

/** Injected collaborators for {@link createStatusUpdater}. */
export interface UpdateStatusDeps {
  /** DynamoDB client (real or the in-memory fake). */
  dynamo: DynamoClient;
  /** Append-only audit log used to record the change (Req 5.3). */
  audit: AuditLog;
  /** Clock injection for a deterministic audit timestamp (defaults to `Date`). */
  now?: () => Date;
  /** Override the licenses table name (defaults to {@link LICENSES_TABLE_NAME}). */
  tableName?: string;
  /**
   * Ownership scoping reused from the Authenticator (Req 2.7). Defaults to the
   * same `resellerAccountId` scoping as `lib/auth.assertOwnership`: non-reseller
   * roles pass, a reseller passes only for its own record, otherwise not-found.
   */
  assertOwnership?: (principal: Principal, record: OwnableRecord) => AuthOutcome<void>;
}

/** The status-change API surface returned by {@link createStatusUpdater}. */
export interface StatusUpdater {
  /**
   * Validate the requested status, enforce ownership, update the `status`
   * attribute on the same `pdm-licenses` item, append a status Audit_Entry, and
   * return the updated record — or a typed error leaving the record unchanged.
   */
  update(input: UpdateStatusInput): Promise<UpdateStatusResult>;
}

// ─── Default ownership check (mirrors lib/auth.assertOwnership) ───────────────

/**
 * Default `resellerAccountId` ownership scoping, identical in behavior to
 * `lib/auth.Authenticator.assertOwnership`: admin/super_admin roles are not
 * ownership-scoped; a reseller may only reach a record it owns, and any other
 * record is reported as not-found (Req 2.7).
 */
function defaultAssertOwnership(
  principal: Principal,
  record: OwnableRecord
): AuthOutcome<void> {
  if (principal.role !== "reseller") {
    return { ok: true, value: undefined };
  }
  if (
    principal.resellerAccountId != null &&
    record.resellerAccountId === principal.resellerAccountId
  ) {
    return { ok: true, value: undefined };
  }
  return { ok: false, error: { code: "not_found", message: "Not found" } };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

function fail(error: UpdateStatusError): UpdateStatusResult {
  return { ok: false, error };
}

const NOT_FOUND: UpdateStatusError = { code: "not_found", message: "Not found" };

/**
 * Build a {@link StatusUpdater} from injected collaborators.
 */
export function createStatusUpdater(deps: UpdateStatusDeps): StatusUpdater {
  const dynamo = deps.dynamo;
  const audit = deps.audit;
  const now = deps.now ?? (() => new Date());
  const tableName = deps.tableName ?? LICENSES_TABLE_NAME;
  const assertOwnership = deps.assertOwnership ?? defaultAssertOwnership;

  return {
    async update(input) {
      const { licenseKey, principal, sourceIp } = input;

      // ── Validate the requested status BEFORE any read/write so a rejected
      //    request never mutates state (Req 5.2). ──
      const validated = validateStatus(input.status);
      if (!validated.ok) {
        return fail({ code: "validation_error", field: "status", message: validated.error });
      }
      const newStatus = validated.value;

      // Never read or modify trial-anchor items (Req 14.4); report as not-found.
      if (licenseKey.startsWith(TRIAL_ANCHOR_PREFIX)) {
        return fail(NOT_FOUND);
      }

      // ── Load the existing record from the shared licenses item (Req 5.4). ──
      const existing = (await dynamo.get({
        TableName: tableName,
        Key: { [LICENSE_PARTITION_KEY]: licenseKey },
      })) as (DynamoItem & { status?: unknown; resellerAccountId?: string | null }) | null;

      if (!existing) {
        return fail(NOT_FOUND);
      }

      // ── Reseller callers may only affect their own records (Req 2.7). ──
      const ownership = assertOwnership(principal, {
        resellerAccountId:
          typeof existing.resellerAccountId === "string" ? existing.resellerAccountId : null,
      });
      if (!ownership.ok) {
        // A non-owned / unknown record is reported as genuinely missing.
        return fail(NOT_FOUND);
      }

      const previousStatus =
        typeof existing.status === "string" ? existing.status : null;

      // ── Update `status` on the same item the Lambdas read (Req 5.1, 5.4). ──
      const updated = await dynamo.update({
        TableName: tableName,
        Key: { [LICENSE_PARTITION_KEY]: licenseKey },
        UpdateExpression: "SET #status = :status",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": newStatus },
      });

      // Guarantee the persisted status equals the requested value (Req 5.5).
      const record: UpdatedLicenseRecord = {
        ...(updated ?? { ...existing }),
        licenseKey,
        status: newStatus,
      } as UpdatedLicenseRecord;

      // ── Record the status Audit_Entry with previous + new status (Req 5.3). ──
      await audit.writeAuditEntry({
        actor: principal.identity,
        actorRole: principal.role,
        action: LICENSE_STATUS_ACTION,
        target: licenseKey,
        sourceIp,
        timestamp: now().toISOString(),
        changes: {
          status: { before: previousStatus, after: newStatus },
        },
      });

      return { ok: true, value: record };
    },
  };
}
