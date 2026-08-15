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
 *  - updates the six additive Customer_Fields, normalizing and validating every
 *    submitted field before the record is read (a rejected field names all
 *    offenders and mutates nothing), then `SET`ting each non-empty normalized
 *    value and `REMOVE`ing each null/empty/whitespace-only one — a no-op when
 *    the attribute is already absent (Req 2.1, 2.2, 4.9, 4.13);
 *  - never touches `TRIAL#` anchor items (Req 14.4) or `RL#` rate-limit counter
 *    items (Req 2.6, 3.6); and
 *  - writes an Audit_Entry recording the actor, the License_Key, and the changed
 *    attributes with their previous and new values, plus sorted
 *    `customerFieldsSet` / `customerFieldsCleared` name arrays written only when
 *    a Customer_Field actually changed (Req 6.6, 9.1, 9.2, 9.7).
 *
 * All validation happens before any write, so a rejected request never mutates
 * state (Req 6.2, 6.3, 6.4, 2.9, 4.9). Every external collaborator — the
 * {@link DynamoClient}, the {@link AuditLog}, the clock, and the ownership
 * check — is injected, so the property/unit tests (8.4/8.5) can drive this
 * module entirely against the in-memory DynamoDB fake.
 *
 * @module lib/licenses/attributes
 * Requirements: 2.1, 2.2, 2.4, 2.6, 2.7, 2.9, 4.9, 4.13, 6.1, 6.2, 6.3, 6.4,
 * 6.5, 6.6, 9.1, 9.2, 9.7, 10.13
 */

import type { DynamoClient, DynamoItem } from "../dynamo.ts";
import type { AuditLog, AuditChanges } from "../audit.ts";
import type { AuthOutcome, OwnableRecord, Principal } from "../auth.ts";
import { validateIso8601Utc, validateMaxActivations } from "../validation.ts";
import {
  LICENSES_TABLE_NAME,
  LICENSE_PARTITION_KEY,
  RL_COUNTER_PREFIX,
  TRIAL_ANCHOR_PREFIX,
} from "./create.ts";
import {
  CUSTOMER_FIELDS,
  evaluateCustomerProfile,
  type CustomerField,
} from "./customer.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Audit action recorded for a license attribute update (Req 6.6). */
export const LICENSE_ATTRIBUTES_ACTION = "license.attributes.update";

/**
 * Prefix marking rate-limit counter items (`RL#<bucket>#<ip>`) the portal must
 * never touch through the license API — guarded alongside {@link
 * TRIAL_ANCHOR_PREFIX} so a counter item is unreachable via an attribute update
 * (Req 2.6, 3.6). Re-exported from {@link module:lib/licenses/create} so the
 * license prefix constants live in one place. Imported above and re-exported
 * here so this module's existing consumers keep importing it unchanged.
 */
export { RL_COUNTER_PREFIX };

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
  /**
   * The six additive Customer_Fields, kept `unknown` so this module can reject
   * non-string values itself via {@link evaluateCustomerProfile} before any
   * read or write (Req 2.1, 4.7, 4.9). Each is normalized and either written
   * (non-empty) or removed (null/empty/whitespace-only, Req 2.2, 4.13).
   */
  customerEmail?: unknown;
  customerName?: unknown;
  customerPhone?: unknown;
  customerCountry?: unknown;
  customerCompany?: unknown;
  customerNotes?: unknown;
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
  /** Primary offending field for validation errors, when applicable. */
  field?: string;
  /**
   * Every offending field for validation errors that can name more than one at
   * once — Requirement 4.9 requires naming all failing Customer_Fields. When
   * present, the route surfaces this array; `field` mirrors its first entry for
   * callers that read a single field.
   */
  fields?: string[];
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

      // ── Never read or modify trial-anchor or rate-limit counter items; a
      //    target beginning with `TRIAL#` (Req 14.4) or `RL#` (Req 2.6, 3.6) is
      //    reported as not-found so counter items stay unreachable here. ──
      if (
        licenseKey.startsWith(TRIAL_ANCHOR_PREFIX) ||
        licenseKey.startsWith(RL_COUNTER_PREFIX)
      ) {
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

      // ── Evaluate every submitted Customer_Field BEFORE the record is read, so
      //    a rejected update never mutates state (Req 2.9, 4.9). The evaluator
      //    normalizes each submitted field and reports the fields to `set`
      //    (normalized, non-empty, valid), the fields to `clear`
      //    (null/empty/whitespace-only → REMOVE), and every offending field. A
      //    non-empty `errors` names ALL failing Customer_Fields (Req 4.9). ──
      const customer = evaluateCustomerProfile(
        attributes as Record<string, unknown>
      );
      if (customer.errors.length > 0) {
        const fields = customer.errors.map((e) => e.field).sort();
        return fail({
          code: "validation_error",
          field: fields[0],
          fields,
          message: customer.errors.map((e) => e.reason).join("; "),
        });
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

      // ── Customer_Fields: SET a normalized non-empty value, REMOVE a cleared
      //    one, tracking only the fields that actually changed for the audit
      //    (Req 2.1, 2.2, 4.13, 9.1, 9.2). Iterate in the canonical order so the
      //    recorded name arrays are stable before sorting. ──
      const customerFieldsSet: CustomerField[] = [];
      const customerFieldsCleared: CustomerField[] = [];

      for (const field of CUSTOMER_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(customer.set, field)) {
          // Submitted + non-empty after normalization → SET; record the name
          // only when the stored value actually changes (Req 2.4, 9.7).
          const normalized = customer.set[field] as string;
          if (existing[field] !== normalized) {
            names[`#${field}`] = field;
            values[`:${field}`] = normalized;
            setParts.push(`#${field} = :${field}`);
            customerFieldsSet.push(field);
          }
        } else if (customer.clear.includes(field)) {
          // Submitted + empty → REMOVE, but a no-op when already absent so the
          // record and the audit stay unchanged (Req 2.2, 9.7).
          if (existing[field] !== undefined && existing[field] !== null) {
            names[`#${field}`] = field;
            removeParts.push(`#${field}`);
            customerFieldsCleared.push(field);
          }
        }
      }

      // Additive audit keys, written only when a Customer_Field actually
      // changed — sorted names only, never values (Req 2.7, 9.1, 9.2). When
      // none changed, neither key appears, leaving the entry byte-identical to
      // today's (Req 9.7).
      if (customerFieldsSet.length > 0) {
        changes.customerFieldsSet = {
          before: null,
          after: [...customerFieldsSet].sort(),
        };
      }
      if (customerFieldsCleared.length > 0) {
        changes.customerFieldsCleared = {
          before: [...customerFieldsCleared].sort(),
          after: null,
        };
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
