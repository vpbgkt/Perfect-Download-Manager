/**
 * POST /api/auth/login
 *
 * Token-exchange / OTP-initiation endpoint. The password factor is owned by
 * Firebase: the client signs in with the Firebase JS SDK and posts the
 * resulting **ID token** here. This handler verifies that token statelessly via
 * the Firebase Admin SDK, then initiates the email-OTP second factor by issuing
 * an OTP (its hash persisted with a TTL) and mailing it to the resolved admin.
 *
 * An absent/invalid token — or a token whose UID is not a known portal admin —
 * collapses to the uniform 401 `authentication_failed`, disclosing nothing
 * about which part was wrong.
 *
 * Requirements: 1.1, 1.2, 1.4, 15.7
 */

import { NextResponse } from "next/server";
import { getServerContext } from "../../../../lib/server-context.ts";
import {
  authErrorResponse,
  extractIdToken,
  readJsonBody,
  SESSION_COOKIE,
  upstreamErrorResponse,
} from "../../../../lib/http.ts";
import { AUTHENTICATION_FAILED } from "../../../../lib/auth.ts";

export async function POST(req: Request): Promise<NextResponse> {
  const body = await readJsonBody(req);
  const idToken = extractIdToken(req, body);

  if (!idToken) {
    // No credential presented — uniform failure (Req 1.3, 15.7).
    return authErrorResponse(AUTHENTICATION_FAILED);
  }

  const ctx = getServerContext();
  const { authenticator, tokenVerifier } = ctx;

  // Verify the Firebase ID token statelessly (Req 1.2). Any rejection maps to
  // the uniform authentication failure.
  let uid: string;
  try {
    const verified = await tokenVerifier.verifyIdToken(idToken, true);
    uid = verified.uid;
  } catch {
    return authErrorResponse(AUTHENTICATION_FAILED);
  }

  // ── OTP disabled (local dev / PORTAL_DISABLE_OTP): open the session directly
  //    and set the cookie, skipping the email-OTP step. ──
  if (ctx.otpDisabled) {
    try {
      const outcome = await authenticator.openSession({ firebaseUid: uid });
      if (!outcome.ok) {
        return authErrorResponse(outcome.error);
      }
      const res = NextResponse.json(
        { status: "authenticated", role: outcome.value.role },
        { status: 200 }
      );
      res.cookies.set(SESSION_COOKIE, idToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
      });
      return res;
    } catch {
      return upstreamErrorResponse();
    }
  }

  // Initiate the email-OTP challenge (Req 1.4). `requestOtp` resolves the admin
  // record, honors an active lockout, persists only the OTP hash with a TTL,
  // and mails the code via the pluggable EmailSender.
  try {
    const outcome = await authenticator.requestOtp({ firebaseUid: uid });
    if (!outcome.ok) {
      return authErrorResponse(outcome.error);
    }
  } catch {
    return upstreamErrorResponse();
  }

  // Non-leaking success body: the client now proceeds to the OTP step. We do
  // not echo the email, role, or any account detail here.
  return NextResponse.json({ status: "otp_required" }, { status: 200 });
}
