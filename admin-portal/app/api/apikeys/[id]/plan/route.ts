/**
 * `PATCH /api/apikeys/{id}/plan` — assign/change an Api_Key's Usage_Plan
 * (Req 11.4, 11.5).
 *
 * Flow (design "Error Handling" taxonomy):
 *  1. Authenticate the interactive caller via the Firebase ID token (lib/auth).
 *  2. Require the `apikey:update` Permission — `super_admin` only (Req 11.4)
 *     → 403 on failure.
 *  3. Require an enrolled MFA factor before any Mutation (Req 1.5) → 403.
 *  4. Validate the submitted Usage_Plan (rate/burst/quota); absent fields fall
 *     back to the portal default downstream (Req 11.5) → 400.
 *  5. Delegate the plan change + auditing to `lib/apikeys.createApiKeyManager`;
 *     an unknown key maps to not-found.
 *
 * @module app/api/apikeys/[id]/plan/route
 * Requirements: 11.4, 11.5, 11.6, 1.5, 15.4, 15.7
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

/** Permission gating Usage_Plan changes — `super_admin` only (Req 11.4). */
const REQUIRED_PERMISSION = "apikey:update" as const;

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
 * downstream (Req 11.5).
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

export async function PATCH(
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

  // 2. Require the apikey:update Permission (super_admin only) (Req 11.4).
  const permitted = authenticator.requirePermission(principal, REQUIRED_PERMISSION);
  if (!permitted.ok) {
    return authErrorResponse(permitted.error);
  }

  // 3. Require an enrolled MFA factor before any Mutation (Req 1.5).
  const mfa = authenticator.requireMfaEnrolled(principal);
  if (!mfa.ok) {
    return authErrorResponse(mfa.error);
  }

  // 4. Validate the submitted Usage_Plan fields (Req 15.4).
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

  // 5. Delegate the plan change + auditing to the lib module.
  const manager = createApiKeyManager({ dynamo, audit: createAuditLog(dynamo) });
  const result = await manager.changeUsagePlan(
    { apiKeyId, plan },
    { actor: principal.identity, actorRole: principal.role, sourceIp: sourceIpOf(req) }
  );

  if (!result.ok) {
    if (result.error.code === "validation_error") {
      return validationErrorResponse(result.error.field ?? "input", result.error.message);
    }
    return authErrorResponse({ code: "not_found", message: result.error.message });
  }

  const record = result.value;
  return NextResponse.json(
    {
      apiKeyId: record.apiKeyId,
      resellerAccountId: record.resellerAccountId,
      usagePlan: {
        rateLimitPerSec: record.rateLimitPerSec,
        burst: record.burst,
        monthlyQuota: record.monthlyQuota,
      },
      state: record.state,
    },
    { status: 200 }
  );
}
