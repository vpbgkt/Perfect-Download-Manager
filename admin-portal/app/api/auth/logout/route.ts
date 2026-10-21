/**
 * POST /api/auth/logout
 *
 * Advance the account's session version so previously issued password JWTs are
 * rejected by protected routes. Logout remains idempotent for missing/expired
 * tokens; client-side storage is cleared by the caller.
 */

import { NextResponse } from "next/server";
import { authErrorResponse, extractIdToken } from "@/lib/http.ts";
import { getServerContext } from "@/lib/server-context.ts";
import { verifyToken } from "@/lib/jwt.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const token = extractIdToken(req, null);
  if (!token) {
    return NextResponse.json({ status: "logged_out" }, { status: 200 });
  }

  const verified = verifyToken(token);
  if (!verified.ok) {
    return NextResponse.json({ status: "logged_out" }, { status: 200 });
  }

  const result = await getServerContext().authenticator.logoutPasswordSession({
    accountId: verified.payload.accountId,
    email: verified.payload.email,
    role: verified.payload.role as "super_admin" | "admin" | "distributor" | "reseller" | "dealer",
  });
  if (!result.ok) return authErrorResponse(result.error);

  return NextResponse.json({ status: "logged_out" }, { status: 200 });
}
