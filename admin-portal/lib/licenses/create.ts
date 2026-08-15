/**
 * License_Record creation for the Admin & Reseller Portal.
 *
 * Mints a unique License_Key and writes a new License_Record to the existing
 * `pdm-licenses` DynamoDB table, then records a create Audit_Entry. The write:
 *
 *  - uses a conditional `PutItem` with `attribute_not_exists(licenseKey)` so a
 *    key is only ever written when no record already claims it (Req 3.3), with
 *    **bounded regeneration** on the (astronomically unlikely) collision — a
 *    small number of retries, then a hard error rather than an unbounded loop;
 *  - sets `status` = `active`, `activations` = an empty map, and `createdAt` to
 *    the creation time in ISO 8601 UTC (Req 3.2);
 *  - records the creating Reseller_Account in the **additive** `resellerAccountId`
 *    attribute for reseller-created records, which never collides with the
 *    existing License_Record schema the activate/validate/trial Lambdas read
 *    (Req 3.6, 14.2, 14.3);
 *  - preserves the existing schema attributes exactly (Req 14.2); and
 *  - never touches `TRIAL#` anchor items — generated keys are always `PDM-…`
 *    and the conditional write only ever creates a brand-new `PDM-…` item, so
 *    no trial anchor can be read or modified (Req 14.4).
 *
 * Every external collaborator — the {@link DynamoClient}, the {@link AuditLog},
 * the clock, and the key generator — is injected, so the property/unit tests
 * can drive this module entirely against the in-memory DynamoDB fake.
 *
 * @module lib/licenses/create
 * Requirements: 3.1, 3.2, 3.3, 3.6, 3.7, 14.2, 14.3, 14.4
 */

import { ConditionalCheckFailedError, type DynamoClient, type DynamoItem } from "../dynamo.ts";
import type { AuditChanges, AuditLog } from "../audit.ts";
import { generateLicenseKey, KeyGenerationError } from "./keygen.ts";
import type { CustomerProfile } from "./customer.ts";
import { validateIso8601Utc, validateMaxActivations } from "../validation.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** The existing licenses table this module reads and writes (Req 14.1). */
export const LICENSES_TABLE_NAME = "pdm-licenses";

/** Partition key of the licenses table. */
export const LICENSE_PARTITION_KEY = "licenseKey";

/** Prefix marking trial-anchor items that the portal must never touch (Req 14.4). */
export const TRIAL_ANCHOR_PREFIX = "TRIAL#";

/**
 * Prefix marking rate-limit counter items (`RL#<bucket>#<ip>`) the portal must
 * never touch or surface through the license API — guarded alongside
 * {@link TRIAL_ANCHOR_PREFIX} so a counter item is unreachable via an attribute
 * update and is excluded from every license list/search (Req 2.6, 3.6).
 */
export const RL_COUNTER_PREFIX = "RL#";

/** Audit action recorded for a license creation. */
export const LICENSE_CREATE_ACTION = "license.create";

/** Default number of key-generation attempts before giving up (Req 3.3). */
export const DEFAULT_MAX_KEY_ATTEMPTS = 5;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * A License_Record as persisted in `pdm-licenses`. The first block is the
 * existing schema preserved verbatim (Req 14.2); `resellerAccountId` is the
 * only additive attribute (Req 14.3) and is present only for reseller-created
 * records.
 */
export interface LicenseRecord extends CustomerProfile {
  licenseKey: string;
  status: "active";
  plan: string;
  owner?: string;
  features: string[];
  maxActivations: number;
  expiresAt?: string;
  activations: Record<string, never>;
  createdAt: string;
  /** Additive: owning Reseller_Account, absent for admin-created records. */
  resellerAccountId?: string;
  /**
   * Additive: normalized Custom_Key_Prefix, stored verbatim only when a prefix
   * was supplied and omitted otherwise (Req 5.8, 10.3).
   */
  keyPrefix?: string;
}

/** The actor context needed to write the create Audit_Entry (Req 3.7). */
export interface CreateActor {
  /** Actor identity (Firebase UID or Api_Key id). */
  actor: string;
  /** Actor role at the time of the action. */
  actorRole: string;
  /** Source IP of the request. */
  sourceIp: string;
}

