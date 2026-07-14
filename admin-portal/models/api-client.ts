"use client";

/**
 * Typed browser API client — the dashboard's access to the Portal_Backend.
 *
 * Every call carries the current Firebase ID token as `Authorization: Bearer`,
 * which the Route Handlers re-verify server-side. On a 401 the caller should
 * send the user back to /login. This is the concrete "Model" the views/
 * controllers depend on.
 *
 * @module models/api-client
 */

import { getFirebaseAuth } from "../lib/firebase-client.ts";
import type {
  AuditQueryResult,
  CreateLicenseBody,
  IssuedApiKey,
  LicenseListResult,
  LicenseView,
  ReleaseMetadata,
  ReleaseSubmission,
  ResellerAccount,
  SeoSettings,
  SeoUpdateBody,
  SessionSummary,
  UpdateLicenseBody,
  UsagePlan,
} from "./types.ts";

/** A structured API error carrying the HTTP status and any field/reason. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly field?: string;
  constructor(status: number, message: string, code?: string, field?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

/** Fetch the current Firebase ID token, or throw a 401-style ApiError. */
async function idToken(): Promise<string> {
  const auth = getFirebaseAuth();
  // Wait for Firebase to restore the persisted session before reading the user,
  // otherwise a fresh page load races ahead of auth-state hydration.
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user) throw new ApiError(401, "Not signed in", "unauthenticated");
  return user.getIdToken();
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const token = await idToken();
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data.reason as string) || (data.error as string) || `Request failed (${res.status})`,
      data.error as string | undefined,
      data.field as string | undefined
    );
  }
  return data as T;
}

/** The dashboard API surface. */
export const api = {
  // ── session ──
  session(): Promise<SessionSummary> {
    return request<SessionSummary>("GET", "/api/auth/session");
  },

  // ── licenses ──
  listLicenses(opts: { search?: string; limit?: number; nextToken?: string } = {}): Promise<LicenseListResult> {
    const qs = new URLSearchParams();
    if (opts.search) qs.set("search", opts.search);
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.nextToken) qs.set("nextToken", opts.nextToken);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<LicenseListResult>("GET", `/api/licenses${suffix}`);
  },
  getLicense(key: string): Promise<LicenseView> {
    return request<LicenseView>("GET", `/api/licenses/${encodeURIComponent(key)}`);
  },
  createLicense(body: CreateLicenseBody): Promise<LicenseView> {
    return request<LicenseView>("POST", "/api/licenses", body);
  },
  updateLicense(key: string, body: UpdateLicenseBody): Promise<LicenseView> {
    return request<LicenseView>("PATCH", `/api/licenses/${encodeURIComponent(key)}`, body);
  },
  setLicenseStatus(key: string, status: string): Promise<LicenseView> {
    return request<LicenseView>("PATCH", `/api/licenses/${encodeURIComponent(key)}/status`, { status });
  },
  removeActivation(key: string, fp: string): Promise<{ status: string }> {
    return request("DELETE", `/api/licenses/${encodeURIComponent(key)}/activations/${encodeURIComponent(fp)}`);
  },

  // ── release ──
  getRelease(): Promise<{ release: ReleaseMetadata | null }> {
    return request("GET", "/api/release");
  },
  publishRelease(body: ReleaseSubmission): Promise<{ release: ReleaseMetadata; manifest: unknown }> {
    return request("PUT", "/api/release", body);
  },

  // ── seo ──
  listSeo(): Promise<{ pages: SeoSettings[] }> {
    return request("GET", "/api/seo");
  },
  updateSeo(pageId: string, body: SeoUpdateBody): Promise<{ page: SeoSettings }> {
    return request("PUT", `/api/seo/${encodeURIComponent(pageId)}`, body);
  },

  // ── resellers ──
  createReseller(body: { orgName: string; contactEmail: string }): Promise<ResellerAccount> {
    return request("POST", "/api/resellers", body);
  },
  setResellerState(id: string, state: "active" | "suspended"): Promise<ResellerAccount> {
    return request("PATCH", `/api/resellers/${encodeURIComponent(id)}/state`, { state });
  },

  // ── api keys ──
  issueApiKey(resellerId: string, plan: Partial<UsagePlan>): Promise<IssuedApiKey> {
    return request("POST", `/api/resellers/${encodeURIComponent(resellerId)}/apikeys`, plan);
  },
  revokeApiKey(apiKeyId: string): Promise<{ apiKeyId: string; state: string }> {
    return request("DELETE", `/api/apikeys/${encodeURIComponent(apiKeyId)}`);
  },
  changeApiKeyPlan(apiKeyId: string, plan: Partial<UsagePlan>): Promise<{ apiKeyId: string; usagePlan: UsagePlan }> {
    return request("PATCH", `/api/apikeys/${encodeURIComponent(apiKeyId)}/plan`, plan);
  },

  // ── admins ──
  createAdmin(body: { firebaseUid: string; email: string; role: "super_admin" | "admin" }): Promise<unknown> {
    return request("POST", "/api/admins", body);
  },

  // ── audit ──
  queryAudit(opts: { actor?: string; target?: string; action?: string; start?: string; end?: string; pageSize?: number; token?: string } = {}): Promise<AuditQueryResult> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) {
      if (v !== undefined && v !== "") qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<AuditQueryResult>("GET", `/api/audit${suffix}`);
  },
};
