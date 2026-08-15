/**
 * License_Record listing, search, and single-record view for the Admin &
 * Reseller Portal.
 *
 * All reads target the existing `pdm-licenses` DynamoDB table (Req 14.1) and
 * share three isolation/shaping guarantees:
 *
 *  - **Trial anchors are never exposed** — items whose `licenseKey` begins with
 *    `TRIAL#` are excluded from every list, search, and single-record view
 *    (Req 4.1, 14.4).
 *  - **Reseller ownership scoping** — a `reseller` caller only ever observes
 *    License_Records whose additive `resellerAccountId` equals the caller's
 *    account; `admin` / `super_admin` callers observe every (non-trial) record
 *    (Req 2.4, 4.2, 15.5). A non-owned or unknown key is reported as
 *    genuinely not-found so existence never leaks (Req 2.7, 4.6).
 *  - **Full view shape** — a single-record view returns `licenseKey`, `status`,
 *    `plan`, `owner`, `features`, `maxActivations`, `expiresAt`, `createdAt`,
 *    the current Activation_Entry count alongside `maxActivations`, and each
 *    Activation_Entry's fingerprint, `activatedAt`, and `lastSeenAt`
 *    (Req 4.5, 7.1, 7.6).
 *
 * The table has a single partition key (`licenseKey`) with no secondary index
 * over `owner`/`resellerAccountId`, so list/search page through the table with
 * the paginated scan helper and apply the trial/ownership/search predicates.
 * A `FilterExpression` is also supplied so the real DynamoDB backend filters
 * server-side; the authoritative predicate is nonetheless re-applied in-memory
 * so behaviour is identical against the in-memory fake (which does not evaluate
 * `FilterExpression`) and the paginated coverage guarantee (Req 4.3) holds:
 * iterating with successive continuation tokens visits every stored item once,
 * yielding every authorized matching record exactly once with no duplicates.
 *
 * The {@link DynamoClient} is injected so the property/unit tests (7.2–7.6) can
 * drive this module entirely against the in-memory fake document client.
 *
 * @module lib/licenses/query
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 7.1, 7.6, 2.7, 15.5
 */

import type { DynamoClient } from "../dynamo.ts";
import type { Role } from "../rbac.ts";
import {
  LICENSES_TABLE_NAME,
  LICENSE_PARTITION_KEY,
  RL_COUNTER_PREFIX,
  TRIAL_ANCHOR_PREFIX,
} from "./create.ts";
import {
  CUSTOMER_FIELDS,
  SEARCHABLE_CUSTOMER_FIELDS,
} from "./customer.ts";
import { parseLicenseContinuationToken } from "./pagination.ts";

/**
 * Re-exported for convenience: production routes inject this as the `parseToken`
 * dependency when constructing a {@link LicenseQuery} (Req 3.11).
 */
export { parseLicenseContinuationToken };

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default page size for a license list/search when the caller omits one. */
export const DEFAULT_PAGE_SIZE = 50;

/** Upper bound on the page size a caller may request. */
export const MAX_PAGE_SIZE = 100;

/**
 * Maximum length of a license search term, measured after leading/trailing
 * whitespace is removed (Req 3.2, 3.11). A longer term is rejected with a
 * validation error naming `search`.
 */
export const MAX_SEARCH_TERM_LENGTH = 128;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * The caller's authorization scope. `admin` / `super_admin` see every
 * (non-trial) record; a `reseller` is restricted to its own `resellerAccountId`
 * (Req 2.4, 4.2). A `reseller` whose `resellerAccountId` is null owns nothing.
 */
export interface LicenseQueryScope {
  role: Role;
  resellerAccountId: string | null;
}

/** One Activation_Entry from a License_Record's `activations` map (Req 7.1). */
export interface ActivationEntryView {
  /** 64-character hex machine fingerprint (the `activations` map key). */
  fingerprint: string;
  /** ISO 8601 UTC time the machine first activated, when recorded. */
  activatedAt?: string;
  /** ISO 8601 UTC time the machine was last seen, when recorded. */
  lastSeenAt?: string;
}

