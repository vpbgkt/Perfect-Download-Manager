/**
 * GET /api/auth/session
 *
 * Returns the authenticated caller's non-sensitive principal summary (role,
 * reseller association, MFA-enrollment state) so the dashboard shell can render
 * role-aware navigation. Authenticates via the Firebase ID token exactly like
 * every other protected route — the cookie only gates the middleware; this
 * endpoint re-verifies the token server-side.
 *
 * Requirements: 2.1, 2.2
 */

import { NextResponse } from "next/server";
import { getServerContext } from "../../../../lib/server-context.ts";
import { authErrorResponse, extractIdToken } from "../../../../lib/http.ts";

// Force Node.js runtime for JWT support
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<NextResponse> {
  const token = extractIdToken(req, null);
  if (!token) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  // Try JWT verification first (for password-authenticated users).
  const { verifyToken } = await import("../../../../lib/jwt.ts");
  const jwtResult = verifyToken(token);
  if (jwtResult.ok) {
    const { authenticator } = getServerContext();
    const session = await authenticator.authenticateJwtSession({
      accountId: jwtResult.payload.accountId,
      email: jwtResult.payload.email,
      role: jwtResult.payload.role as "super_admin" | "admin" | "distributor" | "reseller" | "dealer",
      resellerAccountId: jwtResult.payload.resellerAccountId,
      sessionVersion: jwtResult.payload.sessionVersion,
    });
    if (!session.ok) return authErrorResponse(session.error);

    return NextResponse.json({
      identity: session.value.identity,
      role: session.value.role,
      resellerAccountId: session.value.resellerAccountId,
      mfaEnrolled: session.value.mfaEnrolled,
    });
  }

  // Try Firebase authentication (for admin users)
  const { authenticator } = getServerContext();
  const auth = await authenticator.authenticate({ idToken: token });
  if (!auth.ok) {
    return authErrorResponse(auth.error);
  }

  const p = auth.value;
  return NextResponse.json({
    identity: p.identity,
    role: p.role,
    resellerAccountId: p.resellerAccountId,
    mfaEnrolled: p.mfaEnrolled,
  });
}
