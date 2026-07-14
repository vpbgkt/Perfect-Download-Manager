/**
 * `GET /audit` — query the append-only Audit_Log.
 *
 * Callers holding the `audit:read` Permission may query Audit_Entries by actor,
 * target, action, or time range (Req 13.4). The query dimension is selected from
 * the query string:
 *
 *  - `?actor=<id>`   → {@link AuditLog.queryByActor}
 *  - `?target=<id>`  → {@link AuditLog.queryByTarget}
 *  - `?action=<id>`  → {@link AuditLog.queryByAction}
 *  - (none of the above) → {@link AuditLog.queryByTimeRange} across the whole log
 *
 * An optional `?start=` / `?end=` ISO 8601 UTC bound narrows any of the above to
 * a time range, and `?pageSize=` + `?token=` drive continuation-token pagination.
 * The dimensions are mutually exclusive; supplying more than one is a 400.
 *
 * Authentication is delegated to `lib/auth` (Firebase ID token → Principal) and
 * every rejection is mapped to the shared error taxonomy in `lib/http`
 * (401/403/400). Query execution is delegated to the `lib/audit` query helpers.
 *
 * @module app/api/audit/route
 * Requirements: 13.4
 */

import { NextResponse } from "next/server";
import { createAuditLog, type AuditQueryOptions, type AuditEntry } from "../../../lib/audit.ts";
import type { PaginatedResult } from "../../../lib/dynamo.ts";
import {
  authErrorResponse,
  badRequestResponse,
  extractIdToken,
  validationErrorResponse,
} from "../../../lib/http.ts";
import { getServerContext } from "../../../lib/server-context.ts";

/** Upper bound on `pageSize` so a caller cannot request an unbounded page. */
const MAX_PAGE_SIZE = 200;

/**
 * Validate and coerce the optional `pageSize` query parameter.
 *
 * Returns the parsed positive integer (capped at {@link MAX_PAGE_SIZE}),
 * `undefined` when the parameter is absent, or `null` when it is malformed.
 */
function parsePageSize(raw: string | null): number | undefined | null {
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return null;
  return Math.min(value, MAX_PAGE_SIZE);
}

export async function GET(req: Request): Promise<NextResponse> {
  const { authenticator, dynamo } = getServerContext();

  // ── Authenticate the interactive caller (Firebase ID token) ──
  const idToken = extractIdToken(req, null);
  if (!idToken) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const authResult = await authenticator.authenticate({ idToken });
  if (!authResult.ok) {
    return authErrorResponse(authResult.error);
  }
  const principal = authResult.value;

  // ── Authorize: require the `audit:read` Permission (Req 13.4) ──
  const permitted = authenticator.requirePermission(principal, "audit:read");
  if (!permitted.ok) {
    return authErrorResponse(permitted.error);
  }

  // ── Parse query-string parameters ──
  const url = new URL(req.url);
  const params = url.searchParams;

  const actor = params.get("actor");
  const target = params.get("target");
  const action = params.get("action");
  const start = params.get("start") ?? undefined;
  const end = params.get("end") ?? undefined;
  const token = params.get("token") ?? undefined;

  // The actor/target/action dimensions are mutually exclusive.
  const dimensions = [actor, target, action].filter((value) => value !== null);
  if (dimensions.length > 1) {
    return badRequestResponse(
      "specify at most one of actor, target, or action"
    );
  }

  const pageSize = parsePageSize(params.get("pageSize"));
  if (pageSize === null) {
    return validationErrorResponse("pageSize", "must be a positive integer");
  }

  const options: AuditQueryOptions = {
    start,
    end,
    pageSize,
    continuationToken: token,
  };

  // ── Delegate to the appropriate audit query helper (Req 13.4) ──
  const auditLog = createAuditLog(dynamo);

  let result: PaginatedResult<AuditEntry>;
  try {
    if (actor !== null) {
      result = await auditLog.queryByActor(actor, options);
    } else if (target !== null) {
      result = await auditLog.queryByTarget(target, options);
    } else if (action !== null) {
      result = await auditLog.queryByAction(action, options);
    } else {
      result = await auditLog.queryByTimeRange({ start, end, pageSize, continuationToken: token });
    }
  } catch {
    // A malformed continuation token (or other query failure) is a bad request
    // rather than a server-internal leak.
    return badRequestResponse("audit query failed");
  }

  return NextResponse.json({
    entries: result.items,
    nextToken: result.nextToken ?? null,
  });
}
