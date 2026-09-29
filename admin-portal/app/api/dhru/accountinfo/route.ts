/**
 * GET /api/dhru/accountinfo - Get Dhru API account information
 * 
 * Proxies the request to Dhru Fusion API to retrieve account balance and status.
 * Requires accountId parameter to fetch stored Dhru credentials.
 * 
 * @module app/api/dhru/accountinfo/route
 */

import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server-context.ts";
import { resolvePrincipal } from "@/lib/principal.ts";
import { authErrorResponse, validationErrorResponse } from "@/lib/http.ts";

export async function GET(req: Request): Promise<NextResponse> {
  const { authenticator, dynamo } = getServerContext();

  // 1. Authenticate the caller
  const resolved = await resolvePrincipal(req, null, authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  // 2. Get accountId from query params
  const url = new URL(req.url);
  const accountId = url.searchParams.get("accountId");

  if (!accountId) {
    return validationErrorResponse("accountId", "Account ID is required");
  }

  // 3. Verify permission - admins can view any account, others only their own
  const isAdmin = principal.role === "super_admin" || principal.role === "admin";
  if (!isAdmin && principal.resellerAccountId !== accountId) {
    return authErrorResponse({
      code: "not_authorized",
      message: "Cannot access other account's Dhru API info",
    });
  }

  try {
    // 4. Fetch Dhru API credentials from reseller account
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

    // 5. Make request to Dhru API
    const dhruResponse = await fetch(`${account.dhruApiUrl}/api/index.php`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        username: account.dhruUsername,
        apiaccesskey: account.dhruApiKey,
        action: "accountinfo",
        requestformat: "JSON",
      }),
    });

    if (!dhruResponse.ok) {
      return NextResponse.json(
        {
          error: "dhru_api_error",
          message: "Failed to connect to Dhru API",
        },
        { status: 502 }
      );
    }

    const dhruData = await dhruResponse.json();

    // 6. Return the account info
    return NextResponse.json({
      success: true,
      accountId,
      dhruAccount: {
        username: account.dhruUsername,
        balance: dhruData.BALANCE || "0",
        credits: dhruData.CREDITS || "0",
        status: dhruData.STATUS || "active",
        accountType: dhruData.ACCOUNT_TYPE,
      },
      raw: dhruData,
    });
  } catch (error) {
    console.error("[dhru-api] Account info error:", error);
    return NextResponse.json(
      {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Failed to fetch account info",
      },
      { status: 500 }
    );
  }
}