/** Summary shape returned for each row of a list/search page. */
export interface LicenseSummary {
  licenseKey: string;
  status: string;
  plan?: string;
  owner?: string;
  features: string[];
  maxActivations?: number;
  expiresAt?: string;
  createdAt?: string;
  /** Current number of Activation_Entries alongside `maxActivations` (Req 7.6). */
  activationCount: number;
  /** Owning Reseller_Account, when present (admin-created records omit it). */
  resellerAccountId?: string;
  /** Normalized Custom_Key_Prefix, present only when stored (Req 3.1, 10.3). */
  keyPrefix?: string;
  /** Customer_Fields — each present only when stored, never `null` (Req 3.1, 10.3). */
  customerEmail?: string;
  customerName?: string;
  customerPhone?: string;
  customerCountry?: string;
  customerCompany?: string;
  customerNotes?: string;
}

/**
 * The full single-record view (Req 4.5, 7.1, 7.6): every persisted scalar plus
 * the expanded Activation_Entries and their count.
 */
export interface LicenseView extends LicenseSummary {
  activations: ActivationEntryView[];
}

/** A paginated list/search result carrying an opaque continuation token. */
export interface LicenseListResult {
  items: LicenseSummary[];
  /** Continuation token for the next page, or undefined when exhausted. */
  nextToken?: string;
  /** Validation error when the search term or continuation token is invalid (Req 3.11). */
  error?: string;
}

/** Options controlling a list or search request. */
export interface LicenseListOptions {
  /** Max rows per page (clamped to [1, {@link MAX_PAGE_SIZE}]). */
  pageSize?: number;
  /** Opaque continuation token from a previous page. */
  continuationToken?: string;
  /**
   * Optional search term. When present, rows match when the term (case-
   * insensitively) is a substring of the `licenseKey` or the `owner` (Req 4.4).
   */
  search?: string;
}

/** Injected collaborators for {@link createLicenseQuery}. */
export interface LicenseQueryDeps {
  /** DynamoDB client (real or the in-memory fake). */
  dynamo: DynamoClient;
  /** Override the licenses table name (defaults to {@link LICENSES_TABLE_NAME}). */
  tableName?: string;
  /**
   * Continuation-token validator (defaults to {@link parseLicenseContinuationToken}).
   * In production the route passes the real parser; the in-memory fake uses a
   * different token format so tests may omit this to skip structural validation.
   */
  parseToken?: (token: unknown) => { ok: true; value: string } | { ok: false; error: string };
}

/** The read API surface returned by {@link createLicenseQuery}. */
export interface LicenseQuery {
  /**
   * Paginated, ownership-scoped list of License_Records, excluding `TRIAL#`
   * anchors. When `options.search` is set the rows are additionally filtered by
   * the search predicate (Req 4.1, 4.2, 4.3, 4.4).
   */
  list(scope: LicenseQueryScope, options?: LicenseListOptions): Promise<LicenseListResult>;

  /**
   * Fetch a single License_Record the caller is authorized to view, expanded to
   * the full view shape with its Activation_Entries and count. Returns `null`
   * for an unknown key, a `TRIAL#` anchor, or a record the caller does not own
   * (all reported as not-found — Req 2.7, 4.6).
   */
  view(scope: LicenseQueryScope, licenseKey: string): Promise<LicenseView | null>;
}

// ─── Shaping helpers ─────────────────────────────────────────────────────────

/** A raw License_Record item as stored in `pdm-licenses`. */
type RawLicense = Record<string, unknown>;

/** True when the item is a trial-anchor that must never be exposed (Req 4.1). */
function isTrialAnchor(item: RawLicense): boolean {
  const key = item[LICENSE_PARTITION_KEY];
  return typeof key === "string" && key.startsWith(TRIAL_ANCHOR_PREFIX);
}

/**
 * True when the item is a rate-limit counter (`RL#…`) that must never be
 * surfaced through the license API (Req 3.6).
 */
function isRateLimitCounter(item: RawLicense): boolean {
  const key = item[LICENSE_PARTITION_KEY];
  return typeof key === "string" && key.startsWith(RL_COUNTER_PREFIX);
}

