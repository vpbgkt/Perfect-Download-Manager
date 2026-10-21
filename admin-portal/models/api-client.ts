"use client";

/**
 * Typed browser API client — the dashboard's access to the Portal_Backend.
 *
 * Every call carries the current JWT token as `Authorization: Bearer`,
 * which the Route Handlers verify server-side. On a 401 the caller should
 * send the user back to /login. This is the concrete "Model" the views/
 * controllers depend on.
 *
 * @module models/api-client
 */

import type {
  AuditQueryResult,
  BalanceTransaction,
  CreateLicenseBody,
  CreatePlanBody,
  IssuedApiKey,
  LicenseListResult,
  LicenseView,
  OrderListResult,
  OrderRecord,
  ProductPlan,
  ReleaseMetadata,
  ReleaseSubmission,
  ResellerAccount,
  ResellerListResult,
  SeoSettings,
  SeoUpdateBody,
  SessionSummary,
  TransactionQueryResult,
  UpdateLicenseBody,
  UpdatePlanBody,
  UsagePlan,
} from "./types.ts";

/** One named validation failure in a multi-field 400 body. */
export interface ApiErrorField {
  field: string;
  reason: string;
}

/** A structured API error carrying the HTTP status and any field/reason. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly field?: string;
  /** All offending fields from a multi-field validation_error, when present. */
  readonly fields?: ApiErrorField[];
  constructor(
    status: number,
    message: string,
    code?: string,
    field?: string,
    fields?: ApiErrorField[]
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.field = field;
    this.fields = fields;
  }
}

/** Fetch the current JWT token from sessionStorage. */
async function getAuthToken(): Promise<string | null> {
  if (typeof window !== "undefined") {
    const storedAccount = sessionStorage.getItem("pdm_account");
    if (storedAccount) {
      try {
        const account = JSON.parse(storedAccount);
        if (account.token) {
          console.log("[api-client] Token found, accountId:", account.accountId, "role:", account.role);
          return account.token;
        }
      } catch {
        // Invalid stored data, clear it
        console.log("[api-client] Invalid session data, clearing");
        sessionStorage.removeItem("pdm_account");
      }
    }
    console.log("[api-client] No session found in sessionStorage");
  }
  throw new ApiError(401, "Not signed in", "unauthenticated");
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const token = await getAuthToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  
  // Only add Authorization header if we have a token (Firebase auth)
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};

  if (!res.ok) {
    throw new ApiError(
      res.status,
      (data.reason as string) || (data.error as string) || `Request failed (${res.status})`,
      data.error as string | undefined,
      data.field as string | undefined,
      Array.isArray(data.fields) ? (data.fields as ApiErrorField[]) : undefined
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

  // ── password-based login (distributor/reseller/dealer) ──
  loginPassword(email: string, password: string): Promise<{
    success: boolean;
    account: {
      accountId: string;
      resellerAccountId: string | null;
      role: string;
      authMethod: string;
    };
  }> {
    // This endpoint doesn't require idToken since it IS the login
    return fetch("/api/auth/login-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    }).then(async (res) => {
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) {
        throw new ApiError(
          res.status,
          data.message || "Login failed",
          data.error,
          data.field
        );
      }
      return data;
    });
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
  listResellers(opts: { limit?: number; nextToken?: string } = {}): Promise<ResellerListResult> {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.nextToken) qs.set("nextToken", opts.nextToken);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<ResellerListResult>("GET", `/api/resellers${suffix}`);
  },
  createReseller(body: {
    orgName: string;
    contactEmail: string;
    accountType?: "distributor" | "reseller" | "dealer";
    password?: string;
    initialBalance?: number;
    discountPercent?: number;
    parentAccountId?: string;
  }): Promise<ResellerAccount> {
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
  /** List API keys for a specific reseller account.
   * TODO: Implement backend endpoint GET /api/resellers/{id}/apikeys
   * For now, returns empty array as placeholder.
   */
  async listApiKeys(_resellerId: string): Promise<IssuedApiKey[]> {
    // Placeholder implementation - will be replaced with actual API call
    // return request("GET", `/api/resellers/${encodeURIComponent(resellerId)}/apikeys`);
    return Promise.resolve([]);
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

  // ── balance & transactions ──
  getBalance(accountId: string): Promise<{ accountId: string; balance: number }> {
    return request("GET", `/api/accounts/${encodeURIComponent(accountId)}/balance`);
  },
  creditBalance(
    accountId: string,
    body: { amount: number; reason?: string; relatedEntity?: string }
  ): Promise<{
    transaction: BalanceTransaction;
    newBalance: number;
  }> {
    return request("POST", `/api/accounts/${encodeURIComponent(accountId)}/balance/credit`, body);
  },
  getTransactions(
    accountId: string,
    opts: { limit?: number; nextToken?: string; type?: "credit" | "debit" } = {}
  ): Promise<TransactionQueryResult & { accountId: string; hasMore: boolean }> {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.nextToken) qs.set("nextToken", opts.nextToken);
    if (opts.type) qs.set("type", opts.type);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request("GET", `/api/accounts/${encodeURIComponent(accountId)}/transactions${suffix}`);
  },

  // ── orders ──
  listOrders(opts: { limit?: number; nextToken?: string; accountId?: string } = {}): Promise<OrderListResult> {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.nextToken) qs.set("nextToken", opts.nextToken);
    if (opts.accountId) qs.set("accountId", opts.accountId);
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return request<OrderListResult>("GET", `/api/orders${suffix}`);
  },

  // ── license pricing preview ──
  getLicensePrice(accountId: string, planId?: string): Promise<{
    basePrice: number;
    discountPercent: number;
    discountAmount: number;
    finalPrice: number;
    balance: number;
    sufficient: boolean;
  }> {
    const qs = planId ? `?planId=${encodeURIComponent(planId)}` : "";
    return request("GET", `/api/accounts/${encodeURIComponent(accountId)}/license-price${qs}`);
  },

  // ── product plans ──
  listPlans(opts: { all?: boolean } = {}): Promise<{ plans: ProductPlan[] }> {
    const qs = opts.all ? "?all=true" : "";
    return request("GET", `/api/plans${qs}`);
  },
  createPlan(body: CreatePlanBody): Promise<ProductPlan> {
    return request("POST", "/api/plans", body);
  },
  updatePlan(planId: string, body: UpdatePlanBody): Promise<ProductPlan> {
    return request("PUT", `/api/plans/${encodeURIComponent(planId)}`, body);
  },
  deletePlan(planId: string): Promise<ProductPlan> {
    return request("DELETE", `/api/plans/${encodeURIComponent(planId)}`);
  },
};
