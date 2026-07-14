/**
 * Seo_Settings management module for the Admin & Reseller Portal.
 *
 * Owns the per-page marketing-site SEO fields — page title, meta description,
 * and the Open Graph tags (`og:title`, `og:description`, `og:image`) — persisted
 * in the `pdm-portal-seo` DynamoDB table (Req 9.1, 9.2, 9.5).
 *
 * Design guarantees:
 * - **Validation before persistence** (Req 9.3, 9.4): a submitted title must be
 *   1–70 characters (`validateSeoTitle`) and a submitted meta description 50–160
 *   characters (`validateSeoDescription`). Because validation runs before any
 *   write, an invalid submission is rejected and the page's stored Seo_Settings
 *   are left completely unchanged.
 * - **Audited mutations** (Req 9.6): every successful update appends an
 *   Audit_Entry via the injected {@link AuditLog}, recording the actor, the page
 *   identifier as the target, and each changed field's before/after values.
 * - **Machine-readable read model** (Req 9.1, 9.5): {@link SeoModule.listSeoSettings}
 *   returns the plain Seo_Settings for every managed page, which both the admin
 *   `GET /seo` view and the public `GET /seo/public` consumer endpoint serialize
 *   as JSON.
 *
 * Everything external — the {@link DynamoClient}, the {@link AuditLog}, and the
 * clock — is injected so the module can be exercised entirely with the in-memory
 * fake document client in property and unit tests.
 *
 * @module lib/seo
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6
 */

import type { DynamoClient, DynamoItem } from "./dynamo.ts";
import type { AuditLog, AuditChanges } from "./audit.ts";
import { validateSeoTitle, validateSeoDescription } from "./validation.ts";

// ─── Constants ───────────────────────────────────────────────────────────────

/** DynamoDB table backing the per-page Seo_Settings. */
export const SEO_TABLE_NAME = "pdm-portal-seo";

/** Partition key attribute of the SEO table. */
export const SEO_PARTITION_KEY = "pageId";

/** Audit action recorded when a page's Seo_Settings are updated (Req 9.6). */
export const SEO_UPDATE_ACTION = "seo.update";

/**
 * The editable SEO attributes tracked for before/after auditing. `title` and
 * `metaDescription` are required; the Open Graph tags are optional.
 */
const SEO_FIELDS = [
  "title",
  "metaDescription",
  "ogTitle",
  "ogDescription",
  "ogImage",
] as const;

// ─── Types ───────────────────────────────────────────────────────────────────

/** The editable SEO fields for a single managed marketing-site page. */
export interface SeoSettings {
  /** Marketing-site page identifier (partition key). */
  pageId: string;
  /** Page title, 1–70 characters (Req 9.3). */
  title: string;
  /** Meta description, 50–160 characters (Req 9.4). */
  metaDescription: string;
  /** Open Graph `og:title`. */
  ogTitle?: string;
  /** Open Graph `og:description`. */
  ogDescription?: string;
  /** Open Graph `og:image` URL. */
  ogImage?: string;
  /** ISO 8601 UTC timestamp of the last update. */
  updatedAt?: string;
}

/**
 * Caller-submitted SEO fields for a page. Values are `unknown` because they come
 * straight off an HTTP request body and are validated inside the module.
 */
export interface SeoUpdateInput {
  title: unknown;
  metaDescription: unknown;
  ogTitle?: unknown;
  ogDescription?: unknown;
  ogImage?: unknown;
}

/** Actor/request context recorded on the Audit_Entry for an update (Req 9.6). */
export interface SeoUpdateContext {
  /** Actor identity (e.g. admin id / firebase uid). */
  actor: string;
  /** Actor role at the time of the update. */
  actorRole: string;
  /** Source IP address of the request. */
  sourceIp: string;
}

/** A field-scoped validation failure (maps to an HTTP 400). */
export interface SeoValidationError {
  field: string;
  reason: string;
}

/** Discriminated-union outcome for a Seo_Settings update. */
export type SeoUpdateResult =
  | { ok: true; value: SeoSettings }
  | { ok: false; error: SeoValidationError };

/** Dependency-injection options for {@link createSeoModule}. */
export interface SeoModuleDeps {
  /** DynamoDB client (real or the in-memory fake used in tests). */
  dynamo: DynamoClient;
  /** Append-only audit log used to record updates (Req 9.6). */
  audit: AuditLog;
  /** Clock injection for deterministic tests. Returns an ISO 8601 UTC string. */
  now?: () => string;
  /** Override the SEO table name (defaults to {@link SEO_TABLE_NAME}). */
  tableName?: string;
  /** Page size used when paging a full-table scan of managed pages. */
  scanPageSize?: number;
}

/** The Seo_Settings API surface returned by {@link createSeoModule}. */
export interface SeoModule {
  /**
   * Return the Seo_Settings for every managed marketing-site page (Req 9.1).
   * The result is a plain, machine-readable list suitable for JSON
   * serialization by both the admin and public consumer endpoints (Req 9.5).
   */
  listSeoSettings(): Promise<SeoSettings[]>;

  /** Return the Seo_Settings for a single page, or `null` when none exist. */
  getSeoSettings(pageId: string): Promise<SeoSettings | null>;