/**
 * True when the item is an internal item (trial anchor or rate-limit counter)
 * that must be excluded from every license list, search, and view (Req 3.6, 4.1).
 */
function isInternalItem(item: RawLicense): boolean {
  return isTrialAnchor(item) || isRateLimitCounter(item);
}

/**
 * True when the caller's scope authorizes viewing this record (Req 2.4, 4.2).
 * Non-reseller roles see everything; a reseller sees only its own account.
 */
function isVisibleTo(item: RawLicense, scope: LicenseQueryScope): boolean {
  if (scope.role !== "reseller") {
    return true;
  }
  // A reseller with no account owns nothing; otherwise ownership must match.
  return (
    scope.resellerAccountId != null &&
    item.resellerAccountId === scope.resellerAccountId
  );
}

/**
 * Case-insensitive substring search over `licenseKey`, `owner`, and the
 * searchable Customer_Fields (Req 3.2, 4.4). An empty/whitespace-only term
 * matches every row (Req 3.10).
 */
function matchesSearch(item: RawLicense, search: string | undefined): boolean {
  if (search === undefined) return true;
  const needle = search.trim().toLowerCase();
  if (needle.length === 0) return true;

  const key = item[LICENSE_PARTITION_KEY];
  if (typeof key === "string" && key.toLowerCase().includes(needle)) {
    return true;
  }
  const owner = item.owner;
  if (typeof owner === "string" && owner.toLowerCase().includes(needle)) {
    return true;
  }
  // Search the four searchable Customer_Fields (Req 3.2):
  // customerEmail, customerName, customerCompany, customerPhone
  for (const field of SEARCHABLE_CUSTOMER_FIELDS) {
    const value = item[field];
    if (typeof value === "string" && value.toLowerCase().includes(needle)) {
      return true;
    }
  }
  return false;
}

/** Expand a raw `activations` map into a stable array of Activation_Entries. */
function toActivationEntries(item: RawLicense): ActivationEntryView[] {
  const map = item.activations;
  if (map === null || typeof map !== "object") {
    return [];
  }
  return Object.entries(map as Record<string, unknown>).map(([fingerprint, value]) => {
    const entry = (value ?? {}) as Record<string, unknown>;
    return {
      fingerprint,
      activatedAt: typeof entry.activatedAt === "string" ? entry.activatedAt : undefined,
      lastSeenAt: typeof entry.lastSeenAt === "string" ? entry.lastSeenAt : undefined,
    };
  });
}

/** Current count of Activation_Entries (Req 7.6). */
function activationCountOf(item: RawLicense): number {
  const map = item.activations;
  if (map === null || typeof map !== "object") {
    return 0;
  }
  return Object.keys(map as Record<string, unknown>).length;
}

/** Project a raw item to the list/search summary shape. */
function toSummary(item: RawLicense): LicenseSummary {
  const summary: LicenseSummary = {
    licenseKey: String(item[LICENSE_PARTITION_KEY]),
    status: typeof item.status === "string" ? item.status : String(item.status ?? ""),
    plan: typeof item.plan === "string" ? item.plan : undefined,
    owner: typeof item.owner === "string" ? item.owner : undefined,
    features: Array.isArray(item.features) ? (item.features as string[]) : [],
    maxActivations: typeof item.maxActivations === "number" ? item.maxActivations : undefined,
    expiresAt: typeof item.expiresAt === "string" ? item.expiresAt : undefined,
    createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
    activationCount: activationCountOf(item),
    resellerAccountId:
      typeof item.resellerAccountId === "string" ? item.resellerAccountId : undefined,
  };

  // Additive: keyPrefix, present only when stored (Req 3.1, 10.3).
  if (typeof item.keyPrefix === "string") {
    summary.keyPrefix = item.keyPrefix;
  }

  // Additive: Customer_Fields, each present only when stored, never null (Req 3.1, 10.3).
  for (const field of CUSTOMER_FIELDS) {
    const value = item[field];
    if (typeof value === "string") {
      summary[field] = value;
    }
  }

  return summary;
}

