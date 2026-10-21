/**
 * GET /api/dhru/services - Get list of available services from Dhru API
 * 
 * Fetches both IMEI and File services from Dhru Fusion API.
 * Supports filtering by service type.
 * 
 * @module app/api/dhru/services/route
 */

import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server-context.ts";
import { resolvePrincipal } from "@/lib/principal.ts";
import { authErrorResponse, validationErrorResponse } from "@/lib/http.ts";
import { createPlanManager } from "@/lib/plans.ts";

export async function GET(req: Request): Promise<NextResponse> {
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
  const serviceType = url.searchParams.get("type") || "all"; // 'imei', 'file', or 'all'

  if (!accountId) {
    return validationErrorResponse("accountId", "Account ID is required");
  }

  // 3. Verify permission
  const isAdmin = principal.role === "super_admin" || principal.role === "admin";
  if (!isAdmin && principal.resellerAccountId !== accountId) {
    return authErrorResponse({
      code: "not_authorized",
      message: "Cannot access other account's services",
    });
  }

  try {
    // 4. Fetch Dhru API credentials
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

    const services: any[] = [];

    // 5. Fetch IMEI services if requested
    if (serviceType === "imei" || serviceType === "all") {
      const imeiResponse = await fetch(`${account.dhruApiUrl}/api/index.php`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          username: account.dhruUsername,
          apiaccesskey: account.dhruApiKey,
          action: "imeiservicelist",
          requestformat: "JSON",
        }),
      });

      if (imeiResponse.ok) {
        const imeiData = await imeiResponse.json();
        if (imeiData.SERVICES && Array.isArray(imeiData.SERVICES)) {
          services.push(
            ...imeiData.SERVICES.map((svc: any) => ({
              ...svc,
              type: "imei",
            }))
          );
        }
      }
    }

    // 6. Fetch File services if requested
    if (serviceType === "file" || serviceType === "all") {
      const fileResponse = await fetch(`${account.dhruApiUrl}/api/index.php`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          username: account.dhruUsername,
          apiaccesskey: account.dhruApiKey,
          action: "fileservicelist",
          requestformat: "JSON",
        }),
      });

      if (fileResponse.ok) {
        const fileData = await fileResponse.json();
        if (fileData.SERVICES && Array.isArray(fileData.SERVICES)) {
          services.push(
            ...fileData.SERVICES.map((svc: any) => ({
              ...svc,
              type: "file",
            }))
          );
        }
      }
    }

    // 7. Inject active PDM product plans as services
    const planManager = createPlanManager({ dynamo });
    const activePlans = await planManager.listActive();
    for (const plan of activePlans) {
      services.push({
        ID: plan.planId,
        SERVICE_NAME: plan.name,
        PRICE: plan.price,
        DURATION_MONTHS: plan.durationMonths,
        MAX_ACTIVATIONS: plan.maxActivations,
        FEATURES: plan.features,
        DESCRIPTION: plan.description ?? "",
        STATUS: plan.status,
        type: "pdm_license",
      });
    }

    // 8. Return services list
    return NextResponse.json({
      success: true,
      accountId,
      services,
      count: services.length,
    });
  } catch (error) {
    console.error("[dhru-services] Error:", error);
    return NextResponse.json(
      {
        error: "internal_error",
        message: error instanceof Error ? error.message : "Failed to fetch services",
      },
      { status: 500 }
    );
  }
}
