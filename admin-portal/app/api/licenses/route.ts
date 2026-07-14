/**
 * Route Handlers for `/api/licenses`.
 *
 * This file exports a `POST` handler that mints a new license (Req 3) and a
 * `GET` handler that returns a paginated, ownership-scoped list (with optional
 * search) of License_Records (Req 4.1–4.4). The module is deliberately
 * structured as a set of named handler exports plus imports and thin helpers,
 * with all business logic living in the `lib/` modules, so there is no default
 * export to collide with.
 *
 * Both handlers are intentionally thin: they authenticate the caller, enforce
 * the required permission (and MFA-enrollment for the `POST` Mutation), then
 * delegate the real work to `lib/licenses/create.ts` and `lib/licenses/query.ts`.
 *
 * @module app/api/licenses/route
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.1, 4.2, 4.3, 4.4,
 *               2.2, 2.3, 2.4, 1.5, 15.4, 15.5, 15.7
 */

import { NextResponse } from "next/server";
import {
  authErrorResponse,
  badRequestResponse,
  extractIdToken,
  readJsonBody,
  validationErrorResponse,
} from "../../../lib/http.ts";
import { getServerContext } from "../../../lib/server-context.ts";
import { createAuditLog } from "../../../lib/audit.ts";
import { createLicenseCreator, type CreateLicenseInput } from "../../../lib/licenses/create.ts";
import {
  createLicenseQuery,
  type LicenseListOptions,
  type LicenseQueryScope,
} from "../../../lib/licenses/query.ts";
import { validateIso8601Utc, validateMaxActivations } from "../../../lib/validation.ts";
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
 */
export async function POST(req: Request): Promise<NextResponse> {
  // ── Parse body first so the ID token can also be read from it. ──
  const body = await readJsonBody(req);
  if (!body) {
    return badRequestResponse("Request body must be a JSON object");
  }

  const idToken = extractIdToken(req, body);
  if (!idToken) {
    return authErrorResponse({ code: "session_expired", message: "Missing credentials" });
  }

  const ctx = getServerContext();

  // ── Authenticate (verify Firebase ID token + session gates) (Req 1.x, 2.1). ──
  const auth = await ctx.authenticator.authenticate({ idToken });
  if (!auth.ok) {
    return authErrorResponse(auth.error);
  }
  const principal = auth.value;

  // ── Authorize: require the license:create permission (Req 2.2, 2.3). ──
  const permission = ctx.authenticator.requirePermission(principal, "license:create");
  if (!permission.ok) {
    return authErrorResponse(permission.error);
  }

  // ── Require MFA enrollment before any Mutation (Req 1.5). ──
  const mfa = ctx.authenticator.requireMfaEnrolled(principal);
  if (!mfa.ok) {
    return authErrorResponse(mfa.error);
  }

  // ── Validate inputs (Req 3.4, 3.5, 15.4). ──
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

  return NextResponse.json(result.value, { status: 201 });
}

/**
 * GET /api/licenses — paginated, ownership-scoped list/search of License_Records
 * (Req 4.1–4.4). Trial anchors are excluded and resellers see only their own
 * records; reads require the `license:read` permission (no Mutation, so no
 * MFA-enrollment gate).
 *
 * Query parameters:
 *   - `search` — optional term matched against `licenseKey` / `owner` (Req 4.4)
 *   - `limit`  — optional page size (clamped by the query layer)
 *   - `nextToken` — opaque continuation token from a previous page (Req 4.3)
 */
export async function GET(req: Request): Promise<NextResponse> {
  const idToken = extractIdToken(req, null);
  if (!idToken) {
    return authErrorResponse({ code: "session_expired", message: "Missing credentials" });
  }

  const ctx = getServerContext();

  // ── Authenticate (verify Firebase ID token + session gates) (Req 1.x, 2.1). ──
  const auth = await ctx.authenticator.authenticate({ idToken });
  if (!auth.ok) {
    return authErrorResponse(auth.error);
  }
  const principal = auth.value;

  // ── Authorize: require the license:read permission (Req 2.2, 2.3). ──
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
  const query = createLicenseQuery({ dynamo: ctx.dynamo });
  const result = await query.list(scopeOf(principal), options);

  return NextResponse.json(result, { status: 200 });
}
