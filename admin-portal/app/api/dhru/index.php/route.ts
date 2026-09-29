/**
 * POST /api/dhru/index.php - Dhru Fusion API Compatible Endpoint
 * 
 * This endpoint mimics the Dhru Fusion API to allow existing Dhru panel owners
 * to integrate and resell PDM licenses through their panels.
 * 
 * Supported Actions:
 * - accountinfo: Get account balance and status
 * - imeiservicelist: List available PDM license plans
 * - placeimeiorder: Purchase PDM license (deducts balance)
 * - imeiorderdetails: Get license key details
 * 
 * Request Format:
 * POST /api/dhru/index.php
 * Content-Type: application/x-www-form-urlencoded
 * 
 * username=reseller_username
 * apiaccesskey=XXX-XXX-XXX-XXX-XXX-XXX-XXX-XXX
 * action=actionname
 * requestformat=JSON
 * parameters={"PARAM":"value"}
 * 
 * @module app/api/dhru/index.php/route
 */

import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server-context.ts";
import { createTransactionManager } from "@/lib/transactions.ts";
import { createAuditLog } from "@/lib/audit.ts";

// PDM License Service Definitions
const PDM_SERVICES = [
  {
    SERVICEID: "PDM3M",
    SERVICENAME: "PDM 3 Months License",
    CREDIT: "1",
    TIME: "Instant",
    INFO: "Perfect Download Manager - 3 Months License Key",
    REQUIREINFORMATION: "USERNAME,EMAIL",
  },
  {
    SERVICEID: "PDM6M",
    SERVICENAME: "PDM 6 Months License",
    CREDIT: "2",
    TIME: "Instant",
    INFO: "Perfect Download Manager - 6 Months License Key",
    REQUIREINFORMATION: "USERNAME,EMAIL",
  },
  {
    SERVICEID: "PDM12M",
    SERVICENAME: "PDM 12 Months License",
    CREDIT: "3",
    TIME: "Instant",
    INFO: "Perfect Download Manager - 1 Year License Key",
    REQUIREINFORMATION: "USERNAME,EMAIL",
  },
];

interface DhruRequest {
  username: string;
  apiaccesskey: string;
  action: string;
  requestformat: string;
  parameters?: string;
}

/** Best-effort source-IP extraction for audit trail */
function sourceIpOf(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip");
  if (realIp) return realIp;
  return "unknown";
}

/** Parse Dhru request from form data */
async function parseDhruRequest(req: Request): Promise<DhruRequest | null> {
  try {
    const contentType = req.headers.get("content-type");
    
    if (contentType?.includes("application/x-www-form-urlencoded")) {
      const formData = await req.formData();
      return {
        username: formData.get("username") as string,
        apiaccesskey: formData.get("apiaccesskey") as string,
        action: formData.get("action") as string,
        requestformat: formData.get("requestformat") as string,
        parameters: formData.get("parameters") as string | undefined,
      };
    } else if (contentType?.includes("application/json")) {
      return await req.json();
    }
    
    return null;
  } catch (error) {
    console.error("[dhru-api] Parse error:", error);
    return null;
  }
}

