/**
 * `GET /seo/public` — return the current Seo_Settings for every managed page as
 * machine-readable JSON for the static marketing site / other authorized
 * consumers. This is a public, unauthenticated read model (Req 9.5).
 *
 * @module app/api/seo/public/route
 * Requirements: 9.5
 */

import { NextResponse } from "next/server";
import { getServerContext } from "../../../../lib/server-context.ts";
import { createAuditLog } from "../../../../lib/audit.ts";
import { createSeoModule } from "../../../../lib/seo.ts";

export async function GET(): Promise<NextResponse> {
  const ctx = getServerContext();

  const seo = createSeoModule({
    dynamo: ctx.dynamo,
    audit: createAuditLog(ctx.dynamo),
  });
  const pages = await seo.listSeoSettings();

  return NextResponse.json({ pages });
}
