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
  /** Normalized Custom_Key_Prefix, present only when the key was minted with one. */
  keyPrefix?: string;
  /** Customer_Fields — additive, omitted when absent from the stored item. */
  customerEmail?: string;
  customerName?: string;
  customerPhone?: string;
  customerCountry?: string;
  customerCompany?: string;
  customerNotes?: string;
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
  /** Custom_Key_Prefix — admin/super_admin only; null/omitted mints an unprefixed key. */
  keyPrefix?: string | null;
  /** Customer_Fields — all optional; null or "" stores no attribute. */
  customerEmail?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerCountry?: string | null;
  customerCompany?: string | null;
  customerNotes?: string | null;
}

/** Attributes accepted when updating a license. */
export interface UpdateLicenseBody {
  plan?: string;
  maxActivations?: number;
  expiresAt?: string | null;
  owner?: string;
  features?: string[];
  /** Customer_Fields — all optional; null or "" clears the corresponding attribute. */
  customerEmail?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerCountry?: string | null;
  customerCompany?: string | null;
  customerNotes?: string | null;
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
  accountType: "distributor" | "reseller" | "dealer";
  orgName: string;
  contactEmail: string;
  state: "active" | "suspended";
  
  // Balance & pricing
  balance: number;
  discountPercent: number;
  
  // Hierarchy
  parentAccountId?: string;
  
  // Timestamps
  createdAt?: string;
  lastLoginAt?: string;
}

/** Paginated reseller list response. */
export interface ResellerListResult {
  items: ResellerAccount[];
  nextToken: string | null;
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

/** Balance transaction record. */
export interface BalanceTransaction {
  transactionId: string;
  accountId: string;
  type: "credit" | "debit";
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  reason: string;
  relatedEntity?: string;
  createdBy: string;
  createdByRole: string;
  createdAt: string;
}

/** Paginated transaction query result. */
export interface TransactionQueryResult {
  transactions: BalanceTransaction[];
  nextToken: string | null;
}

/** Order source type. */
export type OrderSource = "dashboard" | "api";

/** Order status type. */
export type OrderStatus = "completed" | "failed" | "refunded";

/** Order record from the order history. */
export interface OrderRecord {
  orderId: string;
  accountId: string;
  licenseKey: string;
  plan: string;
  quantity: number;
  basePrice: number;
  discountPercent: number;
  discountAmount: number;
  finalPrice: number;
  balanceBefore: number;
  balanceAfter: number;
  status: OrderStatus;
  source: OrderSource;
  transactionId?: string;
  createdAt: string;
}

/** Paginated order list result. */
export interface OrderListResult {
  items: OrderRecord[];
  nextToken?: string;
}

/** Admin-configured product plan for license purchases. */
export interface ProductPlan {
  planId: string;
  name: string;
  durationMonths: number;
  price: number;
  maxActivations: number;
  features: string[];
  status: "active" | "inactive";
  sortOrder: number;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

/** Attributes accepted when creating a product plan. */
export interface CreatePlanBody {
  name: string;
  durationMonths: number;
  price: number;
  maxActivations?: number;
  features?: string[];
  sortOrder?: number;
  description?: string;
}

/** Attributes accepted when updating a product plan. */
export interface UpdatePlanBody {
  name?: string;
  durationMonths?: number;
  price?: number;
  maxActivations?: number;
  features?: string[];
  status?: "active" | "inactive";
  sortOrder?: number;
  description?: string;
}