/** Authenticate Dhru API credentials and get account with IP whitelist check */
async function authenticateDhruRequest(
  username: string,
  apiAccessKey: string,
  requestIp: string,
  dynamo: any
): Promise<{ ok: true; account: any } | { ok: false; error: string }> {
  try {
    // Query reseller account by dhruApiUsername
    const result = await dynamo.query({
      TableName: "pdm-portal-resellers",
      IndexName: "dhruApiUsername-index",
      KeyConditionExpression: "dhruApiUsername = :username",
      ExpressionAttributeValues: {
        ":username": username,
      },
    });

    if (!result.items || result.items.length === 0) {
      return { ok: false, error: "INVALID_CREDENTIALS" };
    }

    const account = result.items[0] as any;

    // Verify API key
    if (account.dhruApiAccessKey !== apiAccessKey) {
      return { ok: false, error: "INVALID_CREDENTIALS" };
    }

    // Check account state
    if (account.state !== "active") {
      return { ok: false, error: "ACCOUNT_SUSPENDED" };
    }

    // IP Whitelist Check
    if (account.dhruApiIpBindingEnabled === true) {
      if (!account.dhruApiWhitelistedIp) {
        // First request - bind to this IP
        console.log(`[dhru-api] First request from ${requestIp}, binding IP...`);
        await dynamo.update({
          TableName: "pdm-portal-resellers",
          Key: { resellerAccountId: account.resellerAccountId },
          UpdateExpression: "SET dhruApiWhitelistedIp = :ip, dhruApiLastUsedIp = :ip, dhruApiLastUsedAt = :now",
          ExpressionAttributeValues: {
            ":ip": requestIp,
            ":now": new Date().toISOString(),
          },
        });
        account.dhruApiWhitelistedIp = requestIp;
      } else if (account.dhruApiWhitelistedIp !== requestIp) {
        // IP mismatch - reject request
        console.warn(`[dhru-api] IP mismatch for ${username}: expected ${account.dhruApiWhitelistedIp}, got ${requestIp}`);
        return { ok: false, error: "IP_NOT_AUTHORIZED" };
      } else {
        // IP matches - update last used
        await dynamo.update({
          TableName: "pdm-portal-resellers",
          Key: { resellerAccountId: account.resellerAccountId },
          UpdateExpression: "SET dhruApiLastUsedIp = :ip, dhruApiLastUsedAt = :now",
          ExpressionAttributeValues: {
            ":ip": requestIp,
            ":now": new Date().toISOString(),
          },
        });
      }
    } else {
      // IP binding disabled - just update last used
      await dynamo.update({
        TableName: "pdm-portal-resellers",
        Key: { resellerAccountId: account.resellerAccountId },
        UpdateExpression: "SET dhruApiLastUsedIp = :ip, dhruApiLastUsedAt = :now",
        ExpressionAttributeValues: {
          ":ip": requestIp,
          ":now": new Date().toISOString(),
        },
      });
    }

    return { ok: true, account };
  } catch (error) {
    console.error("[dhru-api] Auth error:", error);
    return { ok: false, error: "AUTHENTICATION_FAILED" };
  }
}

/** Format error response in Dhru API format */
function dhruError(error: string, message: string): NextResponse {
  return NextResponse.json({
    STATUS: "ERROR",
    ERROR: error,
    MESSAGE: message,
  });
}

/** Format success response in Dhru API format */
function dhruSuccess(data: any): NextResponse {
  return NextResponse.json({
    STATUS: "SUCCESS",
    ...data,
  });
}

export async function POST(req: Request): Promise<NextResponse> {
  const { dynamo } = getServerContext();

  // Extract request IP
  const requestIp = sourceIpOf(req);

  // 1. Parse request
  const dhruReq = await parseDhruRequest(req);
  
  if (!dhruReq) {
    return dhruError("INVALID_REQUEST", "Invalid request format");
  }

  const { username, apiaccesskey, action, requestformat, parameters } = dhruReq;

  // 2. Validate required fields
  if (!username || !apiaccesskey || !action) {
    return dhruError("MISSING_PARAMETERS", "Missing required parameters: username, apiaccesskey, action");
  }

  // 3. Authenticate with IP check
  const auth = await authenticateDhruRequest(username, apiaccesskey, requestIp, dynamo);
  
  if (!auth.ok) {
    return dhruError(auth.error, "Authentication failed");
  }

  const account = auth.account;

  // 4. Parse parameters if provided
  let params: any = {};
  if (parameters) {
    try {
      params = typeof parameters === "string" ? JSON.parse(parameters) : parameters;
    } catch {
      params = {};
    }
  }

  // 5. Route to action handlers
  try {
    switch (action.toLowerCase()) {
      case "accountinfo":
        return await handleAccountInfo(account, dynamo);
      
      case "imeiservicelist":
        return await handleServiceList();
      
      case "placeimeiorder":
        return await handlePlaceOrder(account, params, req, dynamo);
      
      case "getimeiorder":
      case "imeiorderdetails": // Support both for compatibility
        return await handleOrderDetails(account, params, dynamo);
      
      default:
        return dhruError("INVALID_ACTION", `Action '${action}' is not supported`);
    }
  } catch (error) {
    console.error("[dhru-api] Action error:", error);
    return dhruError("INTERNAL_ERROR", "An error occurred processing your request");
  }
}

// ============================================================================
// ACTION HANDLERS
// ============================================================================

/**
 * Handle 'accountinfo' action
 * Returns reseller account balance and status
 */
