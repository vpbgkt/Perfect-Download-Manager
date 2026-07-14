/**
 * `GET /seo` — return the current Seo_Settings for every managed marketing-site
 * page. Requires an authenticated principal holding the `seo:read` Permission
 * (Req 9.1).
 *
 * @module app/api/seo/route
 * Requirements: 9.1
 */

import { NextResponse } from "next/server";
import { getServerContext } from "../../../lib/server-context.ts";
import { createAuditLog } from "../../../lib/audit.ts";
import { createSeoModule } from "../../../lib/seo.ts";
import { authErrorResponse, extractIdToken } from "../../../lib/http.ts";

export async function GET(req: Request): Promise<NextResponse> {
  const ctx = getServerContext();

  const idToken = extractIdToken(req, null);
  if (!idToken) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const auth = await ctx.authenticator.authenticate({ idToken });
  if (!auth.ok) {
    return authErrorResponse(auth.error);
  }

  const permission = ctx.authenticator.requirePermission(auth.value, "seo:read");
  if (!permission.ok) {
    return authErrorResponse(permission.error);
  }

  const seo = createSeoModule({
    dynamo: ctx.dynamo,
    audit: createAuditLog(ctx.dynamo),
  });
  const pages = await seo.listSeoSettings();

  return NextResponse.json({ pages });
}
