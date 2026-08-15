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
 * Flow:
 *  1. Parse body
 *  2. Resolve principal (Api_Key or Firebase)
 *  3. Require `license:create` permission → 403
 *  4. Require MFA enrollment (Firebase only) → 403
 *  5. Gate keyPrefix to admin/super_admin → 403
 *  6. Validate prefix and Customer_Profile before any write → 400
 *  7. Validate other inputs → 400
 *  8. Delegate creation
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

  // ── Reseller-created records are owned by the caller's account (Req 3.6). ──
  const input: CreateLicenseInput = {
    plan,
    maxActivations: maxActivations.value,
    owner,
    expiresAt,
    features,
    resellerAccountId: principal.role === "reseller" ? principal.resellerAccountId : undefined,
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
    if (result.error.code === "validation_error") {
      return validationErrorResponse(result.error.field ?? "input", result.error.message);
    }
    // Key-generation exhaustion is an internal condition; surface a generic 400.
    return badRequestResponse(result.error.message);
  }

  // Return the complete generated License_Key plus keyPrefix and present
  // Customer_Fields (Req 5.14, 10.6).
  return NextResponse.json(result.value, { status: 201 });
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