/** Caller-supplied, already-authorized create-license attributes. */
export interface CreateLicenseInput {
  /** License plan label. Defaults to `standard` when omitted. */
  plan?: string;
  /** Activation cap; must be an integer ≥ 1 (Req 3.4). */
  maxActivations: number;
  /** Optional human-readable owner label. */
  owner?: string;
  /** Optional ISO 8601 UTC expiry; absent means perpetual (Req 3.5). */
  expiresAt?: string;
  /** Optional feature flags; defaults to an empty list. */
  features?: string[];
  /**
   * Owning Reseller_Account for reseller-created records (Req 3.6). Omit / null
   * for admin-created records.
   */
  resellerAccountId?: string | null;
  /**
   * Already-normalized, already-authorized Custom_Key_Prefix (Req 5.1, 5.7).
   * The route normalizes/validates and authorizes it; this module persists it
   * verbatim and feeds it to every key-generation attempt. Absent means an
   * unprefixed key.
   */
  keyPrefix?: string;
  /**
   * Already-normalized Customer_Profile (Req 1.2). Only the fields to store are
   * present; each is spread onto the item so absent fields never appear.
   */
  customer?: CustomerProfile;
}

/** Discriminated-union outcome of a create attempt. */
export type CreateLicenseResult =
  | { ok: true; value: LicenseRecord }
  | { ok: false; error: CreateLicenseError };

/** Failure reasons a create attempt can produce. */
export interface CreateLicenseError {
  code: "validation_error" | "key_generation_failed" | "write_failed";
  /** Offending field for validation errors, when applicable. */
  field?: string;
  message: string;
}

/** Injected collaborators for {@link createLicenseCreator}. */
export interface CreateLicenseDeps {
  /** DynamoDB client (real or the in-memory fake). */
  dynamo: DynamoClient;
  /** Append-only audit log used to record the creation (Req 3.7). */
  audit: AuditLog;
  /** Clock injection for a deterministic `createdAt` (defaults to `Date`). */
  now?: () => Date;
  /**
   * Key generator injection (defaults to {@link generateLicenseKey}). Receives
   * the optional Custom_Key_Prefix so a collision regenerates only the
   * Key_Secret_Component while the prefix stays fixed (Req 5.9). A generator
   * that ignores the argument (as older tests do) remains compatible.
   */
  generateKey?: (prefix?: string) => string;
  /** Override the licenses table name (defaults to {@link LICENSES_TABLE_NAME}). */
  tableName?: string;
  /** Bounded regeneration attempts on collision (defaults to {@link DEFAULT_MAX_KEY_ATTEMPTS}). */
  maxKeyAttempts?: number;
}

