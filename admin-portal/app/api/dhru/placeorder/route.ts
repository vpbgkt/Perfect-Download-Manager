/**
 * POST /api/dhru/placeorder - Place an order through Dhru API
 * 
 * Handles both IMEI and File orders. Deducts the order cost from the distributor's
 * PDM wallet balance before submitting to Dhru API.
 * 
 * Flow:
 * 1. Authenticate caller
 * 2. Fetch Dhru credentials from account
 * 3. Validate order parameters
 * 4. Check PDM wallet balance
 * 5. Submit order to Dhru API
 * 6. Deduct cost from PDM wallet
 * 7. Create transaction record
 * 8. Return order confirmation
 * 
 * @module app/api/dhru/placeorder/route
 */

import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server-context.ts";
import { resolvePrincipal } from "@/lib/principal.ts";
import { createTransactionManager } from "@/lib/transactions.ts";
import { createAuditLog } from "@/lib/audit.ts";
import {
  authErrorResponse,
  readJsonBody,
  validationErrorResponse,
} from "@/lib/http.ts";

/** Best-effort source-IP extraction for audit trail */
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
  const { authenticator, dynamo } = getServerContext();

  // 1. Authenticate the caller
  const resolved = await resolvePrincipal(req, body, authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  // 2. Extract order parameters
  const {
    accountId,
    orderType, // 'imei' or 'file'
    serviceId,
    imei,
    modelId,
    providerId,
    mep,
    pin,
    kbh,
    prd,
    type,
    reference,
    locks,
    fileName,
    fileData,
  } = body || {};

  // 3. Validate required parameters
  if (!accountId || typeof accountId !== "string") {
    return validationErrorResponse("accountId", "Account ID is required");
  }

  if (!orderType || (orderType !== "imei" && orderType !== "file")) {
    return validationErrorResponse("orderType", "Order type must be 'imei' or 'file'");
  }

  if (
    (typeof serviceId !== "string" && typeof serviceId !== "number") ||
    String(serviceId).trim().length === 0
  ) {
    return validationErrorResponse("serviceId", "Service ID is required");
  }

  if (orderType === "imei" && (typeof imei !== "string" || !imei.trim())) {
    return validationErrorResponse("imei", "IMEI is required for IMEI orders");
  }

  if (orderType === "file" && (typeof fileName !== "string" || !fileName.trim())) {
    return validationErrorResponse("fileName", "File name is required for file orders");
  }
  if (fileData !== undefined && typeof fileData !== "string") {
    return validationErrorResponse("fileData", "File data must be a string");
  }

  // 4. Verify permission - admins can place for any account, distributors only for their own
  const isAdmin = principal.role === "super_admin" || principal.role === "admin";
  if (!isAdmin && principal.resellerAccountId !== accountId) {
    return authErrorResponse({
      code: "not_authorized",
      message: "Cannot place orders for other accounts",
    });
  }

  try {
    // 5. Fetch account and Dhru credentials
    const accountData = await dynamo.get({
      TableName: "pdm-portal-resellers",
      Key: { resellerAccountId: accountId },
    });

    if (!accountData) {
      return NextResponse.json(
        { error: "not_found", message: "Account not found" },
        { status: 404 }
      );
    }

    const account = accountData;

    // 6. Check account state
    if (account.state !== "active") {
      return NextResponse.json(
        { error: "account_suspended", message: "Account is not active" },
        { status: 403 }
      );
    }

    // 7. Verify Dhru API is configured
    if (
      typeof account.dhruApiUrl !== "string" ||
      typeof account.dhruUsername !== "string" ||
      typeof account.dhruApiKey !== "string"
    ) {
      return NextResponse.json(
        {
          error: "configuration_missing",
          message: "Dhru API is not configured for this account",
        },
        { status: 400 }
      );
    }

    // 8. Require the cost from a trusted service catalog; never guess a charge.
    const estimatedCost = body?.estimatedCost;
    if (
      typeof estimatedCost !== "number" ||
      !Number.isFinite(estimatedCost) ||
      estimatedCost <= 0
    ) {
      return validationErrorResponse("estimatedCost", "estimatedCost must be a positive number");
    }

    // 9. Check PDM wallet balance
    const transactionManager = createTransactionManager({ dynamo });
    const balanceResult = await transactionManager.getBalance(accountId);

    if (!balanceResult.ok) {
      return NextResponse.json(
        { error: "balance_check_failed", message: "Could not verify account balance" },
        { status: 500 }
      );
    }

    const currentBalance = balanceResult.value;

    if (currentBalance < estimatedCost) {
      return NextResponse.json(
        {
          error: "insufficient_balance",
          message: `Insufficient balance. Required: ${estimatedCost} credits, Available: ${currentBalance} credits`,
          details: {
            required: estimatedCost,
            available: currentBalance,
            shortfall: estimatedCost - currentBalance,
          },
        },
        { status: 402 }
      );
    }

    // 10. Prepare Dhru API request parameters
    const dhruParams: Record<string, string> = {
      ID: String(serviceId),
    };

    if (orderType === "imei") {
      if (typeof imei !== "string") {
        return validationErrorResponse("imei", "IMEI is required for IMEI orders");
      }
      dhruParams.IMEI = imei;
      const optionalFields: Array<[string, unknown]> = [
        ["MODELID", modelId],
        ["PROVIDERID", providerId],
        ["MEP", mep],
        ["PIN", pin],
        ["KBH", kbh],
        ["PRD", prd],
        ["TYPE", type],
        ["REFERENCE", reference],
        ["LOCKS", locks],
      ];
      for (const [field, value] of optionalFields) {
        if (value !== undefined) {
          if (typeof value !== "string") {
            return validationErrorResponse(field.toLowerCase(), `${field} must be a string`);
          }
          dhruParams[field] = value;
        }
      }
    } else if (orderType === "file") {
      if (typeof fileName !== "string") {
        return validationErrorResponse("fileName", "File name is required for file orders");
      }
      dhruParams.FILENAME = fileName;
      if (fileData) dhruParams.FILE = fileData;
    }

    // 11. Submit order to Dhru API
    const dhruAction = orderType === "imei" ? "placeimeiorder" : "placefileorder";
    
    const formData = new URLSearchParams({
      username: account.dhruUsername,
      apiaccesskey: account.dhruApiKey,
      action: dhruAction,
      requestformat: "JSON",
      parameters: JSON.stringify(dhruParams),
    });

    const dhruResponse = await fetch(`${account.dhruApiUrl}/api/index.php`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: formData,
    });

    if (!dhruResponse.ok) {
      return NextResponse.json(
        {
          error: "dhru_api_error",
          message: "Failed to submit order to Dhru API",
        },
        { status: 502 }
      );
    }

    const dhruData = await dhruResponse.json();

    // 12. Check if Dhru API request was successful
    if (dhruData.STATUS === "ERROR" || dhruData.ERROR) {
      return NextResponse.json(
        {
          error: "dhru_order_failed",
          message: dhruData.MESSAGE || dhruData.ERROR || "Order failed at Dhru API",
          dhruResponse: dhruData,
        },
        { status: 400 }
      );
    }

    const dhruOrderId = dhruData.ORDERID || dhruData.ORDER_ID;

    // 13. Deduct cost from PDM wallet
    const debitResult = await transactionManager.debitBalance(
      {
        accountId,
        amount: estimatedCost,
        reason: "dhru_order",
        relatedEntity: `dhru:${orderType}:${dhruOrderId || serviceId}`,
      },
      {
        identity: principal.identity,
        role: principal.role,
      }
    );

    if (!debitResult.ok) {
      // Order was placed but debit failed - log critical error
      console.error(
        "[dhru-placeorder] CRITICAL: Order placed but balance deduction failed",
        {
          accountId,
          dhruOrderId,
          cost: estimatedCost,
          error: debitResult.error,
        }
      );

      // Still return success but with warning
      return NextResponse.json({
        success: true,
        warning: "Order placed but balance deduction failed. Please contact support.",
        order: {
          dhruOrderId,
          orderType,
          serviceId,
          cost: estimatedCost,
          status: dhruData.STATUS || "pending",
        },
        dhruResponse: dhruData,
      });
    }

    // 14. Create audit log entry
    await createAuditLog(dynamo).writeAuditEntry({
      action: "dhru.order.placed",
      actor: principal.identity,
      actorRole: principal.role,
      target: accountId,
      sourceIp: sourceIpOf(req),
      changes: {
        dhruOrderId: { before: null, after: dhruOrderId },
        orderType: { before: null, after: orderType },
        serviceId: { before: null, after: String(serviceId) },
        cost: { before: null, after: estimatedCost },
        transactionId: {
          before: null,
          after: debitResult.value.transactionId,
        },
      },
    });

    // 15. Return success response
    return NextResponse.json({
      success: true,
      order: {
        dhruOrderId,
        orderType,
        serviceId,
        imei: orderType === "imei" ? imei : undefined,
        fileName: orderType === "file" ? fileName : undefined,
        cost: estimatedCost,
        status: dhruData.STATUS || "pending",
        createdAt: new Date().toISOString(),
      },
      transaction: {
        transactionId: debitResult.value.transactionId,
        previousBalance: currentBalance,
        newBalance: debitResult.value.balanceAfter,
        amount: estimatedCost,
      },
      dhruResponse: dhruData,
    });
  } catch (error) {
    console.error("[dhru-placeorder] Error:", error);
    return NextResponse.json(
      {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Failed to place order",
      },
      { status: 500 }
    );
  }
}
