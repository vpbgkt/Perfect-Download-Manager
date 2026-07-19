/**
 * Append-only Audit_Log writer and query helpers for the Admin & Reseller Portal.
 *
 * Every mutating Portal_Backend operation records an immutable Audit_Entry that
 * captures the actor identity, actor role, action, target identifier, source IP,
 * an ISO 8601 UTC timestamp, and the before/after values of any changed
 * attributes (Req 13.1, 13.2).
 *
 * Design guarantees:
 * - **Append-only** (Req 13.3): writes use a conditional `PutItem` with
 *   `attribute_not_exists` on a unique `auditId`, so an existing entry is never
 *   overwritten. No update/delete is ever issued against the audit table.
 * - **Secret scrubbing** (Req 13.5, 11.6, 15.1): any Signing_Key, Api_Key
 *   plaintext secret, password, or MFA/OTP secret is stripped from the entry
 *   (including nested `changes` values) before it is persisted.
 * - **Queryable** (Req 13.4): helpers query by actor, target, action, or time
 *   range over their respective GSIs, each keyed on a `timestamp` sort key.
 *
 * The module is a thin layer over the injected {@link DynamoClient}, so tests
 * can drive it with the in-memory fake document client.
 *
 * @module lib/audit
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5
 */

import { randomUUID } from "node:crypto";
import type { DynamoClient, DynamoItem, PaginatedResult } from "./dynamo.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** DynamoDB table backing the append-only Audit_Log. */
export const AUDIT_TABLE_NAME = "pdm-portal-audit";

/** Partition key attribute of the audit table (unique per entry). */
export const AUDIT_PARTITION_KEY = "auditId";

/**
 * A constant partition value written on every entry so the time-range GSI can
 * be queried across all entries with `timestamp` as its sort key.
 */
export const AUDIT_TIME_PARTITION_ATTR = "logScope";
export const AUDIT_TIME_PARTITION_VALUE = "AUDIT";

/** Global secondary index names supporting the query helpers (Req 13.4). */
export const AUDIT_INDEXES = {
  actor: "actor-timestamp-index",
  target: "target-timestamp-index",
  action: "action-timestamp-index",
  time: "logScope-timestamp-index",
} as const;

// ─── Types ───────────────────────────────────────────────────────────────────

/** Previous/new values of a single changed attribute (secrets already stripped). */
export interface AuditChange {
  before: unknown;
  after: unknown;
}

/** Map of attribute name → its before/after change. */
export type AuditChanges = Record<string, AuditChange>;

/**
 * Caller-supplied audit input. `auditId` and `timestamp` are optional and are
 * generated when omitted.
 */
export interface AuditEntryInput {
  /** Actor identity (e.g. admin id, reseller account id, api key id). */
  actor: string;
  /** Actor role at the time of the action. */
  actorRole: string;
  /** Action performed, e.g. `license.create`, `license.status.update`. */
  action: string;
  /** Target identifier the action applied to (e.g. a License_Key). */
  target: string;
  /** Source IP address of the request. */
  sourceIp: string;
  /** Before/after values of changed attributes. Secrets are stripped. */
  changes?: AuditChanges;
  /** Optional explicit timestamp (ISO 8601 UTC). Defaults to now. */
  timestamp?: string;
  /** Optional explicit unique id. Defaults to a generated UUID. */
  auditId?: string;
}

/** A fully-formed, persisted Audit_Entry. */
export interface AuditEntry {
  auditId: string;
  timestamp: string;
  actor: string;
  actorRole: string;
  action: string;
  target: string;
  sourceIp: string;
  changes: AuditChanges;
}

/** Options common to every query helper. */
export interface AuditQueryOptions {
  /** Inclusive lower bound on `timestamp` (ISO 8601 UTC). */
  start?: string;
  /** Inclusive upper bound on `timestamp` (ISO 8601 UTC). */
  end?: string;
  /** Max entries per page. */
  pageSize?: number;
  /** Continuation token from a previous page. */
  continuationToken?: string;
}

/** Options for a pure time-range query. */
export type AuditTimeRangeQueryOptions = Omit<AuditQueryOptions, "start" | "end"> & {
  start?: string;
  end?: string;
};

/** Dependency-injection options for {@link createAuditLog}. */
export interface AuditLogOptions {
  /** Override the audit table name (defaults to {@link AUDIT_TABLE_NAME}). */
  tableName?: string;
  /** Clock injection for deterministic tests. Returns an ISO 8601 UTC string. */
  now?: () => string;
  /** Unique id generator injection for deterministic tests. */
  generateId?: () => string;
}

/** The audit-log API surface returned by {@link createAuditLog}. */
export interface AuditLog {
  /**
   * Append an Audit_Entry via a conditional (append-only) PutItem. Secrets are
   * scrubbed before persistence. Returns the persisted entry.
   * Throws ConditionalCheckFailedError (from lib/dynamo) if the
   * generated id already exists (never overwrites — Req 13.3).
   */
  writeAuditEntry(entry: AuditEntryInput): Promise<AuditEntry>;

  /** Query entries for an actor, optionally within a time range (Req 13.4). */
  queryByActor(actor: string, options?: AuditQueryOptions): Promise<PaginatedResult<AuditEntry>>;

