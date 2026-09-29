/**
 * POST /api/resellers/{id}/dhru-api-key - Generate Dhru API credentials
 * DELETE /api/resellers/{id}/dhru-api-key - Revoke Dhru API credentials
 * 
 * Manages Dhru-compatible API credentials for resellers to integrate
 * and sell PDM licenses through their Dhru panels.
 * 
 * @module app/api/resellers/[id]/dhru-api-key/route
 */

import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getServerContext } from "@/lib/server-context.ts";
import { resolvePrincipal } from "@/lib/principal.ts";
import { authErrorResponse } from "@/lib/http.ts";

/**
 * Generate Dhru-compatible API access key
 * Format: XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX (8 segments of 3 characters)
 */
function generateDhruApiKey(): string {
  const segments: string[] = [];
  for (let i = 0; i < 8; i++) {
    const bytes = randomBytes(2);
    const segment = bytes.toString("hex").substring(0, 3).toUpperCase();
    segments.push(segment);
  }
  return segments.join("-");
}

/**
 * Generate Dhru username from reseller email
 * Uses the exact username part before @ symbol from the email
 */
function generateDhruUsername(account: any): string {
  // Extract username from email (part before @)
  const emailPrefix = account.contactEmail.split("@")[0];
  
  // Use the exact email prefix as username
  // Clean only special characters that might cause issues, keep alphanumeric, dots, underscores, hyphens
  const username = emailPrefix
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "");
  
  return username;
}

/**
 * POST - Generate new Dhru API credentials
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

  // 2. Check permission: super_admin can manage any account, distributors can only manage their own
  const isSuperAdmin = principal.role === "super_admin";
  const isOwnAccount = principal.resellerAccountId === accountId;
  
  if (!isSuperAdmin && !isOwnAccount) {
    return authErrorResponse({
      code: "not_authorized",
      message: "You can only manage Dhru API credentials for your own account",
    });
  }

  try {
    // 3. Fetch reseller account
    console.log("[dhru-api-key] Fetching account:", accountId);
    
    const account = await dynamo.get({
      TableName: "pdm-portal-resellers",
      Key: { resellerAccountId: accountId },
    });

    console.log("[dhru-api-key] Account data result:", {
      found: !!account,
      accountId,
    });

    if (!account) {
      console.error("[dhru-api-key] Account not found:", accountId);
      return NextResponse.json(
        { error: "not_found", message: `Account not found: ${accountId}` },
        { status: 404 }
      );
    }

    console.log("[dhru-api-key] Account found:", {
      accountId: account.resellerAccountId,
      orgName: account.orgName,
      hasCredentials: !!(account.dhruApiUsername && account.dhruApiAccessKey),
    });

    // 4. Check if credentials already exist
    if (account.dhruApiUsername && account.dhruApiAccessKey) {
      return NextResponse.json(
        {
          error: "credentials_exist",
          message: "Dhru API credentials already exist for this account. Revoke first to generate new ones.",
          existing: {
            username: account.dhruApiUsername,
            endpoint: "/api/dhru/index.php",
          },
        },
        { status: 400 }
      );
    }

    // 5. Generate credentials
    const username = generateDhruUsername(account);
    const accessKey = generateDhruApiKey();

    // 6. Update account with credentials
    await dynamo.update({
      TableName: "pdm-portal-resellers",
      Key: { resellerAccountId: accountId },
      UpdateExpression:
        "SET dhruApiUsername = :username, dhruApiAccessKey = :accessKey, dhruApiCreatedAt = :now",
      ExpressionAttributeValues: {
        ":username": username,
        ":accessKey": accessKey,
        ":now": new Date().toISOString(),
      },
    });

    // 7. Create GSI for username lookup (if not exists)
    // Note: GSI should be created in DynamoDB table definition

    // 8. Return credentials
    return NextResponse.json({
      success: true,
      message: "Dhru API credentials generated successfully",
      credentials: {
        username,
        accessKey,
        endpoint: "/api/dhru/index.php",
        fullEndpoint: `${req.headers.get("origin") || "https://your-domain.com"}/api/dhru/index.php`,
      },
      instructions: {
        step1: "Configure these credentials in your Dhru panel",
        step2: "Go to: Services → Add New Service → API Service",
        step3: "Enter the endpoint URL and credentials",
        step4: "Your customers can now purchase PDM licenses through your Dhru panel",
      },
    });
  } catch (error) {
    console.error("[dhru-api-key] Generation error:", error);
    return NextResponse.json(
      {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Failed to generate credentials",
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Revoke Dhru API credentials
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

  // 2. Check permission: super_admin can revoke any account, distributors can only revoke their own
  const isSuperAdmin = principal.role === "super_admin";
  const isOwnAccount = principal.resellerAccountId === accountId;
  
  if (!isSuperAdmin && !isOwnAccount) {
    return authErrorResponse({
      code: "not_authorized",
      message: "You can only revoke Dhru API credentials for your own account",
    });
  }

  try {
    // 3. Remove credentials from account
    await dynamo.update({
      TableName: "pdm-portal-resellers",
      Key: { resellerAccountId: accountId },
      UpdateExpression:
        "REMOVE dhruApiUsername, dhruApiAccessKey, dhruApiCreatedAt SET dhruApiRevokedAt = :now",
      ExpressionAttributeValues: {
        ":now": new Date().toISOString(),
      },
    });

    return NextResponse.json({
      success: true,
      message: "Dhru API credentials revoked successfully",
    });
  } catch (error) {
    console.error("[dhru-api-key] Revoke error:", error);
    return NextResponse.json(
      {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Failed to revoke credentials",
      },
      { status: 500 }
    );
  }
}

/**
 * GET - Retrieve existing Dhru API credentials
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

  // 2. Verify permission
  const isAdmin = principal.role === "super_admin" || principal.role === "admin";
  if (!isAdmin && principal.resellerAccountId !== accountId) {
    return authErrorResponse({
      code: "not_authorized",
      message: "Cannot access other account's credentials",
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

    // 4. Return credentials info
    return NextResponse.json({
      success: true,
      hasCredentials: !!(account.dhruApiUsername && account.dhruApiAccessKey),
      credentials: account.dhruApiUsername && account.dhruApiAccessKey
        ? {
            username: account.dhruApiUsername,
            accessKey: account.dhruApiAccessKey,
            endpoint: "/api/dhru/index.php",
            fullEndpoint: `${req.headers.get("origin") || "https://your-domain.com"}/api/dhru/index.php`,
            createdAt: account.dhruApiCreatedAt,
          }
        : null,
    });
  } catch (error) {
    console.error("[dhru-api-key] Fetch error:", error);
    return NextResponse.json(
      {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Failed to fetch credentials",
      },
      { status: 500 }
    );
  }
}
