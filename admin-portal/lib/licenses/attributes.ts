/**
 * License_Record attribute update for the Admin & Reseller Portal.
 *
 * Adjusts a viewable License_Record's mutable attributes — `plan`,
 * `maxActivations`, `expiresAt`, `owner`, and `features` — on the **same**
 * `pdm-licenses` DynamoDB item the activate/validate/trial Lambdas read, so the
 * change is honored on the license's next validation (Req 6.1, 14.1). The
 * operation:
 *
 *  - updates **exactly** the submitted attributes and leaves every unsubmitted
 *    attribute unchanged (Req 6.1);
 *  - rejects a `maxActivations` that is not an integer ≥ 1, leaving the record
 *    unchanged (Req 6.2);
 *  - rejects a `maxActivations` below the current number of Activation_Entries,
 *    with an error that identifies the current activation count, leaving the
 *    record unchanged (Req 6.3);
 *  - rejects an invalid ISO 8601 `expiresAt`, leaving the record unchanged
 *    (Req 6.4);
 *  - treats an **empty** `expiresAt` (`""` or `null`) as a request to clear the
 *    attribute so the record becomes perpetual — a DynamoDB `REMOVE` (Req 6.5);
 *  - scopes reseller callers to their own records via `assertOwnership` /
 *    `resellerAccountId`; a non-owned or unknown key is reported as not-found
 *    (Req 2.7);
 *  - never touches `TRIAL#` anchor items (Req 14.4); and
 *  - writes an Audit_Entry recording the actor, the License_Key, and the changed
 *    attributes with their previous and new values (Req 6.6).
 *
 * All validation happens before any write, so a rejected request never mutates
 * state (Req 6.2, 6.3, 6.4). Every external collaborator — the
 * {@link DynamoClient}, the {@link AuditLog}, the clock, and the ownership
 * check — is injected, so the property/unit tests (8.4/8.5) can drive this
 * module entirely against the in-memory DynamoDB fake.
 *
 * @module lib/licenses/attributes
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import type { DynamoClient, DynamoItem } from "../dynamo.ts";
import type { AuditLog, AuditChanges } from "../audit.ts";
import type { AuthOutcome, OwnableRecord, Principal } from "../auth.ts";
import { validateIso8601Utc, validateMaxActivations } from "../validation.ts";
import {
  LICENSES_TABLE_NAME,
  LICENSE_PARTITION_KEY,
  TRIAL_ANCHOR_PREFIX,
} from "./create.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Audit action recorded for a license attribute update (Req 6.6). */
export const LICENSE_ATTRIBUTES_ACTION = "license.attributes.update";