  /** Query entries for a target, optionally within a time range (Req 13.4). */
  queryByTarget(target: string, options?: AuditQueryOptions): Promise<PaginatedResult<AuditEntry>>;

  /** Query entries for an action, optionally within a time range (Req 13.4). */
  queryByAction(action: string, options?: AuditQueryOptions): Promise<PaginatedResult<AuditEntry>>;

  /** Query entries within a time range across the whole log (Req 13.4). */
  queryByTimeRange(options?: AuditTimeRangeQueryOptions): Promise<PaginatedResult<AuditEntry>>;
}

// ─── Secret Scrubbing (Req 13.5, 11.6, 15.1) ──────────────────────────────────

/**
 * Substrings (matched against a normalized, lowercased, alphanumeric-only key)
 * that mark an attribute as secret. Any matching key is removed before an entry
 * is persisted, so no Signing_Key, Api_Key plaintext secret, password, or
 * MFA/OTP secret is ever written to the Audit_Log.
 *
 * Note: identifiers such as `apiKeyId` are intentionally NOT scrubbed — only
 * secret-bearing fields are. `apiKeyId` normalizes to `apikeyid`, which does not
 * contain any of the secret markers below.
 */
const SECRET_KEY_MARKERS: readonly string[] = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "otp",
  "mfa",
  "signingkey",
  "privatekey",
  "plaintext",
];

/** Normalize a key for secret matching: lowercase, alphanumeric only. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** True when the attribute name denotes a secret value that must be scrubbed. */
export function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return SECRET_KEY_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Recursively strip secret-bearing keys from any value. Objects are copied with
 * secret keys removed and remaining values scrubbed; arrays are scrubbed
 * element-wise; primitives are returned unchanged.
 */
export function scrubSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => scrubSecrets(item)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(key)) {
        continue; // drop secret field entirely
      }
      result[key] = scrubSecrets(val);
    }
    return result as unknown as T;
  }
  return value;
}

// ─── Factory ───────────────────────────────────────────────────────────────

/**
 * Create an {@link AuditLog} bound to a {@link DynamoClient}.
 *
 * @param client  DynamoDB client (real or the in-memory fake used in tests).
 * @param options Table name / clock / id-generator injection.
 */
export function createAuditLog(client: DynamoClient, options: AuditLogOptions = {}): AuditLog {
  const tableName = options.tableName ?? AUDIT_TABLE_NAME;
  const now = options.now ?? (() => new Date().toISOString());
  const generateId = options.generateId ?? (() => randomUUID());

  async function runQuery(
    indexName: string,
    partitionAttr: string,
    partitionValue: string,
    options: AuditQueryOptions | undefined
  ): Promise<PaginatedResult<AuditEntry>> {
    const { start, end, pageSize, continuationToken } = options ?? {};

    const names: Record<string, string> = {
      "#pk": partitionAttr,
      "#ts": "timestamp",
    };
    const values: Record<string, unknown> = {
      ":pk": partitionValue,
    };

    let keyCondition = "#pk = :pk";
    if (start !== undefined && end !== undefined) {
      keyCondition += " AND #ts BETWEEN :start AND :end";
      values[":start"] = start;
      values[":end"] = end;
    } else if (start !== undefined) {
      keyCondition += " AND #ts >= :start";
      values[":start"] = start;
    } else if (end !== undefined) {
      keyCondition += " AND #ts <= :end";
      values[":end"] = end;
    }

    const params = {
      TableName: tableName,
      IndexName: indexName,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    };

    const result = pageSize
      ? await client.paginatedQuery(params, pageSize, continuationToken)
      : await client.query(params);

    return {
      items: result.items as unknown as AuditEntry[],
      nextToken: result.nextToken,
    };
  }

  return {
    async writeAuditEntry(entry) {
      const persisted: AuditEntry = {
        auditId: entry.auditId ?? generateId(),
        timestamp: entry.timestamp ?? now(),
        actor: entry.actor,
        actorRole: entry.actorRole,
        action: entry.action,
        target: entry.target,
        sourceIp: entry.sourceIp,
        changes: entry.changes ?? {},
      };

      // Strip any secret-bearing fields (Req 13.5) — including nested values
      // inside the changes map — before the entry ever reaches DynamoDB.
      const scrubbed = scrubSecrets(persisted);

      const item: DynamoItem = {
        ...scrubbed,
        // constant partition for the time-range GSI (Req 13.4)
        [AUDIT_TIME_PARTITION_ATTR]: AUDIT_TIME_PARTITION_VALUE,
      };

      // Append-only: conditional put on the unique id never overwrites (Req 13.3).
      await client.conditionalPut(tableName, item, AUDIT_PARTITION_KEY);

      return scrubbed;
    },

    queryByActor(actor, options) {
      return runQuery(AUDIT_INDEXES.actor, "actor", actor, options);
    },

    queryByTarget(target, options) {
      return runQuery(AUDIT_INDEXES.target, "target", target, options);
    },

    queryByAction(action, options) {
      return runQuery(AUDIT_INDEXES.action, "action", action, options);
    },

    queryByTimeRange(options) {
      return runQuery(
        AUDIT_INDEXES.time,
        AUDIT_TIME_PARTITION_ATTR,
        AUDIT_TIME_PARTITION_VALUE,
        options
      );
    },
  };
}