async function handleAccountInfo(account: any, dynamo: any): Promise<NextResponse> {
  // Get current balance from transaction manager
  const transactionManager = createTransactionManager({ dynamo });
  const balanceResult = await transactionManager.getBalance(account.resellerAccountId);
  
  const balance = balanceResult.ok ? balanceResult.value : (account.balance || 0);
  
  return dhruSuccess({
    USERNAME: account.dhruApiUsername,
    BALANCE: String(balance.toFixed(2)),
    CREDITS: String(balance),
    CURRENCY: "USD",
    ACCOUNT_TYPE: "RESELLER",
    STATUS: account.state === "active" ? "ACTIVE" : "SUSPENDED",
    EMAIL: account.contactEmail || "",
    ORGANIZATION: account.orgName || "",
  });
}

/**
 * Handle 'imeiservicelist' action
 * Returns list of available PDM license plans
 */
async function handleServiceList(): Promise<NextResponse> {
  return dhruSuccess({
    SERVICES: PDM_SERVICES,
    TOTAL: PDM_SERVICES.length,
  });
}

/**
 * Handle 'placeimeiorder' action
 * Generates PDM license and deducts balance
 * 
 * Parameters:
 * - ID: Service ID (PDM3M, PDM6M, PDM12M)
 * - IMEI: Username and email (format: "username|email" or just email)
 */
async function handlePlaceOrder(
  account: any,
  params: any,
  req: Request,
  dynamo: any
): Promise<NextResponse> {
  // 1. Validate required parameters
  const serviceId = params.ID || params.SERVICEID;
  const imeiField = params.IMEI;
  
  if (!serviceId) {
    return dhruError("MISSING_SERVICE_ID", "Service ID is required");
  }
  
  if (!imeiField) {
    return dhruError("MISSING_IMEI", "IMEI field (username/email) is required");
  }
  
  // 2. Find service
  const service = PDM_SERVICES.find(s => s.SERVICEID === serviceId);
  
  if (!service) {
    return dhruError("INVALID_SERVICE", `Service '${serviceId}' not found`);
  }
  
  const cost = parseInt(service.CREDIT);
  
  // 3. Parse username and email from IMEI field
  let username = "";
  let email = "";
  
  if (imeiField.includes("|")) {
    [username, email] = imeiField.split("|");
  } else if (imeiField.includes("@")) {
    email = imeiField;
    username = email.split("@")[0];
  } else {
    username = imeiField;
  }
  
  // 4. Check balance
  const transactionManager = createTransactionManager({ dynamo });
  const balanceResult = await transactionManager.getBalance(account.resellerAccountId);
  
  if (!balanceResult.ok) {
    return dhruError("BALANCE_CHECK_FAILED", "Could not verify account balance");
  }
  
  const currentBalance = balanceResult.value;
  
  if (currentBalance < cost) {
    return dhruError(
      "INSUFFICIENT_BALANCE",
      `Insufficient balance. Required: ${cost} credits, Available: ${currentBalance} credits`
    );
  }
  
  // 5. Determine license duration
  let maxActivations = 1;
  let expiresAt: string | undefined;
  const now = new Date();
  
  switch (serviceId) {
    case "PDM3M":
      expiresAt = new Date(now.setMonth(now.getMonth() + 3)).toISOString();
      break;
    case "PDM6M":
      expiresAt = new Date(now.setMonth(now.getMonth() + 6)).toISOString();
      break;
    case "PDM12M":
      expiresAt = new Date(now.setMonth(now.getMonth() + 12)).toISOString();
      break;
  }
  
  // 6. Generate license key
  const { createLicenseCreator } = await import("@/lib/licenses/create.ts");
  const audit = createAuditLog(dynamo);
  const licenseCreator = createLicenseCreator({ dynamo, audit });
  
  const licenseResult = await licenseCreator.create(
    {
      plan: service.SERVICENAME,
      maxActivations,
      owner: email || username,
      expiresAt,
      resellerAccountId: account.resellerAccountId,
      customer: {
        email,
        name: username,
      },
    },
    {
      actor: `dhru:${account.dhruApiUsername}`,
      actorRole: "reseller",
      sourceIp: sourceIpOf(req),
    }
  );
  
  if (!licenseResult.ok) {
    return dhruError("LICENSE_GENERATION_FAILED", licenseResult.error.message);
  }
  
  const license = licenseResult.value;
  
  // 7. Deduct balance
  const debitResult = await transactionManager.createTransaction({
    accountId: account.resellerAccountId,
    type: "debit",
    amount: cost,
    reason: `PDM License via Dhru API - ${service.SERVICENAME}`,
    relatedEntity: `license:${license.licenseKey}`,
    metadata: {
      dhruServiceId: serviceId,
      licenseKey: license.licenseKey,
      username,
      email,
      plan: service.SERVICENAME,
    },
    actor: `dhru:${account.dhruApiUsername}`,
    actorRole: "reseller",
    sourceIp: sourceIpOf(req),
  });
  
  if (!debitResult.ok) {
    // License created but balance deduction failed - critical error
    console.error("[dhru-api] CRITICAL: License created but balance deduction failed", {
      accountId: account.resellerAccountId,
      licenseKey: license.licenseKey,
      cost,
      error: debitResult.error,
    });
  }
  
  // 8. Store order in dhru_orders table (will create in Task 8)
  const orderId = `DH${Date.now()}${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
  
  try {
    await dynamo.put({
      TableName: "pdm-dhru-orders",
      Item: {
        orderId,
        resellerAccountId: account.resellerAccountId,
        dhruUsername: account.dhruApiUsername,
        serviceId,
        serviceName: service.SERVICENAME,
        licenseKey: license.licenseKey,
        cost,
        username,
        email,
        status: "COMPLETED",
        createdAt: new Date().toISOString(),
        expiresAt,
      },
    });
  } catch (error) {
    console.error("[dhru-api] Failed to store order:", error);
    // Continue anyway - order was successful
  }
  
  // 9. Create audit log
  await audit.log({
    action: "dhru_license_purchased",
    actor: `dhru:${account.dhruApiUsername}`,
    actorRole: "reseller",
    target: license.licenseKey,
    sourceIp: sourceIpOf(req),
    metadata: {
      orderId,
      serviceId,
      cost,
      username,
      email,
    },
  });
  
  // 10. Return success response in Dhru format
  return dhruSuccess({
    ORDERID: orderId,
    REFERENCEID: orderId, // Dhru standard field
    STATUS: "COMPLETED",
    SERVICEID: serviceId,
    SERVICENAME: service.SERVICENAME,
    COST: service.CREDIT,
    CODE: license.licenseKey,
    COMMENT: `Your PDM license key is ready. Download: https://perfectdownloadmanager.com/download`,
    MESSAGE: "License generated successfully",
    TIME: "Instant",
    IMEI: imeiField,
    USERNAME: username,
    EMAIL: email,
    EXPIRES: expiresAt,
  });
}

