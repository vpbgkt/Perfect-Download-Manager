/**
 * POST /api/auth/logout
 *
 * Invalidate the interactive Session: verify the presented Firebase ID token to
 * resolve the UID, revoke the Firebase refresh token (best-effort, via the
 * Admin SDK) and clear the DynamoDB session-activity record so subsequent
 * requests using that credential are rejected. The session cookie is cleared.
 *
 * Logout is idempotent and never leaks account state — an unknown or absent
 * credential still returns a clean 200 with the cookie cleared.
 *
 * Requirements: 1.8
 */

import { NextResponse } from "next/server";
import { getServerContext } from "../../../../lib/server-context.ts";
import { extractIdToken, readJsonBody, SESSION_COOKIE } from "../../../../lib/http.ts";

function clearedResponse(): NextResponse {
  const res = NextResponse.json({ status: "logged_out" }, { status: 200 });
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}

export async function POST(req: Request): Promise<NextResponse> {
  const body = await readJsonBody(req);
  const idToken = extractIdToken(req, body);

  if (!idToken) {
    // Nothing to revoke; still clear any cookie and succeed idempotently.
    return clearedResponse();
  }

  const { authenticator, tokenVerifier } = getServerContext();

  // Resolve the UID without failing the logout on an invalid/expired token —
  // the goal is to end the session regardless.
  let uid: string | undefined;
  try {
    const verified = await tokenVerifier.verifyIdToken(idToken, false);
    uid = verified.uid;
  } catch {
    uid = undefined;
  }

  if (uid) {
    try {
      // logout() revokes refresh tokens and clears the session-activity record.
      await authenticator.logout({ firebaseUid: uid });
    } catch {
      // Best-effort: clearing the cookie below still ends the browser session.
    }
  }

  return clearedResponse();
}