/** The create API surface returned by {@link createLicenseCreator}. */
export interface LicenseCreator {
  /**
   * Validate, mint a unique License_Key, write the new License_Record via a
   * conditional (collision-free) put with bounded regeneration, and append a
   * create Audit_Entry. Returns the persisted record or a typed error.
   */
  create(input: CreateLicenseInput, actor: CreateActor): Promise<CreateLicenseResult>;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

function fail(error: CreateLicenseError): CreateLicenseResult {
  return { ok: false, error };
}

/**
 * Build a {@link LicenseCreator} from injected collaborators.
 */
export function createLicenseCreator(deps: CreateLicenseDeps): LicenseCreator {
  const dynamo = deps.dynamo;
  const audit = deps.audit;
  const now = deps.now ?? (() => new Date());
  const generateKey = deps.generateKey ?? generateLicenseKey;
  const tableName = deps.tableName ?? LICENSES_TABLE_NAME;
  const maxKeyAttempts = deps.maxKeyAttempts ?? DEFAULT_MAX_KEY_ATTEMPTS;

  return {
    async create(input, actor) {
      // ── Validate the constrained inputs (defense-in-depth; the route also
      //    validates before calling here). ──
      const maxActivations = validateMaxActivations(input.maxActivations);
      if (!maxActivations.ok) {
        return fail({ code: "validation_error", field: "maxActivations", message: maxActivations.error });
      }

      let expiresAt: string | undefined;
      if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== "") {
        const expiry = validateIso8601Utc(input.expiresAt);
        if (!expiry.ok) {
          return fail({ code: "validation_error", field: "expiresAt", message: expiry.error });
        }
        expiresAt = expiry.value;
      }

      const plan = input.plan ?? "standard";
      const features = input.features ?? [];
      const resellerAccountId =
        input.resellerAccountId != null ? input.resellerAccountId : undefined;
      const createdAt = now().toISOString();

      // ── Mint a unique key with bounded regeneration on collision (Req 3.3). ──
      // Prefix persisted verbatim only when supplied (Req 5.8, 10.3).
      const keyPrefix =
        input.keyPrefix !== undefined && input.keyPrefix !== ""
          ? input.keyPrefix
          : undefined;

      let record: LicenseRecord | undefined;
      for (let attempt = 0; attempt < maxKeyAttempts; attempt++) {
        // Regenerate only the Key_Secret_Component on each attempt; the prefix
        // stays fixed (Req 5.9). A KeyGenerationError surfaces before any write
        // and is mapped to key_generation_failed (Req 6.8).
        let licenseKey: string;
        try {
          licenseKey = generateKey(keyPrefix);
        } catch (err) {
          if (err instanceof KeyGenerationError) {
            return fail({ code: "key_generation_failed", message: err.message });
          }
          throw err;
        }

        // Generated keys are always `PDM-…`; guard so a bad generator can never
        // cause the portal to write/overwrite a `TRIAL#` anchor (Req 14.4).
        if (licenseKey.startsWith(TRIAL_ANCHOR_PREFIX)) {
          continue;
        }

        const candidate: LicenseRecord = {
          licenseKey,
          status: "active",
          plan,
          owner: input.owner,
          features,
          maxActivations: maxActivations.value,
          expiresAt,
          activations: {},
          createdAt,
          resellerAccountId,
          // Persist the prefix verbatim when present (Req 5.8).
          ...(keyPrefix !== undefined ? { keyPrefix } : {}),
          // Spread the normalized Customer_Profile; only present fields appear,
          // so absent Customer_Fields never land on the item (Req 1.2, 1.3).
          ...(input.customer ?? {}),
        };

        try {
          // Conditional put: writes only when no record claims this key.
          await dynamo.conditionalPut(
            tableName,
            candidate as unknown as DynamoItem,
            LICENSE_PARTITION_KEY
          );
          record = candidate;
          break;
        } catch (err) {
          if (err instanceof ConditionalCheckFailedError) {
            // Collision — regenerate and retry within the bounded budget.
            continue;
          }
          throw err;
        }
      }

      if (!record) {
        return fail({
          code: "key_generation_failed",
          message: `Failed to mint a unique license key after ${maxKeyAttempts} attempts`,
        });
      }

      // ── Record the create Audit_Entry with the submitted attributes (Req 3.7). ──
      const changes: AuditChanges = {
        plan: { before: null, after: record.plan },
        maxActivations: { before: null, after: record.maxActivations },
        owner: { before: null, after: record.owner ?? null },
        features: { before: null, after: record.features },
        expiresAt: { before: null, after: record.expiresAt ?? null },
        status: { before: null, after: record.status },
        resellerAccountId: { before: null, after: record.resellerAccountId ?? null },
      };

      // Additive audit keys, written only when non-empty (Req 1.8, 5.10, 9.1, 9.2).
      // keyPrefix carries its normalized value; customerFieldsSet carries the
      // changed field names only — sorted, never their values.
      if (keyPrefix !== undefined) {
        changes.keyPrefix = { before: null, after: keyPrefix };
      }
      const customerFieldsSet = Object.keys(input.customer ?? {}).sort();
      if (customerFieldsSet.length > 0) {
        changes.customerFieldsSet = { before: null, after: customerFieldsSet };
      }

      await audit.writeAuditEntry({
        actor: actor.actor,
        actorRole: actor.actorRole,
        action: LICENSE_CREATE_ACTION,
        target: record.licenseKey,
        sourceIp: actor.sourceIp,
        timestamp: createdAt,
        changes,
      });

      return { ok: true, value: record };
    },
  };
}
