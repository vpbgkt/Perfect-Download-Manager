/**
 * Dhru API IP Whitelist Management
 * 
 * GET - Get current IP whitelist status
 * POST - Enable IP binding (binds on first request)
 * DELETE - Reset IP binding (clears whitelisted IP)
 * 
 * @module app/api/resellers/[id]/dhru-ip-whitelist/route
 */

import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server-context.ts";
import { resolvePrincipal } from "@/lib/principal.ts";
import { authErrorResponse } from "@/lib/http.ts";

/**
 * GET - Get IP whitelist status
 */
export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: accountId } = await context.params;
  const { authenticator, dynamo } = getServerContext();

  // 1. Authenticate
  const resolved = await resolvePrincipal(req, null, authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  // 2. Check permission
  const isSuperAdmin = principal.role === "super_admin";
  const isOwnAccount = principal.resellerAccountId === accountId;
  
  if (!isSuperAdmin && !isOwnAccount) {
    return authErrorResponse({
      code: "not_authorized",
      message: "You can only view your own IP whitelist settings",
    });
  }

  try {
    // 3. Fetch account
    const account = await dynamo.get({
      TableName: "pdm-portal-resellers",
      Key: { resellerAccountId: accountId },
    });

    if (!account) {
      return NextResponse.json(
        { error: "not_found", message: "Account not found" },
        { status: 404 }
      );
    }

    // 4. Return IP whitelist status
    return NextResponse.json({
      success: true,
      ipBinding: {
        enabled: account.dhruApiIpBindingEnabled === true,
        whitelistedIp: account.dhruApiWhitelistedIp || null,
        lastUsedIp: account.dhruApiLastUsedIp || null,
        lastUsedAt: account.dhruApiLastUsedAt || null,
      },
    });
  } catch (error) {
    console.error("[dhru-ip-whitelist] Get error:", error);
    return NextResponse.json(
      {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Failed to fetch IP whitelist status",
      },
      { status: 500 }
    );
  }
}

/**
 * POST - Enable IP binding (will bind on first request)
 */
export async function POST(
  req: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: accountId } = await context.params;
  const { authenticator, dynamo } = getServerContext();

  // 1. Authenticate
  const resolved = await resolvePrincipal(req, null, authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  // 2. Check permission
  const isSuperAdmin = principal.role === "super_admin";
  const isOwnAccount = principal.resellerAccountId === accountId;
  
  if (!isSuperAdmin && !isOwnAccount) {
    return authErrorResponse({
      code: "not_authorized",
      message: "You can only manage your own IP whitelist settings",
    });
  }

  try {
    // 3. Enable IP binding
    await dynamo.update({
      TableName: "pdm-portal-resellers",
      Key: { resellerAccountId: accountId },
      UpdateExpression: "SET dhruApiIpBindingEnabled = :enabled",
      ExpressionAttributeValues: {
        ":enabled": true,
      },
    });

    return NextResponse.json({
      success: true,
      message: "IP binding enabled. The first API request will bind the IP address.",
    });
  } catch (error) {
    console.error("[dhru-ip-whitelist] Enable error:", error);
    return NextResponse.json(
      {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Failed to enable IP binding",
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Reset IP binding (clear whitelisted IP)
 */
export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: accountId } = await context.params;
  const { authenticator, dynamo } = getServerContext();

  // 1. Authenticate
  const resolved = await resolvePrincipal(req, null, authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  // 2. Check permission
  const isSuperAdmin = principal.role === "super_admin";
  const isOwnAccount = principal.resellerAccountId === accountId;
  
  if (!isSuperAdmin && !isOwnAccount) {
    return authErrorResponse({
      code: "not_authorized",
      message: "You can only reset your own IP whitelist",
    });
  }

  try {
    // 3. Reset IP binding
    await dynamo.update({
      TableName: "pdm-portal-resellers",
      Key: { resellerAccountId: accountId },
      UpdateExpression: "REMOVE dhruApiWhitelistedIp SET dhruApiIpBindingEnabled = :enabled",
      ExpressionAttributeValues: {
        ":enabled": true, // Keep binding enabled, just clear the IP
      },
    });

    return NextResponse.json({
      success: true,
      message: "IP whitelist reset. The next API request will bind a new IP address.",
    });
  } catch (error) {
    console.error("[dhru-ip-whitelist] Reset error:", error);
    return NextResponse.json(
      {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Failed to reset IP binding",
      },
      { status: 500 }
    );
  }
}

/**
 * PATCH - Disable IP binding
 */
export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: accountId } = await context.params;
  const { authenticator, dynamo } = getServerContext();

  // 1. Authenticate
  const resolved = await resolvePrincipal(req, null, authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  // 2. Check permission
  const isSuperAdmin = principal.role === "super_admin";
  const isOwnAccount = principal.resellerAccountId === accountId;
  
  if (!isSuperAdmin && !isOwnAccount) {
    return authErrorResponse({
      code: "not_authorized",
      message: "You can only manage your own IP whitelist settings",
    });
  }

  try {
    // 3. Disable IP binding
    await dynamo.update({
      TableName: "pdm-portal-resellers",
      Key: { resellerAccountId: accountId },
      UpdateExpression: "SET dhruApiIpBindingEnabled = :enabled",
      ExpressionAttributeValues: {
        ":enabled": false,
      },
    });

    return NextResponse.json({
      success: true,
      message: "IP binding disabled. API requests will be accepted from any IP.",
    });
  } catch (error) {
    console.error("[dhru-ip-whitelist] Disable error:", error);
    return NextResponse.json(
      {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Failed to disable IP binding",
      },
      { status: 500 }
    );
  }
}
