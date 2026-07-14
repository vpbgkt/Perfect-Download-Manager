/**
 * Shared view-model / DTO types for the dashboard (the "Model" layer).
 * These mirror the shapes the `app/api/*` controllers return.
 *
 * @module models/types
 */

import type { Role } from "../lib/rbac.ts";

/** Authenticated principal summary from GET /api/auth/session. */
export interface SessionSummary {
  identity: string;
  role: Role;
  resellerAccountId: string | null;
  mfaEnrolled: boolean;
}

/** One Activation_Entry in a license view. */
export interface ActivationEntry {
  fingerprint: string;
  activatedAt?: string;
  lastSeenAt?: string;
}

/** Row shape for the license list/search. */
export interface LicenseSummary {
  licenseKey: string;
  status: string;
  plan?: string;
  owner?: string;
  features: string[];
  maxActivations?: number;
  expiresAt?: string;
  createdAt?: string;
  activationCount: number;
  resellerAccountId?: string;
}

/** Full single-record license view. */
export interface LicenseView extends LicenseSummary {
  activations: ActivationEntry[];
}

/** Paginated license list response. */
export interface LicenseListResult {
  items: LicenseSummary[];
  nextToken?: string;
}

/** Attributes accepted when creating a license. */
export interface CreateLicenseBody {
  plan?: string;
  maxActivations: number;
  owner?: string;
  expiresAt?: string;
  features?: string[];
}

/** Attributes accepted when updating a license. */
export interface UpdateLicenseBody {
  plan?: string;
  maxActivations?: number;
  expiresAt?: string | null;
  owner?: string;
  features?: string[];
}

/** Release_Metadata as stored/returned. */
export interface ReleaseMetadata {
  releaseId: string;
  version: string;
  msiUrl: string;
  portableZipUrl: string;
  msiSha256: string;
  portableSha256: string;
  releaseNotes: string;
  portableSizeBytes?: number;
  channel?: string;
  updatedAt: string;
}

/** Release publish submission. */
export interface ReleaseSubmission {
  version: string;
  msiUrl: string;
  portableZipUrl: string;
  msiSha256: string;
  portableSha256: string;
  releaseNotes?: string;
  portableSizeBytes?: number;
  channel?: string;
}

/** Per-page SEO settings. */
export interface SeoSettings {
  pageId: string;
  title: string;
  metaDescription: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  updatedAt?: string;
}

/** SEO update payload. */
export interface SeoUpdateBody {
  title: string;
  metaDescription: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
}

/** Reseller account record. */
export interface ResellerAccount {
  resellerAccountId: string;
  orgName: string;
  contactEmail: string;
  state: "active" | "suspended";
  createdAt?: string;
}

/** Usage plan (rate/burst/quota). */
export interface UsagePlan {
  rateLimitPerSec: number;
  burst: number;
  monthlyQuota: number;
}

/** Response from issuing an Api_Key (secret shown once). */
export interface IssuedApiKey {
  apiKeyId: string;
  resellerAccountId: string;
  secret: string;
  usagePlan: UsagePlan;
  state: string;
  createdAt?: string;
}

/** One audit log entry. */
export interface AuditEntry {
  auditId: string;
  timestamp: string;
  actor: string;
  actorRole: string;
  action: string;
  target: string;
  sourceIp: string;
  changes: Record<string, { before: unknown; after: unknown }>;
}

/** Paginated audit query result. */
export interface AuditQueryResult {
  entries: AuditEntry[];
  nextToken: string | null;
}
