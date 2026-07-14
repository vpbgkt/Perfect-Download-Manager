/**
 * HTTP helpers shared by the portal's Route Handlers.
 *
 * Centralizes two concerns so every handler behaves uniformly:
 *
 *  1. Mapping the {@link AuthError} taxonomy from `lib/auth` onto HTTP status
 *     codes and **non-leaking** JSON bodies (never disclosing which field was
 *     wrong, no stack traces, no internal identifiers) — see the design's
 *     "Error Handling" table.
 *  2. Extracting the Firebase ID token from a request (either the
 *     `Authorization: Bearer <token>` header or a JSON body field) and safely
 *     parsing JSON bodies.
 *
 * @module lib/http
 * Requirements: 1.1, 1.3, 1.5, 1.6, 15.7
 */

import { NextResponse } from "next/server";
import type { AuthError } from "./auth.ts";

/** Name of the cookie whose presence marks an opened interactive session. */
export const SESSION_COOKIE = "pdm_session";

/**
 * Map an {@link AuthError} to its HTTP response, following the design's error
 * taxonomy. Bodies are intentionally minimal so nothing internal leaks.
 */
export function authErrorResponse(error: AuthError): NextResponse {
  switch (error.code) {
    case "authentication_failed":
      // Uniform invalid-credential response (Req 1.3, 15.7).
      return NextResponse.json({ error: "authentication_failed" }, { status: 401 });
    case "session_expired":
      // Missing/expired/invalid session (Req 1.1, 1.7).
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    case "account_locked":
      // Too many failed OTP attempts (Req 1.6).
      return NextResponse.json({ error: "account_locked" }, { status: 423 });
    case "mfa_required":
      // OTP factor not yet enrolled (Req 1.5).
      return NextResponse.json({ error: "mfa_enrollment_required" }, { status: 403 });
    case "not_authorized":
      // Authenticated but lacks the required permission (Req 2.3).
      return NextResponse.json({ error: "not_authorized" }, { status: 403 });
    case "not_found":
      // Non-owned / unknown resource, reported as genuinely missing (Req 2.7).
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    default:
      // Exhaustiveness guard — unknown codes collapse to a safe 401.
      return NextResponse.json({ error: "authentication_failed" }, { status: 401 });
  }
}

/** A 400 validation-error body with an optional field/reason (Req 15.4). */
export function validationErrorResponse(field: string, reason: string): NextResponse {
  return NextResponse.json({ error: "validation_error", field, reason }, { status: 400 });
}

/** A generic 400 for malformed request bodies. */
export function badRequestResponse(reason: string): NextResponse {
  return NextResponse.json({ error: "bad_request", reason }, { status: 400 });
}

/** A 429 rate-limit response (Req 1.4, 12.5). */
export function rateLimitedResponse(): NextResponse {
  return NextResponse.json({ error: "rate_limit_exceeded" }, { status: 429 });
}

/** A 502 for downstream failures — no detail is leaked. */
export function upstreamErrorResponse(): NextResponse {
  return NextResponse.json({ error: "upstream_error" }, { status: 502 });
}

/**
 * Parse a request body as JSON, returning `null` on empty or malformed input so
 * callers can respond with a 400 rather than throwing.
 */
export async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
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
}

/**
 * Extract a Firebase ID token from the request: prefer the
 * `Authorization: Bearer <token>` header, then fall back to an `idToken`
 * field on the already-parsed JSON body. Returns `null` when absent.
 */
export function extractIdToken(
  req: Request,
  body: Record<string, unknown> | null
): string | null {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match && match[1].trim().length > 0) {
      return match[1].trim();
    }
  }
  if (body && typeof body.idToken === "string" && body.idToken.length > 0) {
    return body.idToken;
  }
  return null;
}
