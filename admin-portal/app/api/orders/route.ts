/**
 * Route Handlers for `/api/orders`.
 *
 * GET — returns a paginated, ownership-scoped list of order records.
 * Admins see all orders; distributors/resellers/dealers see only their own.
 *
 * @module app/api/orders/route
 */

import { NextResponse } from "next/server";
import {
  authErrorResponse,
  validationErrorResponse,
} from "../../../lib/http.ts";
import { getServerContext } from "../../../lib/server-context.ts";
import { resolvePrincipal } from "../../../lib/principal.ts";
import { createOrderManager, type OrderQueryScope } from "../../../lib/orders.ts";
import type { Principal } from "../../../lib/auth.ts";

/** Derive the order-query ownership scope from an authenticated principal. */
function scopeOf(principal: Principal): OrderQueryScope {
  return { role: principal.role, resellerAccountId: principal.resellerAccountId };
}

/**
 * GET /api/orders — paginated, ownership-scoped list of orders.
 *
 * Query parameters:
 *   - `limit`     — optional page size (default 50, max 100)
 *   - `nextToken` — opaque continuation token from a previous page
 *   - `accountId` — optional account filter (admin only; non-admin always
 *                    scoped to own account)
 */
export async function GET(req: Request): Promise<NextResponse> {
  const ctx = getServerContext();

  // 1. Resolve principal
  const resolved = await resolvePrincipal(req, null, ctx.authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  // 2. Require the order:read permission
  const permission = ctx.authenticator.requirePermission(principal, "order:read");
  if (!permission.ok) {
    return authErrorResponse(permission.error);
  }

  // ── Parse optional query parameters ──
  const url = new URL(req.url);

  const limitRaw = url.searchParams.get("limit");
  let pageSize: number | undefined;
  if (limitRaw !== null && limitRaw.length > 0) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return validationErrorResponse("limit", "limit must be a positive integer");
    }
    pageSize = parsed;
  }

  const nextToken = url.searchParams.get("nextToken") || undefined;
  const accountId = url.searchParams.get("accountId") || undefined;

  // 3. Delegate the ownership-scoped query
  const orderManager = createOrderManager({ dynamo: ctx.dynamo });
  const result = await orderManager.listOrders(scopeOf(principal), {
    accountId,
    pageSize,
    continuationToken: nextToken,
  });

  if (!result.ok) {
    if (result.error.code === "not_found") {
      return NextResponse.json({ error: "not_found", message: result.error.message }, { status: 404 });
    }
    return validationErrorResponse(result.error.field ?? "input", result.error.message);
  }

  return NextResponse.json(result.value, { status: 200 });
}
