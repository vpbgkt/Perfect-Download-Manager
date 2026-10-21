/**
 * Route Handlers for `/api/licenses`.
 *
 * This file exports a `POST` handler that mints a new license (Req 3) and a
 * `GET` handler that returns a paginated, ownership-scoped list (with optional
 * search) of License_Records (Req 4.1–4.4). Both handlers resolve the caller
 * through {@link resolvePrincipal} (Firebase ID token or Api_Key), enforce
 * permissions, and gate a supplied `keyPrefix` to `admin`/`super_admin` with a
 * 403 (Req 5.7).
 *
 * For non-admin callers (distributor/reseller/dealer), license creation is
 * treated as an ORDER: the license price is deducted from their account
 * balance, the license is minted, and an order record is created.
 *
 * @module app/api/licenses/route
 * Requirements: 1.7, 1.9, 2.5, 2.8, 3.9, 3.11, 4.9, 5.7, 5.14, 7.3, 7.8,
 *               7.10, 7.12, 10.6
 */

import { NextResponse } from "next/server";
import {
  authErrorResponse,
  badRequestResponse,
  validationErrorResponse,
  validationErrorResponseMulti,
} from "../../../lib/http.ts";
import { getServerContext } from "../../../lib/server-context.ts";
import { createAuditLog } from "../../../lib/audit.ts";
import { createLicenseCreator, type CreateLicenseInput } from "../../../lib/licenses/create.ts";
import {
  createLicenseQuery,
  parseLicenseContinuationToken,
  type LicenseListOptions,
  type LicenseQueryScope,
} from "../../../lib/licenses/query.ts";
import { validateIso8601Utc, validateMaxActivations } from "../../../lib/validation.ts";
import { validateKeyPrefix, normalizeKeyPrefix } from "../../../lib/licenses/keygen.ts";
import { evaluateCustomerProfile } from "../../../lib/licenses/customer.ts";
import { resolvePrincipal } from "../../../lib/principal.ts";
import type { Principal } from "../../../lib/auth.ts";
import { calculatePrice, getAccountForPricing } from "../../../lib/pricing.ts";
import { createTransactionManager } from "../../../lib/transactions.ts";
import { createOrderManager, type OrderSource } from "../../../lib/orders.ts";
import { createPlanManager } from "../../../lib/plans.ts";

/** Derive the license-query ownership scope from an authenticated principal. */
function scopeOf(principal: Principal): LicenseQueryScope {
  return { role: principal.role, resellerAccountId: principal.resellerAccountId };
}

