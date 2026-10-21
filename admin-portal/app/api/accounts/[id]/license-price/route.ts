/**
 * GET /api/accounts/{id}/license-price — returns pricing preview for a license
 * purchase, including the account's discount and current balance.
 *
 * Supports optional `planId` query param to return plan-specific pricing
 * instead of the default base price.
 *
 * Ownership-scoped: non-admin callers can only check their own account.
 */

import { NextResponse } from "next/server";
import { authErrorResponse } from "../../../../../lib/http.ts";
import { getServerContext } from "../../../../../lib/server-context.ts";
import { resolvePrincipal } from "../../../../../lib/principal.ts";
import { calculatePrice, getAccountForPricing } from "../../../../../lib/pricing.ts";
import { createPlanManager } from "../../../../../lib/plans.ts";

export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const ctx = getServerContext();

  const resolved = await resolvePrincipal(req, null, ctx.authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  const { id } = await context.params;
  const accountId = decodeURIComponent(id);

  // Ownership check: non-admin can only query their own pricing
  const isAdmin = principal.role === "admin" || principal.role === "super_admin";
  if (!isAdmin && principal.resellerAccountId !== accountId) {
    return NextResponse.json({ error: "not_found", message: "Not found" }, { status: 404 });
  }

  const account = await getAccountForPricing(ctx.dynamo, accountId);
  if (!account) {
    return NextResponse.json({ error: "not_found", message: "Account not found" }, { status: 404 });
  }

  // Check for plan-specific pricing
  const url = new URL(req.url);
  const planId = url.searchParams.get("planId");

  let basePrice: number;

  if (planId) {
    const planManager = createPlanManager({ dynamo: ctx.dynamo });
    const planResult = await planManager.getPlan(planId);
    if (!planResult.ok) {
      return NextResponse.json({ error: "not_found", message: "Plan not found" }, { status: 404 });
    }
    if (planResult.value.status !== "active") {
      return NextResponse.json({ error: "plan_inactive", message: "This plan is no longer available" }, { status: 400 });
    }
    basePrice = planResult.value.price;
  } else {
    // Fallback to default base license price
    const { BASE_LICENSE_PRICE } = await import("../../../../../lib/pricing.ts");
    basePrice = BASE_LICENSE_PRICE;
  }

  const pricing = calculatePrice(basePrice, account.discountPercent);

  return NextResponse.json({
    basePrice: pricing.basePrice,
    discountPercent: pricing.discountPercent,
    discountAmount: pricing.discountAmount,
    finalPrice: pricing.finalPrice,
    balance: account.balance,
    sufficient: account.balance >= pricing.finalPrice,
  });
}
