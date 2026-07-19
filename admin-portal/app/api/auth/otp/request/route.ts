/**
 * POST /api/auth/otp/request
 *
 * Generate (or reissue) the single-use email OTP for the caller's verified
 * Firebase session. The challenge is **bound to a valid Firebase ID token**:
 * the token is verified first, and the OTP is issued against the resolved UID
 * so a client cannot request codes for an arbitrary account.
 *
 * `Authenticator.requestOtp` stores only the OTP hash (never the plaintext),
 * sets its TTL, and mails the code via the pluggable EmailSender.
 *
 * The endpoint is rate-limited per UID with a small fixed-window limiter to
 * curb OTP-email flooding; exceeding the window returns HTTP 429.
 *
 * Requirements: 1.4
 */

import { NextResponse } from "next/server";
import { getServerContext } from "../../../../../lib/server-context.ts";
import {
  authErrorResponse,
  extractIdToken,
  rateLimitedResponse,
  readJsonBody,
  upstreamErrorResponse,
} from "../../../../../lib/http.ts";
import { AUTHENTICATION_FAILED } from "../../../../../lib/auth.ts";

// ─── In-process fixed-window rate limiter (per UID) ──────────────────────────
// A lightweight, dependency-free guard against OTP-email flooding. Stateless
// deployments run a single Next.js process per host; the DynamoDB-backed
// limiter (lib/ratelimit) governs the Reseller_API, while this interactive
// email step only needs to throttle repeated requests for the same account.

const OTP_REQUEST_WINDOW_MS = 60_000;
const OTP_REQUEST_MAX_PER_WINDOW = 3;

const otpRequestHits = new Map<string, number[]>();

function allowOtpRequest(uid: string, nowMs: number): boolean {
  const cutoff = nowMs - OTP_REQUEST_WINDOW_MS;
  const recent = (otpRequestHits.get(uid) ?? []).filter((t) => t > cutoff);
  if (recent.length >= OTP_REQUEST_MAX_PER_WINDOW) {
    otpRequestHits.set(uid, recent);
    return false;
  }
  recent.push(nowMs);
  otpRequestHits.set(uid, recent);
  return true;
}

export async function POST(req: Request): Promise<NextResponse> {
  const body = await readJsonBody(req);
  const idToken = extractIdToken(req, body);

  if (!idToken) {
    return authErrorResponse(AUTHENTICATION_FAILED);
  }

  const { authenticator, tokenVerifier } = getServerContext();

  let uid: string;
  try {
    const verified = await tokenVerifier.verifyIdToken(idToken, true);
    uid = verified.uid;
  } catch {
    return authErrorResponse(AUTHENTICATION_FAILED);
  }

  // Rate-limit per verified UID (Req 1.4).
  if (!allowOtpRequest(uid, Date.now())) {
    return rateLimitedResponse();
  }

  try {
    const outcome = await authenticator.requestOtp({ firebaseUid: uid });
    if (!outcome.ok) {
      return authErrorResponse(outcome.error);
    }
  } catch {
    return upstreamErrorResponse();
  }

  return NextResponse.json({ status: "otp_sent" }, { status: 200 });
}
