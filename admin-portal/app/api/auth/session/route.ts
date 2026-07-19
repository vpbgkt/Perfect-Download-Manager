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

export async function GET(req: Request): Promise<NextResponse> {
  const idToken = extractIdToken(req, null);
  if (!idToken) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const { authenticator } = getServerContext();
  const auth = await authenticator.authenticate({ idToken });
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