  /**
   * Validate and persist a page's Seo_Settings, then append an Audit_Entry
   * capturing the changed fields (Req 9.2, 9.3, 9.4, 9.6). On a validation
   * failure the request is rejected and the page's stored settings are left
   * unchanged.
   */
  updateSeoSettings(
    pageId: string,
    input: SeoUpdateInput,
    context: SeoUpdateContext
  ): Promise<SeoUpdateResult>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Project a raw DynamoDB item onto the typed {@link SeoSettings} shape. */
function toSeoSettings(item: DynamoItem): SeoSettings {
  const settings: SeoSettings = {
    pageId: String(item[SEO_PARTITION_KEY] ?? ""),
    title: typeof item.title === "string" ? item.title : "",
    metaDescription:
      typeof item.metaDescription === "string" ? item.metaDescription : "",
  };
  if (typeof item.ogTitle === "string") settings.ogTitle = item.ogTitle;
  if (typeof item.ogDescription === "string")
    settings.ogDescription = item.ogDescription;
  if (typeof item.ogImage === "string") settings.ogImage = item.ogImage;
  if (typeof item.updatedAt === "string") settings.updatedAt = item.updatedAt;
  return settings;
}

/**
 * Validate an optional Open Graph tag: when present it must be a string (it is
 * trimmed). Absent values are accepted and normalized to `undefined`.
 */
function validateOptionalOgTag(
  value: unknown,
  field: string
): { ok: true; value: string | undefined } | { ok: false; error: SeoValidationError } {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string") {
    return { ok: false, error: { field, reason: `${field} must be a string` } };
  }
  return { ok: true, value: value.trim() };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a {@link SeoModule} bound to injected collaborators.
 *
 * @param deps DynamoDB client, audit log, clock, and table-name injection.
 */
export function createSeoModule(deps: SeoModuleDeps): SeoModule {
  const dynamo = deps.dynamo;
  const audit = deps.audit;
  const tableName = deps.tableName ?? SEO_TABLE_NAME;
  const now = deps.now ?? (() => new Date().toISOString());
  const scanPageSize = deps.scanPageSize ?? 100;

  async function getSeoSettings(pageId: string): Promise<SeoSettings | null> {
    const item = await dynamo.get({
      TableName: tableName,
      Key: { [SEO_PARTITION_KEY]: pageId },
    });
    return item ? toSeoSettings(item) : null;
  }

  async function listSeoSettings(): Promise<SeoSettings[]> {
    const items: DynamoItem[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await dynamo.paginatedScan(
        { TableName: tableName },
        scanPageSize,
        continuationToken
      );
      items.push(...page.items);
      continuationToken = page.nextToken;
    } while (continuationToken);
    return items.map(toSeoSettings);
  }

  async function updateSeoSettings(
    pageId: string,
    input: SeoUpdateInput,
    context: SeoUpdateContext
  ): Promise<SeoUpdateResult> {
    // Validate first so an invalid submission never reaches DynamoDB and the
    // page's stored Seo_Settings stay untouched (Req 9.3, 9.4).
    const titleResult = validateSeoTitle(input.title);
    if (!titleResult.ok) {
      return { ok: false, error: { field: "title", reason: titleResult.error } };
    }

    const descResult = validateSeoDescription(input.metaDescription);
    if (!descResult.ok) {
      return {
        ok: false,
        error: { field: "metaDescription", reason: descResult.error },
      };
    }

    const ogTitle = validateOptionalOgTag(input.ogTitle, "ogTitle");
    if (!ogTitle.ok) return { ok: false, error: ogTitle.error };
    const ogDescription = validateOptionalOgTag(input.ogDescription, "ogDescription");
    if (!ogDescription.ok) return { ok: false, error: ogDescription.error };
    const ogImage = validateOptionalOgTag(input.ogImage, "ogImage");
    if (!ogImage.ok) return { ok: false, error: ogImage.error };

    // Snapshot the current settings so the audit entry can record before/after.
    const existing = await getSeoSettings(pageId);

    const next: SeoSettings = {
      pageId,
      title: titleResult.value,
      metaDescription: descResult.value,
      ogTitle: ogTitle.value,
      ogDescription: ogDescription.value,
      ogImage: ogImage.value,
      updatedAt: now(),
    };

    // Persist the full page record (upsert). `removeUndefinedValues` on the real
    // client strips absent Open Graph tags; the fake ignores undefined too.
    const item: DynamoItem = {
      [SEO_PARTITION_KEY]: pageId,
      title: next.title,
      metaDescription: next.metaDescription,
      ogTitle: next.ogTitle,
      ogDescription: next.ogDescription,
      ogImage: next.ogImage,
      updatedAt: next.updatedAt,
    };
    await dynamo.put({ TableName: tableName, Item: item });

    // Record the changed fields with their previous and new values (Req 9.6).
    const changes: AuditChanges = {};
    for (const field of SEO_FIELDS) {
      const before = existing ? existing[field] : undefined;
      const after = next[field];
      if (before !== after) {
        changes[field] = { before: before ?? null, after: after ?? null };
      }
    }

    await audit.writeAuditEntry({
      actor: context.actor,
      actorRole: context.actorRole,
      action: SEO_UPDATE_ACTION,
      target: pageId,
      sourceIp: context.sourceIp,
      changes,
    });

    return { ok: true, value: next };
  }

  return { listSeoSettings, getSeoSettings, updateSeoSettings };
}
