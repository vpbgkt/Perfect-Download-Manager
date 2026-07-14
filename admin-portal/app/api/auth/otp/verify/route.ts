/**
 * POST /api/auth/otp/verify
 *
 * Complete the email-OTP second factor. The Firebase ID token is verified to
 * resolve the UID, then the submitted 6-digit code is checked against the
 * stored hash within its TTL. On success the sign-in is marked OTP-satisfied,
 * the DynamoDB session-activity record is opened, and a session cookie is set
 * so middleware can gate protected routes. Failures advance the lockout
 * counter and return the uniform authentication failure (or 423 once locked).
 *
 * Requirements: 1.2, 1.4, 1.8
 */

import { NextResponse } from "next/server";
import { getServerContext } from "../../../../../lib/server-context.ts";
import {
  authErrorResponse,
  extractIdToken,
  readJsonBody,
  SESSION_COOKIE,
  upstreamErrorResponse,
  validationErrorResponse,
} from "../../../../../lib/http.ts";
import { AUTHENTICATION_FAILED } from "../../../../../lib/auth.ts";

export async function POST(req: Request): Promise<NextResponse> {
  const body = await readJsonBody(req);
  const idToken = extractIdToken(req, body);

  if (!idToken) {
    return authErrorResponse(AUTHENTICATION_FAILED);
  }

  const otp = body && typeof body.otp === "string" ? body.otp : undefined;
  if (otp === undefined) {
    return validationErrorResponse("otp", "OTP is required");
  }

  const { authenticator, tokenVerifier } = getServerContext();

  let uid: string;
  try {
    const verified = await tokenVerifier.verifyIdToken(idToken, true);
    uid = verified.uid;
  } catch {
    return authErrorResponse(AUTHENTICATION_FAILED);
  }

  let principal;
  try {
    const outcome = await authenticator.verifyOtp({ firebaseUid: uid, otp });
    if (!outcome.ok) {
      return authErrorResponse(outcome.error);
    }
    principal = outcome.value;
  } catch {
    return upstreamErrorResponse();
  }

  // Session opened: expose only non-sensitive principal fields.
  const res = NextResponse.json(
    {
      status: "authenticated",
      role: principal.role,
      resellerAccountId: principal.resellerAccountId,
    },
    { status: 200 }
  );

  // Mark the session for the middleware gate. The Firebase ID token remains the
  // authoritative credential re-verified server-side on every request; this
  // httpOnly cookie only signals "an interactive session was opened".
  res.cookies.set(SESSION_COOKIE, idToken, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
  });

  return res;
}
