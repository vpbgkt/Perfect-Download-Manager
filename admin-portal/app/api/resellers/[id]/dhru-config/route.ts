/**
 * POST /api/resellers/{id}/dhru-config - Save Dhru API configuration
 * 
 * Stores Dhru Fusion API credentials for a reseller account.
 * 
 * @module app/api/resellers/[id]/dhru-config/route
 */

import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server-context.ts";
import { resolvePrincipal } from "@/lib/principal.ts";
import {
  authErrorResponse,
  readJsonBody,
  validationErrorResponse,
} from "@/lib/http.ts";

export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: accountId } = await context.params;
  const body = await readJsonBody(req);

  const { authenticator, dynamo } = getServerContext();

  // 1. Authenticate the caller
  const resolved = await resolvePrincipal(req, body, authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  // 2. Require permission - only super_admin can configure Dhru API
  const permitted = authenticator.requirePermission(principal, "reseller:manage");
  if (!permitted.ok) {
    return authErrorResponse(permitted.error);
  }

  // 3. Validate input
  const { dhruApiUrl, dhruUsername, dhruApiKey } = body || {};

  if (!dhruApiUrl || typeof dhruApiUrl !== "string") {
    return validationErrorResponse("dhruApiUrl", "Dhru API URL is required");
  }

  if (!dhruUsername || typeof dhruUsername !== "string") {
    return validationErrorResponse("dhruUsername", "Dhru username is required");
  }

  if (!dhruApiKey || typeof dhruApiKey !== "string") {
    return validationErrorResponse("dhruApiKey", "Dhru API key is required");
  }

  try {
    // 4. Update reseller account with Dhru credentials
    const result = await dynamo.update({
      TableName: "pdm-portal-resellers",
      Key: { resellerAccountId: accountId },
      UpdateExpression:
        "SET dhruApiUrl = :url, dhruUsername = :username, dhruApiKey = :apiKey, dhruConfiguredAt = :now",
      ExpressionAttributeValues: {
        ":url": dhruApiUrl.trim(),
        ":username": dhruUsername.trim(),
        ":apiKey": dhruApiKey.trim(),
        ":now": new Date().toISOString(),
      },
      ReturnValues: "ALL_NEW",
    });

    if (!result) {
      return NextResponse.json(
        { error: "not_found", message: "Account not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Dhru API configuration saved successfully",
      accountId,
    });
  } catch (error) {
    console.error("[dhru-config] Save error:", error);
    return NextResponse.json(
      {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Failed to save configuration",
      },
      { status: 500 }
    );
  }
}

/**
 * GET /api/resellers/{id}/dhru-config - Get Dhru API configuration
 */
export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: accountId } = await context.params;

  const { authenticator, dynamo } = getServerContext();

  // 1. Authenticate the caller
  const resolved = await resolvePrincipal(req, null, authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  // 2. Verify permission
  const isAdmin = principal.role === "super_admin" || principal.role === "admin";
  if (!isAdmin && principal.resellerAccountId !== accountId) {
    return authErrorResponse({
      code: "not_authorized",
      message: "Cannot access other account's configuration",
    });
  }

  try {
    // 3. Fetch account data
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

    return NextResponse.json({
      success: true,
      accountId,
      config: {
        dhruApiUrl: account.dhruApiUrl || null,
        dhruUsername: account.dhruUsername || null,
        configured: !!(account.dhruApiUrl && account.dhruUsername && account.dhruApiKey),
        configuredAt: account.dhruConfiguredAt || null,
      },
    });
  } catch (error) {
    console.error("[dhru-config] Fetch error:", error);
    return NextResponse.json(
      {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Failed to fetch configuration",
      },
      { status: 500 }
    );
  }
}
