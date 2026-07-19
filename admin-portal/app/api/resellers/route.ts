/**
 * `POST /api/resellers` — create a Reseller_Account (super_admin only).
 *
 * Flow (design "Error Handling" taxonomy):
 *  1. Authenticate the interactive caller via the Firebase ID token (lib/auth).
 *  2. Require the `reseller:manage` Permission — held only by `super_admin`
 *     (Req 2.6, design RBAC matrix) → 403 on failure.
 *  3. Require an enrolled MFA factor before any Mutation (Req 1.5) → 403.
 *  4. Validate + create: a missing orgName / contactEmail maps to 400 and
 *     writes nothing (Req 10.4); a valid request persists a new active account
 *     and audits it (Req 10.1, 10.5).
 *
 * The response body never leaks which credential/field was wrong; all mapping
 * goes through the shared helpers in `lib/http.ts`.
 *
 * @module app/api/resellers/route
 * Requirements: 10.1, 10.4, 10.5, 2.6
 */

import { NextResponse } from "next/server";
import { createAccountManager } from "@/lib/accounts.ts";
import { createAuditLog } from "@/lib/audit.ts";
import { getServerContext } from "@/lib/server-context.ts";
import {
  authErrorResponse,
  extractIdToken,
  readJsonBody,
  validationErrorResponse,
} from "@/lib/http.ts";

/** Permission gating reseller-account management (super_admin only, Req 2.6). */
const REQUIRED_PERMISSION = "reseller:manage" as const;

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
 * GET /api/resellers — list all Reseller_Accounts (super_admin only).
 * Supports pagination via `?limit=` and `?nextToken=`.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const { authenticator, dynamo } = getServerContext();

  const idToken = extractIdToken(req, null);
  if (!idToken) {
    return authErrorResponse({ code: "session_expired", message: "Authentication required" });
  }
  const authed = await authenticator.authenticate({ idToken });
  if (!authed.ok) {
    return authErrorResponse(authed.error);
  }
  const permitted = authenticator.requirePermission(authed.value, REQUIRED_PERMISSION);
  if (!permitted.ok) {
    return authErrorResponse(permitted.error);
  }

  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  const nextToken = url.searchParams.get("nextToken") || undefined;
  const pageSize = limitRaw ? Number(limitRaw) : undefined;
  if (pageSize !== undefined && (!Number.isInteger(pageSize) || pageSize < 1)) {
    return validationErrorResponse("limit", "limit must be a positive integer");
  }

  const manager = createAccountManager({ dynamo, audit: createAuditLog(dynamo) });
  const result = await manager.listResellers({ pageSize, continuationToken: nextToken });

  return NextResponse.json({ items: result.items, nextToken: result.nextToken ?? null });
}

export async function POST(req: Request): Promise<NextResponse> {
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

  // 2. Require the reseller:manage Permission (super_admin only, Req 2.6).
  const permitted = authenticator.requirePermission(principal, REQUIRED_PERMISSION);
  if (!permitted.ok) {
    return authErrorResponse(permitted.error);
  }

  // 3. Require an enrolled MFA factor before any Mutation (Req 1.5).
  const mfa = authenticator.requireMfaEnrolled(principal);
  if (!mfa.ok) {
    return authErrorResponse(mfa.error);
  }

  // 4. Validate + create (Req 10.1, 10.4, 10.5).
  const manager = createAccountManager({
    dynamo,
    audit: createAuditLog(dynamo),
  });

  const result = await manager.createReseller(
    { orgName: body?.orgName, contactEmail: body?.contactEmail },
    { actor: principal.identity, actorRole: principal.role, sourceIp: sourceIpOf(req) }
  );

  if (!result.ok) {
    // Missing orgName / contactEmail → 400 with nothing written (Req 10.4).
    return validationErrorResponse(result.error.field ?? "reseller", result.error.message);
  }

  return NextResponse.json(result.value, { status: 201 });
}
