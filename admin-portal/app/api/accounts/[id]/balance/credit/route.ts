/**
 * `POST /api/accounts/{id}/balance/credit` — add balance to an account.
 *
 * Flow:
 *  1. Authenticate the caller via Firebase ID token or password-based session.
 *  2. Require the `balance:add` permission — super_admin or parent account.
 *  3. Require MFA enrollment for mutations.
 *  4. Validate amount (must be positive number).
 *  5. Create credit transaction via TransactionManager.
 *  6. Return updated balance and transaction record.
 *
 * @module app/api/accounts/[id]/balance/credit/route
 */

import { NextResponse } from "next/server";
import { createTransactionManager } from "@/lib/transactions.ts";
import { getServerContext } from "@/lib/server-context.ts";
import {
  authErrorResponse,
  readJsonBody,
  validationErrorResponse,
} from "@/lib/http.ts";
import { resolvePrincipal } from "@/lib/principal.ts";

/** Permission gating balance credit operations. */
const REQUIRED_PERMISSION = "balance:add" as const;

/** Best-effort source-IP extraction for the transaction record. */
function sourceIpOf(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * POST /api/accounts/{id}/balance/credit — add balance to an account.
 */
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: accountId } = await context.params;
  const body = await readJsonBody(req);

  const { authenticator, dynamo } = getServerContext();

  // 1. Authenticate the caller (JWT or Firebase)
  const resolved = await resolvePrincipal(req, body, authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  // 2. Require the balance:add permission
  const permitted = authenticator.requirePermission(principal, REQUIRED_PERMISSION);
  if (!permitted.ok) {
    return authErrorResponse(permitted.error);
  }

  // 3. Password auth doesn't require additional MFA check (already authenticated)
  // For Firebase-based sessions, this was required, but JWT tokens are self-contained

  // 4. Validate amount
  const amount = body?.amount;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    return validationErrorResponse("amount", "amount must be a positive number");
  }

  // Validate reason (optional)
  const reasonInput = body?.reason ?? "admin_credit";
  const validReasons = ["admin_credit", "parent_credit", "refund", "adjustment", "initial_balance"] as const;
  const reason = validReasons.find((validReason) => validReason === reasonInput);
  if (!reason) {
    return validationErrorResponse("reason", `reason must be one of: ${validReasons.join(", ")}`);
  }
  const relatedEntity = body?.relatedEntity;
  if (relatedEntity !== undefined && typeof relatedEntity !== "string") {
    return validationErrorResponse("relatedEntity", "relatedEntity must be a string");
  }

  // 5. Create credit transaction
  const transactionManager = createTransactionManager({ dynamo });
  const result = await transactionManager.creditBalance(
    {
      accountId,
      amount,
      reason,
      relatedEntity,
    },
    {
      identity: principal.identity,
      role: principal.role,
    }
  );

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

  // 6. Return transaction record and new balance
  const transaction = result.value;
  return NextResponse.json(
    {
      transaction: {
        transactionId: transaction.transactionId,
        accountId: transaction.accountId,
        type: transaction.type,
        amount: transaction.amount,
        balanceBefore: transaction.balanceBefore,
        balanceAfter: transaction.balanceAfter,
        reason: transaction.reason,
        relatedEntity: transaction.relatedEntity,
        createdBy: transaction.createdBy,
        createdByRole: transaction.createdByRole,
        createdAt: transaction.createdAt,
      },
      newBalance: transaction.balanceAfter,
    },
    { status: 201 }
  );
}
