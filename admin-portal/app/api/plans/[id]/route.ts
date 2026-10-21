/**
 * Route Handlers for `/api/plans/[id]`.
 *
 * - `PUT`    — update plan (admin/super_admin only)
 * - `DELETE` — deactivate plan (admin/super_admin only, soft-delete)
 *
 * @module app/api/plans/[id]/route
 */

import { NextResponse } from "next/server";
import {
  authErrorResponse,
  badRequestResponse,
  validationErrorResponse,
} from "../../../../lib/http.ts";
import { getServerContext } from "../../../../lib/server-context.ts";
import { resolvePrincipal } from "../../../../lib/principal.ts";
import { createPlanManager } from "../../../../lib/plans.ts";

/**
 * PUT /api/plans/{id} — update an existing product plan (admin/super_admin only).
 */
export async function PUT(
  req: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
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

  if (principal.role !== "admin" && principal.role !== "super_admin") {
    return authErrorResponse({ code: "not_authorized", message: "Not authorized" });
  }

  const { id } = await context.params;
  const planId = decodeURIComponent(id);

  const planManager = createPlanManager({ dynamo: ctx.dynamo });
  const result = await planManager.updatePlan(planId, {
    name: typeof body.name === "string" ? body.name : undefined,
    durationMonths: typeof body.durationMonths === "number" ? body.durationMonths : undefined,
    price: typeof body.price === "number" ? body.price : undefined,
    maxActivations: typeof body.maxActivations === "number" ? body.maxActivations : undefined,
    features: Array.isArray(body.features) ? (body.features as string[]) : undefined,
    status: body.status === "active" || body.status === "inactive" ? body.status : undefined,
    sortOrder: typeof body.sortOrder === "number" ? body.sortOrder : undefined,
    description: typeof body.description === "string" ? body.description : undefined,
  });

  if (!result.ok) {
    if (result.error.code === "not_found") {
      return NextResponse.json({ error: "not_found", message: result.error.message }, { status: 404 });
    }
    return validationErrorResponse("plan", result.error.message);
  }

  return NextResponse.json(result.value, { status: 200 });
}

/**
 * DELETE /api/plans/{id} — deactivate a plan (soft-delete, admin/super_admin only).
 */
export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const ctx = getServerContext();

  const resolved = await resolvePrincipal(req, null, ctx.authenticator);
  if (!resolved.ok) {
    return authErrorResponse(resolved.error);
  }
  const principal = resolved.value.principal;

  if (principal.role !== "admin" && principal.role !== "super_admin") {
    return authErrorResponse({ code: "not_authorized", message: "Not authorized" });
  }

  const { id } = await context.params;
  const planId = decodeURIComponent(id);

  const planManager = createPlanManager({ dynamo: ctx.dynamo });
  const result = await planManager.deactivatePlan(planId);

  if (!result.ok) {
    if (result.error.code === "not_found") {
      return NextResponse.json({ error: "not_found", message: result.error.message }, { status: 404 });
    }
    return badRequestResponse(result.error.message);
  }

  return NextResponse.json(result.value, { status: 200 });
}