/** Best-effort source-IP extraction for the Audit_Entry (Req 13.1). */
function sourceIpOf(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * POST /api/licenses — create a new License_Record (Req 3).
 *
 * For non-admin roles, this acts as an ORDER:
 *  1. Calculate price based on account discount
 *  2. Check & deduct balance
 *  3. Mint the license
 *  4. Record the order
 *
 * For admin/super_admin roles, license creation is free (no balance deduction).
 */
export async function POST(req: Request): Promise<NextResponse> {
  // ── Parse body first so the ID token can also be read from it. ──
  const body = await (async () => {
    try {
      const text = await req.text();
      if (!text) return null;
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  if (!body) {
    return badRequestResponse("Request body must be a JSON object");
  }

  const ctx = getServerContext();

  // 1. Resolve principal (Api_Key header → Reseller_API; else Firebase ID token).
  const resolved = await resolvePrincipal(req, body, ctx.authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  // 2. Require the license:create permission (Req 1.9).
  const permission = ctx.authenticator.requirePermission(principal, "license:create");
  if (!permission.ok) {
    return authErrorResponse(permission.error);
  }

  // 3. Require MFA enrollment before any Mutation (Firebase only, Req 1.5).
  //    Api_Key principals are implicitly mfaEnrolled.
  if (principal.authMethod === "firebase") {
    const mfa = ctx.authenticator.requireMfaEnrolled(principal);
    if (!mfa.ok) {
      return authErrorResponse(mfa.error);
    }
  }

  // 4. Gate keyPrefix to admin/super_admin roles (Req 5.7).
  const rawPrefix = body.keyPrefix;
  if (
    rawPrefix !== undefined &&
    rawPrefix !== null &&
    !(typeof rawPrefix === "string" && rawPrefix.trim() === "")
  ) {
    if (principal.role !== "admin" && principal.role !== "super_admin") {
      return authErrorResponse({ code: "not_authorized", message: "Not authorized" });
    }
  }

  // 5. Validate prefix before any write (Req 5.4, 5.5, 5.12).
  const prefixResult = validateKeyPrefix(rawPrefix);
  if (!prefixResult.ok) {
    return validationErrorResponse("keyPrefix", prefixResult.error);
  }
  const keyPrefix = prefixResult.value; // string | undefined

  // 6. Validate Customer_Profile before any write (Req 4.9).
  const customer = evaluateCustomerProfile(body);
  if (customer.errors.length > 0) {
    if (customer.errors.length === 1) {
      return validationErrorResponse(customer.errors[0].field, customer.errors[0].reason);
    }
    return validationErrorResponseMulti(
      customer.errors.map((e) => ({ field: e.field, reason: e.reason }))
    );
  }

  // 7. Validate standard inputs (Req 3.4, 3.5, 15.4).
  const maxActivations = validateMaxActivations(body.maxActivations);
  if (!maxActivations.ok) {
    return validationErrorResponse("maxActivations", maxActivations.error);
  }

  let expiresAt: string | undefined;
  if (body.expiresAt !== undefined && body.expiresAt !== null && body.expiresAt !== "") {
    const expiry = validateIso8601Utc(body.expiresAt);
    if (!expiry.ok) {
      return validationErrorResponse("expiresAt", expiry.error);
    }
    expiresAt = expiry.value;
  }

  let plan: string | undefined;
  if (body.plan !== undefined && body.plan !== null) {
    if (typeof body.plan !== "string" || body.plan.trim().length === 0) {
      return validationErrorResponse("plan", "plan must be a non-empty string");
    }
    plan = body.plan.trim();
  }

  let owner: string | undefined;
  if (body.owner !== undefined && body.owner !== null) {
    if (typeof body.owner !== "string") {
      return validationErrorResponse("owner", "owner must be a string");
    }
    owner = body.owner;
  }

  let features: string[] | undefined;
  if (body.features !== undefined && body.features !== null) {
    if (!Array.isArray(body.features) || !body.features.every((f) => typeof f === "string")) {
      return validationErrorResponse("features", "features must be an array of strings");
    }
    features = body.features as string[];
  }

  // ── Non-admin records are owned by the caller's account (Req 3.6). ──
  const isAdminRole = principal.role === "admin" || principal.role === "super_admin";

  // ── For non-admin roles: require planId and use plan config ──
  let priceInfo: { basePrice: number; discountPercent: number; discountAmount: number; finalPrice: number; balanceBefore: number; balanceAfter: number } | undefined;
  let transactionId: string | undefined;
  let planDerivedExpiry: string | undefined;
  let planDerivedMaxAct: number | undefined;
  let planDerivedFeatures: string[] | undefined;
  let planDerivedPlanName: string | undefined;

  // Determine order source: API key callers → "api", dashboard callers → "dashboard"
  const orderSource: OrderSource = principal.authMethod === "apikey" ? "api" : "dashboard";

  if (!isAdminRole && principal.resellerAccountId) {
    // Non-admin users MUST select a plan
    const planId = body.planId;
    if (!planId || typeof planId !== "string") {
      return validationErrorResponse("planId", "A product plan must be selected");
    }

    // Look up the plan
    const planManager = createPlanManager({ dynamo: ctx.dynamo });
    const planResult = await planManager.getPlan(planId);
    if (!planResult.ok) {
      return validationErrorResponse("planId", "Selected plan not found");
    }
    const selectedPlan = planResult.value;
    if (selectedPlan.status !== "active") {
      return validationErrorResponse("planId", "Selected plan is no longer available");
    }

    // Derive license attributes from plan
    planDerivedPlanName = selectedPlan.name;
    planDerivedMaxAct = selectedPlan.maxActivations;
    planDerivedFeatures = selectedPlan.features.length > 0 ? selectedPlan.features : undefined;

    // Calculate expiry from plan duration
    const expiry = new Date();
    expiry.setMonth(expiry.getMonth() + selectedPlan.durationMonths);
    planDerivedExpiry = expiry.toISOString();

    // Fetch account for pricing
    const account = await getAccountForPricing(ctx.dynamo, principal.resellerAccountId);
    if (!account) {
      return badRequestResponse("Account not found");
    }
    if (account.state !== "active") {
      return authErrorResponse({ code: "not_authorized", message: "Account is suspended" });
    }

    // Calculate price using the plan's price (not the default base price)
    const pricing = calculatePrice(selectedPlan.price, account.discountPercent);
    priceInfo = {
      basePrice: pricing.basePrice,
      discountPercent: pricing.discountPercent,
      discountAmount: pricing.discountAmount,
      finalPrice: pricing.finalPrice,
      balanceBefore: account.balance,
      balanceAfter: account.balance - pricing.finalPrice,
    };

    // Check sufficient balance
    if (account.balance < pricing.finalPrice) {
      return NextResponse.json(
        {
          error: "insufficient_balance",
          message: `Insufficient balance. Available: ${account.balance}, Required: ${pricing.finalPrice}`,
          balance: account.balance,
          required: pricing.finalPrice,
        },
        { status: 402 }
      );
    }

    // Debit balance
    const txnManager = createTransactionManager({ dynamo: ctx.dynamo });
    const debitResult = await txnManager.debitBalance(
      {
        accountId: principal.resellerAccountId,
        amount: pricing.finalPrice,
        reason: "license_purchase",
        relatedEntity: `plan:${selectedPlan.planId}`,
      },
      { identity: principal.identity, role: principal.role }
    );

    if (!debitResult.ok) {
      if (debitResult.error.code === "insufficient_balance") {
        return NextResponse.json(
          {
            error: "insufficient_balance",
            message: debitResult.error.message,
          },
          { status: 402 }
        );
      }
      return badRequestResponse(debitResult.error.message);
    }

    transactionId = debitResult.value.transactionId;
    // Update balance info from actual transaction
    priceInfo.balanceBefore = debitResult.value.balanceBefore;
    priceInfo.balanceAfter = debitResult.value.balanceAfter;
  }

  // Build the license creation input — plan-derived values take precedence for non-admin
  const input: CreateLicenseInput = {
    plan: isAdminRole ? plan : (planDerivedPlanName ?? plan),
    maxActivations: isAdminRole ? maxActivations.value : (planDerivedMaxAct ?? maxActivations.value),
    owner,
    expiresAt: isAdminRole ? expiresAt : (planDerivedExpiry ?? expiresAt),
    features: isAdminRole ? features : (planDerivedFeatures ?? features),
    resellerAccountId: !isAdminRole ? principal.resellerAccountId : undefined,
    keyPrefix,
    customer: Object.keys(customer.set).length > 0 ? customer.set : undefined,
  };

  // ── Delegate minting/persistence/auditing to the lib module. ──
  const audit = createAuditLog(ctx.dynamo);
  const creator = createLicenseCreator({ dynamo: ctx.dynamo, audit });
  const result = await creator.create(input, {
    actor: principal.identity,
    actorRole: principal.role,
    sourceIp: sourceIpOf(req),
  });

  if (!result.ok) {
    // If license creation fails after balance deduction, refund the balance
    if (!isAdminRole && principal.resellerAccountId && priceInfo) {
      const txnManager = createTransactionManager({ dynamo: ctx.dynamo });
      await txnManager.creditBalance(
        {
          accountId: principal.resellerAccountId,
          amount: priceInfo.finalPrice,
          reason: "refund",
          relatedEntity: `license_creation_failed`,
        },
        { identity: principal.identity, role: principal.role }
      );
    }

    if (result.error.code === "validation_error") {
      return validationErrorResponse(result.error.field ?? "input", result.error.message);
    }
    // Key-generation exhaustion is an internal condition; surface a generic 400.
    return badRequestResponse(result.error.message);
  }

  // ── Record the order for non-admin roles ──
  let orderRecord;
  if (!isAdminRole && principal.resellerAccountId && priceInfo) {
    const orderManager = createOrderManager({ dynamo: ctx.dynamo });
    const orderResult = await orderManager.createOrder({
      accountId: principal.resellerAccountId,
      licenseKey: result.value.licenseKey,
      plan: result.value.plan,
      quantity: 1,
      basePrice: priceInfo.basePrice,
      discountPercent: priceInfo.discountPercent,
      discountAmount: priceInfo.discountAmount,
      finalPrice: priceInfo.finalPrice,
      balanceBefore: priceInfo.balanceBefore,
      balanceAfter: priceInfo.balanceAfter,
      status: "completed",
      source: orderSource,
      transactionId,
    });
    if (orderResult.ok) {
      orderRecord = orderResult.value;
    }
  }

  // Return the complete generated License_Key plus order info if applicable.
  const response: Record<string, unknown> = { ...result.value };
  if (orderRecord) {
    response.order = orderRecord;
  }
  return NextResponse.json(response, { status: 201 });
}

/**
 * GET /api/licenses — paginated, ownership-scoped list/search of License_Records
 * (Req 4.1–4.4). Trial anchors and RL# counter items are excluded; resellers
 * see only their own records; reads require the `license:read` permission (no
 * Mutation, so no MFA-enrollment gate).
 *
 * Query parameters:
 *   - `search` — optional term matched against `licenseKey` / `owner` /
 *     `customerEmail` / `customerName` / `customerCompany` / `customerPhone`
 *   - `limit`  — optional page size (clamped by the query layer)
 *   - `nextToken` — opaque continuation token from a previous page (Req 3.11)
 */
export async function GET(req: Request): Promise<NextResponse> {
  const ctx = getServerContext();

  // 1. Resolve principal (Api_Key header → Reseller_API; else Firebase ID token).
  const resolved = await resolvePrincipal(req, null, ctx.authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  // 2. Require the license:read permission (Req 3.9).
  const permission = ctx.authenticator.requirePermission(principal, "license:read");
  if (!permission.ok) {
    return authErrorResponse(permission.error);
  }

  // ── Parse optional query parameters. ──
  const url = new URL(req.url);
  const options: LicenseListOptions = {};

  const search = url.searchParams.get("search");
  if (search !== null) {
    options.search = search;
  }

  const nextToken = url.searchParams.get("nextToken");
  if (nextToken !== null && nextToken.length > 0) {
    options.continuationToken = nextToken;
  }

  const limit = url.searchParams.get("limit");
  if (limit !== null && limit.length > 0) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return validationErrorResponse("limit", "limit must be a positive integer");
    }
    options.pageSize = parsed;
  }

  // ── Delegate the ownership-scoped, trial-excluding query (Req 4.1, 4.2, 15.5). ──
  // The continuation-token structural guard is injected here (Req 3.11).
  const query = createLicenseQuery({
    dynamo: ctx.dynamo,
    parseToken: parseLicenseContinuationToken,
  });
  const result = await query.list(scopeOf(principal), options);

  // If the query layer reported a validation error (e.g. bad token or term too
  // long), surface it as a 400.
  if (result.error) {
    return validationErrorResponse("search", result.error);
  }

  return NextResponse.json(result, { status: 200 });
}