/** The mutable License_Record attributes this module may update (Req 6.1). */
export const UPDATABLE_ATTRIBUTES = [
  "plan",
  "maxActivations",
  "expiresAt",
  "owner",
  "features",
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The caller-submitted attribute changes. Only the keys that are **present**
 * (with a value other than `undefined`) are treated as submitted and updated;
 * every absent key is left unchanged on the record (Req 6.1).
 *
 * For `expiresAt`, an empty value (`""` or `null`) is a request to *clear* the
 * attribute (perpetual license, Req 6.5); a non-empty value must be a valid
 * ISO 8601 UTC date-time (Req 6.4).
 */
export interface LicenseAttributeUpdates {
  plan?: unknown;
  maxActivations?: unknown;
  expiresAt?: unknown;
  owner?: unknown;
  features?: unknown;
}

/**
 * A License_Record as returned after an attribute update. The existing schema
 * attributes are preserved verbatim (Req 14.2); only the submitted attributes
 * change (Req 6.1).
 */
export interface UpdatedLicenseRecord extends DynamoItem {
  licenseKey: string;
}

/** Discriminated-union outcome of an attribute-update attempt. */
export type UpdateAttributesResult =
  | { ok: true; value: UpdatedLicenseRecord }
  | { ok: false; error: UpdateAttributesError };

/** Failure reasons an attribute-update attempt can produce. */
export interface UpdateAttributesError {
  code: "validation_error" | "not_found";
  /** Offending field for validation errors, when applicable. */
  field?: string;
  message: string;
}

/** Arguments for a single attribute-update request. */
export interface UpdateAttributesInput {
  /** Target License_Key. */
  licenseKey: string;
  /** The submitted attribute changes (only present keys are applied). */
  attributes: LicenseAttributeUpdates;
  /** The authenticated caller; role + `resellerAccountId` drive ownership. */
  principal: Principal;
  /** Source IP of the request (recorded on the Audit_Entry). */
  sourceIp: string;
}

/** Injected collaborators for {@link createAttributeUpdater}. */
export interface UpdateAttributesDeps {
  /** DynamoDB client (real or the in-memory fake). */
  dynamo: DynamoClient;
  /** Append-only audit log used to record the change (Req 6.6). */
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

/** The attribute-update API surface returned by {@link createAttributeUpdater}. */
export interface AttributeUpdater {
  /**
   * Validate the submitted attributes, enforce ownership, update exactly the
   * submitted attributes on the same `pdm-licenses` item (leaving the rest
   * unchanged), append an Audit_Entry with before/after values, and return the
   * updated record — or a typed error leaving the record unchanged.
   */
  update(input: UpdateAttributesInput): Promise<UpdateAttributesResult>;
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fail(error: UpdateAttributesError): UpdateAttributesResult {
  return { ok: false, error };
}

const NOT_FOUND: UpdateAttributesError = { code: "not_found", message: "Not found" };

/** True when `key` was submitted (present with a value other than `undefined`). */
function isSubmitted(attributes: LicenseAttributeUpdates, key: keyof LicenseAttributeUpdates): boolean {
  return (
    Object.prototype.hasOwnProperty.call(attributes, key) &&
    attributes[key] !== undefined
  );
}

/** True when an `expiresAt` value is a request to clear the attribute (Req 6.5). */
function isClear(value: unknown): boolean {
  return value === null || value === "";
}

/** Current number of Activation_Entries on a raw License_Record (Req 6.3). */
function activationCountOf(item: DynamoItem): number {
  const map = item.activations;
  if (map === null || typeof map !== "object") {
    return 0;
  }
  return Object.keys(map as Record<string, unknown>).length;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build an {@link AttributeUpdater} from injected collaborators.
 */
export function createAttributeUpdater(deps: UpdateAttributesDeps): AttributeUpdater {
  const dynamo = deps.dynamo;
  const audit = deps.audit;
  const now = deps.now ?? (() => new Date());
  const tableName = deps.tableName ?? LICENSES_TABLE_NAME;
  const assertOwnership = deps.assertOwnership ?? defaultAssertOwnership;

  return {
    async update(input) {
      const { licenseKey, attributes, principal, sourceIp } = input;

      // ── Never read or modify trial-anchor items (Req 14.4); not-found. ──
      if (licenseKey.startsWith(TRIAL_ANCHOR_PREFIX)) {
        return fail(NOT_FOUND);
      }

      // ── Format-validate the submitted attributes BEFORE any read/write so a
      //    rejected request never mutates state (Req 6.2, 6.4). The
      //    count-dependent check (Req 6.3) runs after the record is loaded. ──

      // plan: when submitted, must be a string.
      if (isSubmitted(attributes, "plan") && typeof attributes.plan !== "string") {
        return fail({ code: "validation_error", field: "plan", message: "plan must be a string" });
      }

      // owner: when submitted, must be a string.
      if (isSubmitted(attributes, "owner") && typeof attributes.owner !== "string") {
        return fail({ code: "validation_error", field: "owner", message: "owner must be a string" });
      }

      // features: when submitted, must be an array of strings.
      if (isSubmitted(attributes, "features")) {
        const features = attributes.features;
        if (!Array.isArray(features) || !features.every((f) => typeof f === "string")) {
          return fail({
            code: "validation_error",
            field: "features",
            message: "features must be an array of strings",
          });
        }
      }

      // maxActivations: when submitted, must be an integer ≥ 1 (Req 6.2).
      let newMaxActivations: number | undefined;
      if (isSubmitted(attributes, "maxActivations")) {
        const validated = validateMaxActivations(attributes.maxActivations);
        if (!validated.ok) {
          return fail({ code: "validation_error", field: "maxActivations", message: validated.error });
        }
        newMaxActivations = validated.value;
      }

      // expiresAt: when submitted, either clear it (empty) or validate ISO 8601 (Req 6.4, 6.5).
      let clearExpiresAt = false;
      let newExpiresAt: string | undefined;
      const expiresAtSubmitted = isSubmitted(attributes, "expiresAt");
      if (expiresAtSubmitted) {
        if (isClear(attributes.expiresAt)) {
          clearExpiresAt = true;
        } else {
          const validated = validateIso8601Utc(attributes.expiresAt);
          if (!validated.ok) {
            return fail({ code: "validation_error", field: "expiresAt", message: validated.error });
          }
          newExpiresAt = validated.value;
        }
      }

      // ── Load the existing record from the shared licenses item (Req 6.1, 14.1). ──
      const existing = (await dynamo.get({
        TableName: tableName,
        Key: { [LICENSE_PARTITION_KEY]: licenseKey },
      })) as (DynamoItem & { resellerAccountId?: string | null }) | null;

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

      // ── maxActivations may not drop below the current activation count (Req 6.3). ──
      if (newMaxActivations !== undefined) {
        const currentCount = activationCountOf(existing);
        if (newMaxActivations < currentCount) {
          return fail({
            code: "validation_error",
            field: "maxActivations",
            message: `maxActivations (${newMaxActivations}) cannot be less than the current activation count (${currentCount})`,
          });
        }
      }

      // ── Build the SET/REMOVE update touching only the submitted attributes
      //    (Req 6.1) and the before/after audit changes (Req 6.6). ──
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const setParts: string[] = [];
      const removeParts: string[] = [];
      const changes: AuditChanges = {};

      const setAttr = (attr: string, value: unknown): void => {
        names[`#${attr}`] = attr;
        values[`:${attr}`] = value;
        setParts.push(`#${attr} = :${attr}`);
        changes[attr] = { before: existing[attr] ?? null, after: value };
      };

      if (isSubmitted(attributes, "plan")) {
        setAttr("plan", attributes.plan);
      }
      if (isSubmitted(attributes, "owner")) {
        setAttr("owner", attributes.owner);
      }
      if (isSubmitted(attributes, "features")) {
        setAttr("features", attributes.features);
      }
      if (newMaxActivations !== undefined) {
        setAttr("maxActivations", newMaxActivations);
      }
      if (expiresAtSubmitted) {
        if (clearExpiresAt) {
          names["#expiresAt"] = "expiresAt";
          removeParts.push("#expiresAt");
          changes.expiresAt = { before: existing.expiresAt ?? null, after: null };
        } else {
          setAttr("expiresAt", newExpiresAt);
        }
      }

      // ── No submitted attributes → no-op success; nothing changed, no audit. ──
      if (setParts.length === 0 && removeParts.length === 0) {
        return {
          ok: true,
          value: { ...existing, licenseKey } as UpdatedLicenseRecord,
        };
      }

      // ── Apply the update on the same item the Lambdas read (Req 6.1, 14.1). ──
      const clauses: string[] = [];
      if (setParts.length > 0) {
        clauses.push(`SET ${setParts.join(", ")}`);
      }
      if (removeParts.length > 0) {
        clauses.push(`REMOVE ${removeParts.join(", ")}`);
      }

      const updated = await dynamo.update({
        TableName: tableName,
        Key: { [LICENSE_PARTITION_KEY]: licenseKey },
        UpdateExpression: clauses.join(" "),
        ExpressionAttributeNames: names,
        ...(Object.keys(values).length > 0
          ? { ExpressionAttributeValues: values }
          : {}),
      });

      const record: UpdatedLicenseRecord = {
        ...(updated ?? { ...existing }),
        licenseKey,
      } as UpdatedLicenseRecord;

      // ── Record the attribute Audit_Entry with before/after values (Req 6.6). ──
      await audit.writeAuditEntry({
        actor: principal.identity,
        actorRole: principal.role,
        action: LICENSE_ATTRIBUTES_ACTION,
        target: licenseKey,
        sourceIp,
        timestamp: now().toISOString(),
        changes,
      });

      return { ok: true, value: record };
    },
  };
}