/** Project a raw item to the full single-record view shape (Req 4.5, 7.1, 7.6). */
function toView(item: RawLicense): LicenseView {
  return {
    ...toSummary(item),
    activations: toActivationEntries(item),
  };
}

/** Clamp a requested page size into the permitted range. */
function clampPageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_PAGE_SIZE;
  }
  const floored = Math.floor(requested);
  if (floored < 1) return 1;
  if (floored > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
  return floored;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build a {@link LicenseQuery} from injected collaborators.
 */
export function createLicenseQuery(deps: LicenseQueryDeps): LicenseQuery {
  const dynamo = deps.dynamo;
  const tableName = deps.tableName ?? LICENSES_TABLE_NAME;
  const parseToken = deps.parseToken;

  return {
    async list(scope, options) {
      const pageSize = clampPageSize(options?.pageSize);
      const search = options?.search;

      // ── Term-length guard (Req 3.11): reject a search term that exceeds the
      //    maximum after trimming.
      if (search !== undefined && search !== null) {
        const trimmed = typeof search === "string" ? search.trim() : "";
        if (trimmed.length > MAX_SEARCH_TERM_LENGTH) {
          return { items: [], nextToken: undefined, error: "search: term exceeds maximum length of 128 characters" };
        }
      }

      // ── Continuation-token guard (Req 3.11): route through the structural
      //    parser so a fabricated or malformed token is rejected when a validator
      //    is supplied. Production routes inject parseLicenseContinuationToken.
      let continuationToken: string | undefined;
      if (options?.continuationToken !== undefined && options.continuationToken !== null && options.continuationToken !== "") {
        if (parseToken) {
          const parsed = parseToken(options.continuationToken);
          if (!parsed.ok) {
            return { items: [], nextToken: undefined, error: parsed.error };
          }
          continuationToken = parsed.value;
        } else {
          continuationToken = options.continuationToken;
        }
      }

      // Server-side filter for the real backend: never return trial anchors or
      // RL# counter items, and (for resellers) only the caller's own account.
      // The in-memory fake ignores FilterExpression, so the same predicate is
      // re-applied below — making behaviour identical across both and keeping
      // the module correct regardless of where the filtering happens.
      const names: Record<string, string> = {
        "#pk": LICENSE_PARTITION_KEY,
      };
      const values: Record<string, unknown> = {
        ":trial": TRIAL_ANCHOR_PREFIX,
        ":rl": RL_COUNTER_PREFIX,
      };
      let filter = "NOT begins_with(#pk, :trial) AND NOT begins_with(#pk, :rl)";
      if (scope.role === "reseller") {
        names["#rid"] = "resellerAccountId";
        values[":rid"] = scope.resellerAccountId ?? "\u0000__no_account__";
        filter += " AND #rid = :rid";
      }

      const page = await dynamo.paginatedScan(
        {
          TableName: tableName,
          FilterExpression: filter,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        },
        pageSize,
        continuationToken
      );

      const items = (page.items as RawLicense[])
        .filter((item) => !isInternalItem(item))
        .filter((item) => isVisibleTo(item, scope))
        .filter((item) => matchesSearch(item, search))
        .map(toSummary);

      return { items, nextToken: page.nextToken };
    },

    async view(scope, licenseKey) {
      // Trial anchors and RL# counters are never viewable through the portal (Req 3.6, 4.1, 14.4).
      if (
        typeof licenseKey !== "string" ||
        licenseKey.startsWith(TRIAL_ANCHOR_PREFIX) ||
        licenseKey.startsWith(RL_COUNTER_PREFIX)
      ) {
        return null;
      }

      const item = (await dynamo.get({
        TableName: tableName,
        Key: { [LICENSE_PARTITION_KEY]: licenseKey },
      })) as RawLicense | null;

      // Unknown key, internal item, or a record the caller does not own all
      // collapse to the same not-found so existence never leaks (Req 2.7, 4.6).
      if (!item || isInternalItem(item) || !isVisibleTo(item, scope)) {
        return null;
      }

      return toView(item);
    },
  };
}
