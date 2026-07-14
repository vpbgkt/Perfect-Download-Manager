/**
 * DELETE /api/licenses/{key}/activations/{fp}
 *
 * Remove a single per-machine Activation_Entry from a License_Record so a
 * customer can move their license to a new computer (Req 7.3–7.5).
 *
 * The handler verifies the Firebase ID token, requires the `license:update`
 * permission and an enrolled MFA factor, then delegates to the activation
 * manager which deletes exactly the targeted fingerprint from the record's
 * `activations` map, reports not-found for an absent fingerprint or a record
 * the caller may not view (leaving the map unchanged), and writes a removal
 * Audit_Entry. All rejections flow through the shared error taxonomy so nothing
 * internal leaks (401/403/404).
 *
 * Requirements: 7.2, 7.3, 7.4, 7.5, 1.5, 2.3, 2.7
 */

import { NextResponse } from "next/server";
import { getServerContext } from "../../../../../../lib/server-context.ts";
import {
  authErrorResponse,
  extractIdToken,
  readJsonBody,
  upstreamErrorResponse,
} from "../../../../../../lib/http.ts";
import { AUTHENTICATION_FAILED } from "../../../../../../lib/auth.ts";
import { createAuditLog } from "../../../../../../lib/audit.ts";
import { createActivationManager } from "../../../../../../lib/licenses/activations.ts";

/** Best-effort source-IP extraction for the Audit_Entry (Req 13.1). */
function sourceIpOf(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() ?? "unknown";
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ key: string; fp: string }> }
): Promise<NextResponse> {
  const body = await readJsonBody(req);
  const idToken = extractIdToken(req, body);

  // No credential presented — uniform failure (Req 1.3, 15.7).
  if (!idToken) {
    return authErrorResponse(AUTHENTICATION_FAILED);
  }

  const { authenticator, dynamo } = getServerContext();

  // Verify the Firebase ID token and resolve the principal (Req 1.2).
  const authOutcome = await authenticator.authenticate({ idToken });
  if (!authOutcome.ok) {
    return authErrorResponse(authOutcome.error);
  }
  const principal = authOutcome.value;

  // Gate on the required permission (Req 2.3) and MFA enrollment (Req 1.5).
  const permission = authenticator.requirePermission(principal, "license:update");
  if (!permission.ok) {
    return authErrorResponse(permission.error);
  }
  const mfa = authenticator.requireMfaEnrolled(principal);
  if (!mfa.ok) {
    return authErrorResponse(mfa.error);
  }

  const { key, fp } = await ctx.params;

  try {
    const manager = createActivationManager({
      dynamo,
      audit: createAuditLog(dynamo),
      authorizer: authenticator,
    });

    const outcome = await manager.removeActivation({
      principal,
      licenseKey: key,
      fingerprint: fp,
      sourceIp: sourceIpOf(req),
    });

    if (!outcome.ok) {
      // Absent fingerprint / non-owned / unknown key → not-found (Req 7.2, 7.4).
      return authErrorResponse(outcome.error);
    }
  } catch {
    return upstreamErrorResponse();
  }

  return NextResponse.json({ status: "removed" }, { status: 200 });
}
