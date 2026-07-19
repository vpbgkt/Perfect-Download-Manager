/**
 * `POST /api/resellers/{id}/apikeys` — issue an Api_Key for a Reseller_Account
 * (Req 11.1, 11.2, 11.5).
 *
 * Flow (design "Error Handling" taxonomy):
 *  1. Authenticate the interactive caller via the Firebase ID token (lib/auth).
 *  2. Require the `apikey:create` Permission — `super_admin` only (Req 11.1)
 *     → 403 on failure.
 *  3. Require an enrolled MFA factor before any Mutation (Req 1.5) → 403.
 *  4. Validate the optional Usage_Plan (rate/burst/quota) → 400.
 *  5. Delegate issuance + auditing to `lib/apikeys.createApiKeyManager`. The
 *     plaintext secret is returned **exactly once** in the response body; only
 *     its SHA-256 hash is stored (Req 11.1, 11.2).
 *
 * @module app/api/resellers/[id]/apikeys/route
 * Requirements: 11.1, 11.2, 11.5, 11.6, 1.5, 15.4, 15.7
 */

import { NextResponse } from "next/server";
import { createApiKeyManager } from "@/lib/apikeys.ts";
import { createAuditLog } from "@/lib/audit.ts";
import { getServerContext } from "@/lib/server-context.ts";
import type { UsagePlan } from "@/lib/ratelimit.ts";
import {
  authErrorResponse,
  extractIdToken,
  readJsonBody,
  validationErrorResponse,
} from "@/lib/http.ts";

/** Permission gating Api_Key issuance — `super_admin` only (Req 11.1). */
const REQUIRED_PERMISSION = "apikey:create" as const;

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
 * Validate an optional Usage_Plan numeric field: when present it must be a
 * finite, non-negative number; absent fields fall back to the portal default
 * downstream (Req 11.5). Returns the parsed value, `undefined` when omitted, or
 * a field-scoped error message.
 */
function parsePlanField(
  value: unknown,
  field: string
): { ok: true; value: number | undefined } | { ok: false; reason: string; field: string } {
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return { ok: false, field, reason: `${field} must be a non-negative number` };
  }
  return { ok: true, value };
}

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: resellerAccountId } = await context.params;
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

  // 2. Require the apikey:create Permission (super_admin only) (Req 11.1).
  const permitted = authenticator.requirePermission(principal, REQUIRED_PERMISSION);
  if (!permitted.ok) {
    return authErrorResponse(permitted.error);
  }

  // 3. Require an enrolled MFA factor before any Mutation (Req 1.5).
  const mfa = authenticator.requireMfaEnrolled(principal);
  if (!mfa.ok) {
    return authErrorResponse(mfa.error);
  }

  // 4. Validate the optional Usage_Plan fields (Req 15.4).
  const rate = parsePlanField(body?.rateLimitPerSec, "rateLimitPerSec");
  if (!rate.ok) return validationErrorResponse(rate.field, rate.reason);
  const burst = parsePlanField(body?.burst, "burst");
  if (!burst.ok) return validationErrorResponse(burst.field, burst.reason);
  const quota = parsePlanField(body?.monthlyQuota, "monthlyQuota");
  if (!quota.ok) return validationErrorResponse(quota.field, quota.reason);

  const plan: Partial<UsagePlan> = {
    rateLimitPerSec: rate.value,
    burst: burst.value,
    monthlyQuota: quota.value,
  };

  // 5. Delegate issuance + auditing to the lib module (returns secret once).
  const manager = createApiKeyManager({ dynamo, audit: createAuditLog(dynamo) });
  const result = await manager.issueApiKey(
    { resellerAccountId, plan },
    { actor: principal.identity, actorRole: principal.role, sourceIp: sourceIpOf(req) }
  );

  if (!result.ok) {
    if (result.error.code === "validation_error") {
      return validationErrorResponse(result.error.field ?? "input", result.error.message);
    }
    return NextResponse.json({ error: "conflict", reason: result.error.message }, { status: 409 });
  }

  // The plaintext secret is returned exactly once, alongside the safe-to-log
  // public identifier and the embedded Usage_Plan (Req 11.1).
  const { record, secret } = result.value;
  return NextResponse.json(
    {
      apiKeyId: record.apiKeyId,
      resellerAccountId: record.resellerAccountId,
      secret,
      usagePlan: {
        rateLimitPerSec: record.rateLimitPerSec,
        burst: record.burst,
        monthlyQuota: record.monthlyQuota,
      },
      state: record.state,
      createdAt: record.createdAt,
    },
    { status: 201 }
  );
}
