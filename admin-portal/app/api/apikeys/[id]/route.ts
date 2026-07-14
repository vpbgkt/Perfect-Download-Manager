/**
 * `DELETE /api/apikeys/{id}` — revoke an Api_Key (Req 11.3).
 *
 * Flow (design "Error Handling" taxonomy):
 *  1. Authenticate the interactive caller via the Firebase ID token (lib/auth).
 *  2. Require the `apikey:revoke` Permission — `super_admin` only (Req 11.3)
 *     → 403 on failure.
 *  3. Require an enrolled MFA factor before any Mutation (Req 1.5) → 403.
 *  4. Delegate revocation + auditing to `lib/apikeys.createApiKeyManager`;
 *     an unknown key maps to not-found (Req 11.3).
 *
 * @module app/api/apikeys/[id]/route
 * Requirements: 11.3, 11.6, 1.5, 15.7
 */

import { NextResponse } from "next/server";
import { createApiKeyManager } from "@/lib/apikeys.ts";
import { createAuditLog } from "@/lib/audit.ts";
import { getServerContext } from "@/lib/server-context.ts";
import {
  authErrorResponse,
  extractIdToken,
  readJsonBody,
} from "@/lib/http.ts";

/** Permission gating Api_Key revocation — `super_admin` only (Req 11.3). */
const REQUIRED_PERMISSION = "apikey:revoke" as const;

/** Best-effort source-IP extraction for the Audit_Entry (Req 13.1). */
function sourceIpOf(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: apiKeyId } = await context.params;
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

  // 2. Require the apikey:revoke Permission (super_admin only) (Req 11.3).
  const permitted = authenticator.requirePermission(principal, REQUIRED_PERMISSION);
  if (!permitted.ok) {
    return authErrorResponse(permitted.error);
  }

  // 3. Require an enrolled MFA factor before any Mutation (Req 1.5).
  const mfa = authenticator.requireMfaEnrolled(principal);
  if (!mfa.ok) {
    return authErrorResponse(mfa.error);
  }

  // 4. Delegate revocation + auditing to the lib module.
  const manager = createApiKeyManager({ dynamo, audit: createAuditLog(dynamo) });
  const result = await manager.revokeApiKey(
    { apiKeyId },
    { actor: principal.identity, actorRole: principal.role, sourceIp: sourceIpOf(req) }
  );

  if (!result.ok) {
    // Unknown key is reported as genuinely missing (Req 11.3).
    return authErrorResponse({ code: "not_found", message: result.error.message });
  }

  return NextResponse.json({ apiKeyId: result.value.apiKeyId, state: result.value.state }, { status: 200 });
}
