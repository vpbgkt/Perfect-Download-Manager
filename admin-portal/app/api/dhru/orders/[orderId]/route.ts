/**
 * GET /api/dhru/orders/{orderId} - Get order details from Dhru API
 * 
 * Fetches the status and details of a previously placed order.
 * Supports both IMEI and File orders.
 * 
 * @module app/api/dhru/orders/[orderId]/route
 */

import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server-context.ts";
import { resolvePrincipal } from "@/lib/principal.ts";
import { authErrorResponse, validationErrorResponse } from "@/lib/http.ts";

export async function GET(
  req: Request,
  context: { params: Promise<{ orderId: string }> }
): Promise<NextResponse> {
  const { orderId } = await context.params;
  const { authenticator, dynamo } = getServerContext();

  // 1. Authenticate the caller
  const resolved = await resolvePrincipal(req, null, authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  // 2. Get parameters
  const url = new URL(req.url);
  const accountId = url.searchParams.get("accountId");
  const orderType = url.searchParams.get("type") || "imei"; // 'imei' or 'file'

  if (!accountId) {
    return validationErrorResponse("accountId", "Account ID is required");
  }

  // 3. Verify permission
  const isAdmin = principal.role === "super_admin" || principal.role === "admin";
  if (!isAdmin && principal.resellerAccountId !== accountId) {
    return authErrorResponse({
      code: "not_authorized",
      message: "Cannot access other account's orders",
    });
  }

  try {
    // 4. Fetch Dhru API credentials
    const accountData = await dynamo.get({
      TableName: "pdm-portal-resellers",
      Key: { resellerAccountId: accountId },
    });

    if (!accountData.item) {
      return NextResponse.json(
        { error: "not_found", message: "Account not found" },
        { status: 404 }
      );
    }

    const account = accountData.item as any;

    if (!account.dhruApiUrl || !account.dhruUsername || !account.dhruApiKey) {
      return NextResponse.json(
        {
          error: "configuration_missing",
          message: "Dhru API is not configured for this account",
        },
        { status: 400 }
      );
    }

    // 5. Fetch order details from Dhru API
    const action = orderType === "imei" ? "imeiorderdetails" : "fileorderdetails";
    
    const dhruResponse = await fetch(`${account.dhruApiUrl}/api/index.php`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        username: account.dhruUsername,
        apiaccesskey: account.dhruApiKey,
        action,
        requestformat: "JSON",
        parameters: JSON.stringify({ ORDERID: orderId }),
      }),
    });

    if (!dhruResponse.ok) {
      return NextResponse.json(
        {
          error: "dhru_api_error",
          message: "Failed to fetch order details from Dhru API",
        },
        { status: 502 }
      );
    }

    const dhruData = await dhruResponse.json();

    // 6. Check if request was successful
    if (dhruData.STATUS === "ERROR" || dhruData.ERROR) {
      return NextResponse.json(
        {
          error: "dhru_order_not_found",
          message: dhruData.MESSAGE || dhruData.ERROR || "Order not found",
          dhruResponse: dhruData,
        },
        { status: 404 }
      );
    }

    // 7. Return order details
    return NextResponse.json({
      success: true,
      orderId,
      orderType,
      accountId,
      order: {
        orderId: dhruData.ORDERID || dhruData.ORDER_ID,
        status: dhruData.STATUS,
        serviceId: dhruData.SERVICEID || dhruData.SERVICE_ID,
        serviceName: dhruData.SERVICENAME || dhruData.SERVICE_NAME,
        imei: dhruData.IMEI,
        fileName: dhruData.FILENAME || dhruData.FILE_NAME,
        cost: dhruData.COST || dhruData.PRICE,
        code: dhruData.CODE,
        comment: dhruData.COMMENT,
        createdAt: dhruData.CREATED || dhruData.DATE,
        completedAt: dhruData.COMPLETED || dhruData.COMPLETED_DATE,
        message: dhruData.MESSAGE,
      },
      dhruResponse: dhruData,
    });
  } catch (error) {
    console.error("[dhru-orders] Error:", error);
    return NextResponse.json(
      {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Failed to fetch order details",
      },
      { status: 500 }
    );
  }
}
