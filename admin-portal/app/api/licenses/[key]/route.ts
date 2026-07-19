/**
 * Route Handlers for `/api/licenses/{key}`.
 *
 * This file exports a `GET` handler that returns a single License_Record the
 * caller is authorized to view, expanded to the full record shape plus its
 * Activation_Entries and activation count (Req 4.5, 4.6, 7.1, 7.6). A non-owned
 * or unknown key is reported as a genuine `not_found` so a reseller can never
 * learn that a License_Record it does not own exists (Req 2.7, 4.6, 15.5).
 *
 * The module is deliberately structured as named handler exports plus imports
 * and a thin scope helper, with all business logic in `lib/licenses/query.ts`
 * — there is no default export. Task 8.3 adds a `PATCH` export (attribute
 * update) to this same file; adding `export async function PATCH(...)` is clean
 * and conflict-free.
 *
 * @module app/api/licenses/[key]/route
 * Requirements: 4.5, 4.6, 7.1, 7.6, 2.7, 15.5
 */

import { NextResponse } from "next/server";
import {
  authErrorResponse,
  extractIdToken,
  readJsonBody,
  validationErrorResponse,
} from "../../../../lib/http.ts";
import { getServerContext } from "../../../../lib/server-context.ts";
import { createLicenseQuery, type LicenseQueryScope } from "../../../../lib/licenses/query.ts";
import { createAuditLog } from "../../../../lib/audit.ts";
import {
  createAttributeUpdater,
  type LicenseAttributeUpdates,
} from "../../../../lib/licenses/attributes.ts";
import type { Principal } from "../../../../lib/auth.ts";

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
 * Collect the submitted, updatable attributes from the request body. Only keys
 * actually present on the body are included, so unsubmitted attributes are left
 * untouched by the updater (Req 6.1). `expiresAt` is passed through verbatim
 * (including `""`/`null`) so the updater can clear it (Req 6.5).
 */
function collectAttributes(body: Record<string, unknown>): LicenseAttributeUpdates {
  const attributes: LicenseAttributeUpdates = {};
  if ("plan" in body) attributes.plan = body.plan;
  if ("maxActivations" in body) attributes.maxActivations = body.maxActivations;
  if ("expiresAt" in body) attributes.expiresAt = body.expiresAt;
  if ("owner" in body) attributes.owner = body.owner;
  if ("features" in body) attributes.features = body.features;
  return attributes;
}

/**
 * GET /api/licenses/{key} — return one viewable License_Record with its
 * Activation_Entries and count (Req 4.5, 7.1, 7.6), or `not_found` for an
 * unknown / trial-anchor / non-owned key (Req 2.7, 4.6).
 */
export async function GET(
  req: Request,
  context: { params: Promise<{ key: string }> }
): Promise<NextResponse> {
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

  // ── Resolve the {key} path segment (Next.js 16 async params). ──
  const { key } = await context.params;
  const licenseKey = decodeURIComponent(key);

  // ── Delegate the ownership-scoped, trial-excluding view (Req 4.5, 2.7, 15.5). ──
  const query = createLicenseQuery({ dynamo: ctx.dynamo });
  const view = await query.view(scopeOf(principal), licenseKey);

  if (!view) {
    // Non-owned / unknown / trial keys all collapse to not-found (Req 2.7, 4.6).
    return authErrorResponse({ code: "not_found", message: "Not found" });
  }

  return NextResponse.json(view, { status: 200 });
}

/**
 * PATCH /api/licenses/{key} — update the mutable attributes of a viewable
 * License_Record (`plan`, `maxActivations`, `expiresAt`, `owner`, `features`).
 *
 * Flow (design "Error Handling" taxonomy):
 *  1. Authenticate the interactive caller via the Firebase ID token (lib/auth).
 *  2. Require the `license:update` Permission (Req 6.1, 2.2) → 403 on failure.
 *  3. Require an enrolled MFA factor before any Mutation (Req 1.5) → 403.
 *  4. Update only the submitted attributes and audit the before/after values
 *     (Req 6.1, 6.5, 6.6); invalid values map to 400 (Req 6.2, 6.3, 6.4) and
 *     ownership / unknown-key map to not-found (Req 2.7) → 404.
 *
 * The response body never leaks which credential/field was wrong; all mapping
 * goes through the shared helpers in `lib/http.ts`.
 */
export async function PATCH(
  req: Request,
  context: { params: Promise<{ key: string }> }
): Promise<NextResponse> {
  const body = await readJsonBody(req);

  const { authenticator, dynamo } = getServerContext();

  // 1. Authenticate the interactive caller (Firebase ID token).
  const idToken = extractIdToken(req, body);
  if (!idToken) {
    return authErrorResponse({ code: "session_expired", message: "Authentication required" });
  }
  const authed = await authenticator.authenticate({ idToken });
  if (!authed.ok) {
    return authErrorResponse(authed.error);
  }
  const principal = authed.value;

  // 2. Require the license:update Permission (Req 2.2, 6.1).
  const permitted = authenticator.requirePermission(principal, "license:update");
  if (!permitted.ok) {
    return authErrorResponse(permitted.error);
  }

  // 3. Require an enrolled MFA factor before any Mutation (Req 1.5).
  const mfa = authenticator.requireMfaEnrolled(principal);
  if (!mfa.ok) {
    return authErrorResponse(mfa.error);
  }

  // Resolve the {key} path segment (Next.js 16 async params).
  const { key } = await context.params;
  const licenseKey = decodeURIComponent(key);

  // 4. Update exactly the submitted attributes on the shared pdm-licenses item
  //    and audit the before/after values (Req 6.1, 6.5, 6.6).
  const updater = createAttributeUpdater({
    dynamo,
    audit: createAuditLog(dynamo),
    // Reuse the Authenticator's ownership scoping (Req 2.7).
    assertOwnership: (p, record) => authenticator.assertOwnership(p, record),
  });

  const result = await updater.update({
    licenseKey,
    attributes: collectAttributes(body ?? {}),
    principal,
    sourceIp: sourceIpOf(req),
  });

  if (!result.ok) {
    // Map the taxonomy: validation → 400, ownership/unknown → 404 (Req 2.7).
    if (result.error.code === "validation_error") {
      return validationErrorResponse(result.error.field ?? "attributes", result.error.message);
    }
    return authErrorResponse({ code: "not_found", message: result.error.message });
  }

  return NextResponse.json(result.value, { status: 200 });
}
