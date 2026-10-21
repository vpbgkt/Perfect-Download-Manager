/**
 * Route Handlers for `/api/plans`.
 *
 * - `GET`  — list active plans (all authenticated users) or all plans (admin)
 * - `POST` — create a new plan (admin/super_admin only)
 *
 * @module app/api/plans/route
 */

import { NextResponse } from "next/server";
import {
  authErrorResponse,
  badRequestResponse,
  validationErrorResponse,
} from "../../../lib/http.ts";
import { getServerContext } from "../../../lib/server-context.ts";
import { resolvePrincipal } from "../../../lib/principal.ts";
import { createPlanManager } from "../../../lib/plans.ts";

/**
 * GET /api/plans — list product plans.
 *
 * - All authenticated users: returns active plans only
 * - Admin/super_admin with `?all=true`: returns all plans (active + inactive)
 */
export async function GET(req: Request): Promise<NextResponse> {
  const ctx = getServerContext();

  const resolved = await resolvePrincipal(req, null, ctx.authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  const url = new URL(req.url);
  const showAll = url.searchParams.get("all") === "true";
  const isAdmin = principal.role === "admin" || principal.role === "super_admin";

  const planManager = createPlanManager({ dynamo: ctx.dynamo });

  // Admin can see all plans; non-admin always sees active only
  const plans = isAdmin && showAll
    ? await planManager.listAll()
    : await planManager.listActive();

  return NextResponse.json({ plans }, { status: 200 });
}

/**
 * POST /api/plans — create a new product plan (admin/super_admin only).
 */
export async function POST(req: Request): Promise<NextResponse> {
  const body = await (async () => {
    try {
      const text = await req.text();
      if (!text) return null;
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  })();
  if (!body) {
    return badRequestResponse("Request body must be a JSON object");
  }

  const ctx = getServerContext();

  const resolved = await resolvePrincipal(req, body, ctx.authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  // Only admin/super_admin can create plans
  if (principal.role !== "admin" && principal.role !== "super_admin") {
    return authErrorResponse({ code: "not_authorized", message: "Not authorized" });
  }

  // Validate required fields
  if (!body.name || typeof body.name !== "string") {
    return validationErrorResponse("name", "Plan name is required");
  }
  if (body.durationMonths === undefined || typeof body.durationMonths !== "number" || body.durationMonths < 1) {
    return validationErrorResponse("durationMonths", "Duration must be at least 1 month");
  }
  if (body.price === undefined || typeof body.price !== "number" || body.price < 0) {
    return validationErrorResponse("price", "Price must be a non-negative number");
  }

  const planManager = createPlanManager({ dynamo: ctx.dynamo });
  const result = await planManager.createPlan({
    name: body.name as string,
    durationMonths: body.durationMonths as number,
    price: body.price as number,
    maxActivations: typeof body.maxActivations === "number" ? body.maxActivations : undefined,
    features: Array.isArray(body.features) ? (body.features as string[]) : undefined,
    sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
  });

  if (!result.ok) {
    return validationErrorResponse("plan", result.error.message);
  }

  return NextResponse.json(result.value, { status: 201 });
}
