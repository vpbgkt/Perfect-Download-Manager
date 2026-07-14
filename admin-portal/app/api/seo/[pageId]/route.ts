/**
 * `PUT /seo/{pageId}` — validate and persist a single page's Seo_Settings
 * (page title, meta description, and Open Graph tags), then append an
 * Audit_Entry. Requires an authenticated principal that holds the `seo:update`
 * Permission AND has enrolled the email-OTP second factor (Req 9.2–9.4, 9.6,
 * 1.5).
 *
 * @module app/api/seo/[pageId]/route
 * Requirements: 9.2, 9.3, 9.4, 9.6
 */

import { NextResponse } from "next/server";
import { getServerContext } from "../../../../lib/server-context.ts";
import { createAuditLog } from "../../../../lib/audit.ts";
import { createSeoModule, type SeoUpdateInput } from "../../../../lib/seo.ts";
import {
  authErrorResponse,
  extractIdToken,
  readJsonBody,
  validationErrorResponse,
} from "../../../../lib/http.ts";

/** Best-effort client IP extraction from the standard proxy headers. */
function sourceIpOf(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

export async function PUT(
  req: Request,
  context: { params: Promise<{ pageId: string }> }
): Promise<NextResponse> {
  const ctx = getServerContext();
  const { pageId } = await context.params;

  const body = await readJsonBody(req);

  const idToken = extractIdToken(req, body);
  if (!idToken) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const auth = await ctx.authenticator.authenticate({ idToken });
  if (!auth.ok) {
    return authErrorResponse(auth.error);
  }
  const principal = auth.value;

  const permission = ctx.authenticator.requirePermission(principal, "seo:update");
  if (!permission.ok) {
    return authErrorResponse(permission.error);
  }

  // Mutations require an enrolled OTP second factor (Req 1.5).
  const mfa = ctx.authenticator.requireMfaEnrolled(principal);
  if (!mfa.ok) {
    return authErrorResponse(mfa.error);
  }

  if (!body) {
    return validationErrorResponse("body", "Request body must be a JSON object");
  }

  const input: SeoUpdateInput = {
    title: body.title,
    metaDescription: body.metaDescription,
    ogTitle: body.ogTitle,
    ogDescription: body.ogDescription,
    ogImage: body.ogImage,
  };

  const seo = createSeoModule({
    dynamo: ctx.dynamo,
    audit: createAuditLog(ctx.dynamo),
  });

  const result = await seo.updateSeoSettings(pageId, input, {
    actor: principal.identity,
    actorRole: principal.role,
    sourceIp: sourceIpOf(req),
  });

  if (!result.ok) {
    return validationErrorResponse(result.error.field, result.error.reason);
  }

  return NextResponse.json({ page: result.value });
}
