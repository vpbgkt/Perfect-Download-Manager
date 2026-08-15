/**
 * Route Handlers for `/api/licenses/{key}`.
 *
 * This file exports a `GET` handler that returns a single License_Record the
 * caller is authorized to view, and a `PATCH` handler that updates the mutable
 * attributes of a viewable License_Record.
 *
 * Both handlers resolve the caller through {@link resolvePrincipal} (Firebase ID
 * token or Api_Key) and enforce the appropriate permission. Unknown keys,
 * `TRIAL#` anchors, `RL#` counter items, and non-owned targets all collapse to
 * a single 404 body (Req 2.6, 7.3, 7.8, 7.10).
 *
 * @module app/api/licenses/[key]/route
 * Requirements: 1.7, 1.9, 2.5, 2.6, 2.8, 3.9, 4.9, 5.7, 5.14, 7.3, 7.8,
 *               7.10, 7.12, 10.6
 */

import { NextResponse } from "next/server";
import {
  authErrorResponse,
  readJsonBody,
  validationErrorResponse,
  validationErrorResponseMulti,
} from "../../../../lib/http.ts";
import { getServerContext } from "../../../../lib/server-context.ts";
import { createLicenseQuery, type LicenseQueryScope } from "../../../../lib/licenses/query.ts";
import { createAuditLog } from "../../../../lib/audit.ts";
import {
  createAttributeUpdater,
  type LicenseAttributeUpdates,
} from "../../../../lib/licenses/attributes.ts";
import { resolvePrincipal } from "../../../../lib/principal.ts";
import type { Principal } from "../../../../lib/auth.ts";

/** The single, unified not-found body (Req 7.3, 7.8, 7.10). */
const NOT_FOUND_ERROR = Object.freeze({ code: "not_found" as const, message: "Not found" });

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
 *
 * Also collects the six Customer_Field keys when present, forwarding them to
 * the updater for normalization/validation (Req 2.1, 4.9).
 */
function collectAttributes(body: Record<string, unknown>): LicenseAttributeUpdates {
  const attributes: LicenseAttributeUpdates = {};
  if ("plan" in body) attributes.plan = body.plan;
  if ("maxActivations" in body) attributes.maxActivations = body.maxActivations;
  if ("expiresAt" in body) attributes.expiresAt = body.expiresAt;
  if ("owner" in body) attributes.owner = body.owner;
  if ("features" in body) attributes.features = body.features;
  // Forward Customer_Fields to the updater for normalization/validation (Req 2.1, 4.9).
  if ("customerEmail" in body) attributes.customerEmail = body.customerEmail;
  if ("customerName" in body) attributes.customerName = body.customerName;
  if ("customerPhone" in body) attributes.customerPhone = body.customerPhone;
  if ("customerCountry" in body) attributes.customerCountry = body.customerCountry;
  if ("customerCompany" in body) attributes.customerCompany = body.customerCompany;
  if ("customerNotes" in body) attributes.customerNotes = body.customerNotes;
  return attributes;
}

/**
 * GET /api/licenses/{key} — return one viewable License_Record with its
 * Activation_Entries and count (Req 4.5, 7.1, 7.6). Unknown, `TRIAL#`, `RL#`,
 * and non-owned keys all collapse into one 404 body (Req 2.6, 7.3, 7.8, 7.10).
 */
export async function GET(
  req: Request,
  context: { params: Promise<{ key: string }> }
): Promise<NextResponse> {
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

  // 3. Resolve the {key} path segment (Next.js 16 async params).
  const { key } = await context.params;
  const licenseKey = decodeURIComponent(key);

  // 4. Delegate the ownership-scoped, trial-excluding view.
  //    Unknown, TRIAL#, RL#, and non-owned targets all collapse to one 404 body.
  const query = createLicenseQuery({ dynamo: ctx.dynamo });
  const view = await query.view(scopeOf(principal), licenseKey);

  if (!view) {
    return authErrorResponse(NOT_FOUND_ERROR);
  }

  return NextResponse.json(view, { status: 200 });
}

/**
 * PATCH /api/licenses/{key} — update the mutable attributes of a viewable
 * License_Record (`plan`, `maxActivations`, `expiresAt`, `owner`, `features`,
 * plus the six Customer_Fields).
 *
 * Flow:
 *  1. Parse body
 *  2. Resolve principal (Api_Key or Firebase)
 *  3. Require `license:update` permission → 403
 *  4. Require MFA enrollment (Firebase only) → 403
 *  5. Validate Customer_Fields (names all offenders at once) → 400
 *  6. Update attributes; unknown/TRIAL#/RL#/non-owned → unified 404
 */
export async function PATCH(
  req: Request,
  context: { params: Promise<{ key: string }> }
): Promise<NextResponse> {
  const body = await readJsonBody(req);

  const ctx = getServerContext();

  // 1. Resolve principal (Api_Key header → Reseller_API; else Firebase ID token).
  const resolved = await resolvePrincipal(req, body, ctx.authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  // 2. Require the license:update Permission (Req 2.5, 2.8).
  const permitted = ctx.authenticator.requirePermission(principal, "license:update");
  if (!permitted.ok) {
    return authErrorResponse(permitted.error);
  }

  // 3. Require MFA enrollment before any Mutation (Firebase only, Req 1.5).
  if (principal.authMethod === "firebase") {
    const mfa = ctx.authenticator.requireMfaEnrolled(principal);
    if (!mfa.ok) {
      return authErrorResponse(mfa.error);
    }
  }

  // Resolve the {key} path segment (Next.js 16 async params).
  const { key } = await context.params;
  const licenseKey = decodeURIComponent(key);

  // 4. Update exactly the submitted attributes on the shared pdm-licenses item
  //    and audit the before/after values.
  const updater = createAttributeUpdater({
    dynamo: ctx.dynamo,
    audit: createAuditLog(ctx.dynamo),
    assertOwnership: (p, record) => ctx.authenticator.assertOwnership(p, record),
  });

  const result = await updater.update({
    licenseKey,
    attributes: collectAttributes(body ?? {}),
    principal,
    sourceIp: sourceIpOf(req),
  });

  if (!result.ok) {
    // Map the taxonomy: validation → 400, ownership/unknown/TRIAL#/RL# → 404.
    if (result.error.code === "validation_error") {
      // When the updater names multiple offending fields (Req 4.9), surface
      // them all via the multi-field response.
      if (result.error.fields && result.error.fields.length > 1) {
        return validationErrorResponseMulti(
          result.error.fields.map((f) => ({
            field: f,
            // Extract per-field reasons from the semicolon-joined message or
            // fall back to the combined message.
            reason: result.error.message,
          }))
        );
      }
      return validationErrorResponse(result.error.field ?? "attributes", result.error.message);
    }
    // Unknown, TRIAL#, RL#, and non-owned targets all collapse into one 404 (Req 7.3, 7.8, 7.10).
    return authErrorResponse(NOT_FOUND_ERROR);
  }

  return NextResponse.json(result.value, { status: 200 });
}
