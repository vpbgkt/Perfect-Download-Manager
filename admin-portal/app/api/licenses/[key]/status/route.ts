/**
 * `PATCH /api/licenses/{key}/status` — change a License_Record's status.
 *
 * Flow (design "Error Handling" taxonomy):
 *  1. Authenticate the interactive caller via the Firebase ID token (lib/auth).
 *  2. Require the `license:update` Permission (Req 5.1, 2.2) → 403 on failure.
 *  3. Require an enrolled MFA factor before any Mutation (Req 1.5) → 403.
 *  4. Validate the requested status against the enum (Req 5.2) → 400.
 *  5. Apply the change on the same `pdm-licenses` item and audit it (Req 5.3–5.5).
 *  6. Map ownership / unknown-key to not-found (Req 2.7) → 404.
 *
 * The response body never leaks which credential/field was wrong; all mapping
 * goes through the shared helpers in `lib/http.ts`.
 *
 * @module app/api/licenses/[key]/status/route
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import { NextResponse } from "next/server";
import { createAuditLog } from "@/lib/audit.ts";
import { createStatusUpdater } from "@/lib/licenses/status.ts";
import { getServerContext } from "@/lib/server-context.ts";
import { validateStatus } from "@/lib/validation.ts";
import {
  authErrorResponse,
  extractIdToken,
  readJsonBody,
  validationErrorResponse,
} from "@/lib/http.ts";

/** Permission gating a status change (design RBAC matrix, Req 5.1). */
const REQUIRED_PERMISSION = "license:update" as const;

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
  context: { params: Promise<{ key: string }> }
): Promise<NextResponse> {
  const { key } = await context.params;
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

  // 2. Require the license:update Permission (Req 2.2, 5.1).
  const permitted = authenticator.requirePermission(principal, REQUIRED_PERMISSION);
  if (!permitted.ok) {
    return authErrorResponse(permitted.error);
  }

  // 3. Require an enrolled MFA factor before any Mutation (Req 1.5).
  const mfa = authenticator.requireMfaEnrolled(principal);
  if (!mfa.ok) {
    return authErrorResponse(mfa.error);
  }

  // 4. Validate the requested status up-front so a bad value maps to 400 (Req 5.2).
  const requested = validateStatus(body?.status);
  if (!requested.ok) {
    return validationErrorResponse("status", requested.error);
  }

  // 5. Apply the change on the shared pdm-licenses item and audit it (Req 5.3–5.5).
  const updater = createStatusUpdater({
    dynamo,
    audit: createAuditLog(dynamo),
    // Reuse the Authenticator's ownership scoping (Req 2.7).
    assertOwnership: (p, record) => authenticator.assertOwnership(p, record),
  });

  const result = await updater.update({
    licenseKey: key,
    status: requested.value,
    principal,
    sourceIp: sourceIpOf(req),
  });

  if (!result.ok) {
    // 6. Map the taxonomy: validation → 400, ownership/unknown → 404 (Req 2.7).
    if (result.error.code === "validation_error") {
      return validationErrorResponse(result.error.field ?? "status", result.error.message);
    }
    return authErrorResponse({ code: "not_found", message: result.error.message });
  }

  return NextResponse.json(result.value, { status: 200 });
}