/**
 * Handle 'getimeiorder' / 'imeiorderdetails' action
 * Returns license key and order details
 * 
 * Parameters:
 * - ID or ORDERID: The order ID to retrieve (Dhru uses 'ID', we also support 'ORDERID')
 */
async function handleOrderDetails(
  account: any,
  params: any,
  dynamo: any
): Promise<NextResponse> {
  // Support both 'ID' (Dhru standard) and 'ORDERID' (our custom)
  const orderId = params.ID || params.ORDERID;
  
  if (!orderId) {
    return dhruError("MISSING_ORDER_ID", "Order ID is required (use ID or ORDERID parameter)");
  }
  
  try {
    // Fetch order from dhru_orders table
    const order = await dynamo.get({
      TableName: "pdm-dhru-orders",
      Key: { orderId },
    });
    
    if (!order) {
      return dhruError("ORDER_NOT_FOUND", `Order '${orderId}' not found`);
    }
    
    // Verify order belongs to this account
    if (order.resellerAccountId !== account.resellerAccountId) {
      return dhruError("UNAUTHORIZED", "You do not have permission to view this order");
    }
    
    // Return order details in Dhru format
    return dhruSuccess({
      ORDERID: order.orderId,
      REFERENCEID: order.orderId, // Dhru standard field
      ID: order.orderId, // Also include ID for compatibility
      STATUS: order.status || "COMPLETED",
      SERVICEID: order.serviceId,
      SERVICENAME: order.serviceName,
      COST: String(order.cost),
      CODE: order.licenseKey,
      COMMENT: `Your PDM license key. Download: https://perfectdownloadmanager.com/download`,
      MESSAGE: "License is active",
      IMEI: order.email || order.username,
      USERNAME: order.username,
      EMAIL: order.email,
      CREATED: order.createdAt,
      EXPIRES: order.expiresAt,
      COMPLETED: order.createdAt,
    });
  } catch (error) {
    console.error("[dhru-api] Order details error:", error);
    return dhruError("INTERNAL_ERROR", "Failed to retrieve order details");
  }
}
