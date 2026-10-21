/**
 * `GET /api/accounts/{id}/balance` — get current balance of an account.
 *
 * Flow:
 *  1. Authenticate the caller via Firebase ID token or password-based session.
 *  2. Require the `balance:view` permission.
 *  3. Optionally enforce ownership: non-admins can only view their own balance.
 *  4. Retrieve balance via TransactionManager.
 *  5. Return current balance.
 *
 * @module app/api/accounts/[id]/balance/route
 */

import { NextResponse } from "next/server";
import { createTransactionManager } from "@/lib/transactions.ts";
import { getServerContext } from "@/lib/server-context.ts";
import { authErrorResponse } from "@/lib/http.ts";
import { resolvePrincipal } from "@/lib/principal.ts";

/** Permission gating balance viewing. */
const REQUIRED_PERMISSION = "balance:view" as const;

/**
 * GET /api/accounts/{id}/balance — retrieve current balance.
 */
export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: accountId } = await context.params;

  const { authenticator, dynamo } = getServerContext();

  // 1. Authenticate the caller (JWT or Firebase)
  const resolved = await resolvePrincipal(req, null, authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  // 2. Require the balance:view permission
  const permitted = authenticator.requirePermission(principal, REQUIRED_PERMISSION);
  if (!permitted.ok) {
    return authErrorResponse(permitted.error);
  }

  // 3. Ownership check: non-admin users can only view their own balance
  const isAdmin = principal.role === "super_admin" || principal.role === "admin";
  if (!isAdmin && principal.resellerAccountId !== accountId) {
    return NextResponse.json(
      { error: "not_authorized", message: "Cannot view balance of other accounts" },
      { status: 403 }
    );
  }

  // 4. Retrieve balance
  const transactionManager = createTransactionManager({ dynamo });
  const result = await transactionManager.getBalance(accountId);

  if (!result.ok) {
    if (result.error.code === "not_found") {
      return NextResponse.json(
        { error: "not_found", message: "Account not found" },
        { status: 404 }
      );
    }
    return NextResponse.json(
      { error: result.error.code, message: result.error.message },
      { status: 400 }
    );
  }

  // 5. Return balance
  return NextResponse.json({
    accountId,
    balance: result.value,
  });
}
