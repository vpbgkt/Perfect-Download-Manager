/**
 * `POST /api/admins` — create a new Admin_User (Req 2.6).
 *
 * Flow (design "Error Handling" taxonomy):
 *  1. Authenticate the interactive caller via the Firebase ID token (lib/auth).
 *  2. Require the `admin:manage` Permission — held only by `super_admin`
 *     (Req 2.5, 2.6) → 403 on failure.
 *  3. Require an enrolled MFA factor before any Mutation (Req 1.5) → 403.
 *  4. Validate the submitted attributes → 400.
 *  5. Delegate creation + auditing to `lib/apikeys.createApiKeyManager` and
 *     map a duplicate UID to a conflict (Req 2.6).
 *
 * @module app/api/admins/route
 * Requirements: 2.5, 2.6, 1.5, 15.4, 15.7
 */

import { NextResponse } from "next/server";
import { createApiKeyManager } from "@/lib/apikeys.ts";
import { createAuditLog } from "@/lib/audit.ts";
import { getServerContext } from "@/lib/server-context.ts";
import {
  authErrorResponse,
  badRequestResponse,
  extractIdToken,
  readJsonBody,
  validationErrorResponse,
} from "@/lib/http.ts";

/** Permission gating Admin_User management — `super_admin` only (Req 2.6). */
const REQUIRED_PERMISSION = "admin:manage" as const;

/** Best-effort source-IP extraction for the Audit_Entry (Req 13.1). */
function sourceIpOf(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(req: Request): Promise<NextResponse> {
  const body = await readJsonBody(req);
  if (!body) {
    return badRequestResponse("Request body must be a JSON object");
  }

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

  // 2. Require the admin:manage Permission (super_admin only) (Req 2.6).
  const permitted = authenticator.requirePermission(principal, REQUIRED_PERMISSION);
  if (!permitted.ok) {
    return authErrorResponse(permitted.error);
  }

  // 3. Require an enrolled MFA factor before any Mutation (Req 1.5).
  const mfa = authenticator.requireMfaEnrolled(principal);
  if (!mfa.ok) {
    return authErrorResponse(mfa.error);
  }

  // 4. Validate the submitted attributes (Req 15.4).
  if (typeof body.firebaseUid !== "string" || body.firebaseUid.trim().length === 0) {
    return validationErrorResponse("firebaseUid", "firebaseUid must be a non-empty string");
  }
  if (typeof body.email !== "string" || body.email.trim().length === 0) {
    return validationErrorResponse("email", "email must be a non-empty string");
  }
  if (body.role !== "super_admin" && body.role !== "admin") {
    return validationErrorResponse("role", "role must be 'super_admin' or 'admin'");
  }

  // 5. Delegate creation + auditing to the lib module.
  const manager = createApiKeyManager({ dynamo, audit: createAuditLog(dynamo) });
  const result = await manager.createAdmin(
    { firebaseUid: body.firebaseUid, email: body.email, role: body.role },
    { actor: principal.identity, actorRole: principal.role, sourceIp: sourceIpOf(req) }
  );

  if (!result.ok) {
    if (result.error.code === "validation_error") {
      return validationErrorResponse(result.error.field ?? "input", result.error.message);
    }
    // Duplicate firebaseUid → conflict.
    return NextResponse.json({ error: "conflict", reason: result.error.message }, { status: 409 });
  }

  return NextResponse.json(result.value, { status: 201 });
}
