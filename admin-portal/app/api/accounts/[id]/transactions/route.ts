/**
 * `GET /api/accounts/{id}/transactions` — retrieve transaction history for an account.
 *
 * Flow:
 *  1. Authenticate the caller via Firebase ID token or password-based session.
 *  2. Require the `balance:view_transactions` permission.
 *  3. Optionally enforce ownership: non-admins can only view their own transactions.
 *  4. Parse pagination parameters (limit, nextToken).
 *  5. Optionally filter by transaction type (credit/debit).
 *  6. Query transactions via TransactionManager.
 *  7. Return paginated transaction list.
 *
 * @module app/api/accounts/[id]/transactions/route
 */

import { NextResponse } from "next/server";
import { createTransactionManager } from "@/lib/transactions.ts";
import { getServerContext } from "@/lib/server-context.ts";
import {
  authErrorResponse,
  extractIdToken,
  validationErrorResponse,
} from "@/lib/http.ts";

/** Permission gating transaction history viewing. */
const REQUIRED_PERMISSION = "balance:view_transactions" as const;

/**
 * GET /api/accounts/{id}/transactions — retrieve transaction history.
 * Supports query parameters:
 *   - limit: page size (default 50, max 100)
 *   - nextToken: pagination token
 *   - type: filter by "credit" or "debit"
 */
export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: accountId } = await context.params;

  const { authenticator, dynamo } = getServerContext();

  // 1. Authenticate the caller
  const idToken = extractIdToken(req, null);
  if (!idToken) {
    return authErrorResponse({ code: "session_expired", message: "Authentication required" });
  }
  const authed = await authenticator.authenticate({ idToken });
  if (!authed.ok) {
    return authErrorResponse(authed.error);
  }
  const principal = authed.value;

  // 2. Require the balance:view_transactions permission
  const permitted = authenticator.requirePermission(principal, REQUIRED_PERMISSION);
  if (!permitted.ok) {
    return authErrorResponse(permitted.error);
  }

  // 3. Ownership check: non-admin users can only view their own transactions
  const isAdmin = principal.role === "super_admin" || principal.role === "admin";
  if (!isAdmin && principal.resellerAccountId !== accountId) {
    return NextResponse.json(
      { error: "not_authorized", message: "Cannot view transactions of other accounts" },
      { status: 403 }
    );
  }

  // 4. Parse query parameters
  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  const nextToken = url.searchParams.get("nextToken") || undefined;
  const typeFilter = url.searchParams.get("type") as "credit" | "debit" | null;

  // Validate limit
  let pageSize = 50; // default
  if (limitRaw) {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      return validationErrorResponse("limit", "limit must be an integer between 1 and 100");
    }
    pageSize = parsed;
  }

  // Validate type filter
  if (typeFilter && typeFilter !== "credit" && typeFilter !== "debit") {
    return validationErrorResponse("type", "type must be 'credit' or 'debit'");
  }

  // 5. Query transactions
  const transactionManager = createTransactionManager({ dynamo });
  const result = await transactionManager.queryTransactions({
    accountId,
    pageSize,
    continuationToken: nextToken,
    type: typeFilter ?? undefined,
  });

  if (!result.ok) {
    if (result.error.code === "validation_error") {
      return validationErrorResponse(
        result.error.field ?? "input",
        result.error.message
      );
    }
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

  // 6. Return paginated results
  const { transactions, nextToken: continuationToken } = result.value;
  return NextResponse.json({
    accountId,
    transactions: transactions.map((t) => ({
      transactionId: t.transactionId,
      accountId: t.accountId,
      type: t.type,
      amount: t.amount,
      balanceBefore: t.balanceBefore,
      balanceAfter: t.balanceAfter,
      reason: t.reason,
      relatedEntity: t.relatedEntity,
      createdBy: t.createdBy,
      createdByRole: t.createdByRole,
      createdAt: t.createdAt,
    })),
    nextToken: continuationToken ?? null,
    hasMore: !!continuationToken,
  });
}
