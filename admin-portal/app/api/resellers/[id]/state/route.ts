/**
 * `PATCH /api/resellers/{id}/state` — suspend or reactivate a Reseller_Account.
 *
 * Flow (design "Error Handling" taxonomy):
 *  1. Authenticate the interactive caller via the Firebase ID token (lib/auth).
 *  2. Require the `reseller:manage` Permission — held only by `super_admin`
 *     (Req 2.6, design RBAC matrix) → 403 on failure.
 *  3. Require an enrolled MFA factor before any Mutation (Req 1.5) → 403.
 *  4. Validate the requested `state` (`active` | `suspended`) → 400.
 *  5. Toggle the account state and audit it (Req 10.2, 10.3, 10.5); an unknown
 *     account maps to not-found → 404.
 *
 * A body of `{ "state": "suspended" }` suspends the account (Req 10.2);
 * `{ "state": "active" }` reactivates it (Req 10.3).
 *
 * @module app/api/resellers/[id]/state/route
 * Requirements: 10.2, 10.3, 10.5, 2.6
 */

import { NextResponse } from "next/server";
import {
  createAccountManager,
  RESELLER_ACTIVE,
  RESELLER_SUSPENDED,
} from "@/lib/accounts.ts";
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

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await context.params;
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

  // 4. Validate the requested state up-front so a bad value maps to 400.
  const requestedState = body?.state;
  if (requestedState !== RESELLER_ACTIVE && requestedState !== RESELLER_SUSPENDED) {
    return validationErrorResponse(
      "state",
      `state must be one of: ${RESELLER_ACTIVE}, ${RESELLER_SUSPENDED}`
    );
  }

  // 5. Toggle the account state and audit it (Req 10.2, 10.3, 10.5).
  const manager = createAccountManager({
    dynamo,
    audit: createAuditLog(dynamo),
  });

  const actor = {
    actor: principal.identity,
    actorRole: principal.role,
    sourceIp: sourceIpOf(req),
  };

  const result =
    requestedState === RESELLER_SUSPENDED
      ? await manager.suspend({ resellerAccountId: id }, actor)
      : await manager.reactivate({ resellerAccountId: id }, actor);

  if (!result.ok) {
    if (result.error.code === "validation_error") {
      return validationErrorResponse(result.error.field ?? "state", result.error.message);
    }
    // Unknown account → not-found (Req 2.7 taxonomy) → 404.
    return authErrorResponse({ code: "not_found", message: result.error.message });
  }

  return NextResponse.json(result.value, { status: 200 });
}
