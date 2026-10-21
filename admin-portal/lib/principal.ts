/**
 * Unified principal resolution for license endpoints.
 *
 * Resolves the caller of a license endpoint through one of three credential
 * paths:
 *
 *  1. **Api_Key (Reseller_API)** — when an `x-api-key` header is present, the
 *     request is authenticated through {@link Authenticator.authenticateApiKey}.
 *     Api_Key principals are implicitly `mfaEnrolled: true` and carry a
 *     `resellerAccountId` for ownership scoping.
 *
 *  2. **JWT token (password-authenticated users)** — when a valid JWT token is
 *     present in the Authorization header, verify it and resolve the principal
 *     from the token payload.
 *
 *  3. **Firebase ID token (legacy)** — for backward compatibility, if a Firebase
 *     ID token is detected, authenticate through the existing Firebase path.
 *
 * All paths produce the same {@link Principal} shape so downstream permission
 * checks and `resellerAccountId` scoping work identically regardless of
 * credential type.
 *
 * @module lib/principal
 * Requirements: 1.7, 3.5, 5.7, 7.12
 */

import type { Authenticator, AuthOutcome, Principal } from "./auth.ts";
import { extractIdToken } from "./http.ts";
import { verifyToken } from "./jwt.ts";

/**
 * The outcome of resolving a principal, including which credential path was
 * used so callers can apply path-specific gates (e.g. MFA for Firebase only).
 */
export interface ResolvedPrincipal {
  principal: Principal;
}

/**
 * Resolve the caller of a license endpoint.
 *
 * An `x-api-key` header authenticates a Reseller_API caller through the
 * existing {@link Authenticator.authenticateApiKey}; otherwise try JWT token
 * verification (password auth), then fall back to Firebase ID token for
 * backward compatibility.
 *
 * @param req - The incoming HTTP request.
 * @param body - The parsed JSON body (may be null for GET requests).
 * @param authenticator - The server's authenticator instance.
 * @returns An {@link AuthOutcome} carrying the resolved {@link Principal} on
 *   success, or the appropriate auth error on failure.
 */
export async function resolvePrincipal(
  req: Request,
  body: Record<string, unknown> | null,
  authenticator: Authenticator
): Promise<AuthOutcome<ResolvedPrincipal>> {
  // ── Path 1: Api_Key authentication (Reseller_API) ──
  const apiKey = req.headers.get("x-api-key");
  if (apiKey) {
    const result = await authenticator.authenticateApiKey({ apiKey });
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    return { ok: true, value: { principal: result.value } };
  }

  // ── Path 2: JWT token (password-authenticated users) ──
  const token = extractIdToken(req, body);
  if (token) {
    // Try JWT verification first
    const jwtResult = verifyToken(token);
    if (jwtResult.ok) {
      const payload = jwtResult.payload;
      const result = await authenticator.authenticateJwtSession({
        accountId: payload.accountId,
        email: payload.email,
        role: payload.role as Principal["role"],
        resellerAccountId: payload.resellerAccountId,
        sessionVersion: payload.sessionVersion,
      });
      if (!result.ok) return result;
      return { ok: true, value: { principal: result.value } };
    }

    console.log("[resolvePrincipal] JWT verification failed:", jwtResult.error);

    // JWT verification failed - try Firebase as fallback (for existing sessions)
    if (authenticator.authenticate) {
      const result = await authenticator.authenticate({ idToken: token });
      if (!result.ok) {
        console.log("[resolvePrincipal] Firebase auth also failed:", result.error);
        return { ok: false, error: result.error };
      }
      console.log("[resolvePrincipal] Firebase auth succeeded");
      return { ok: true, value: { principal: result.value } };
    }
    
    // No Firebase authenticator available, return JWT error
    console.log("[resolvePrincipal] No Firebase authenticator, returning JWT error");
    return {
      ok: false,
      error: {
        code: "session_expired",
        message: jwtResult.error.message,
      },
    };
  }

  console.log("[resolvePrincipal] No token found in request");
  
  // No credentials found
  return {
    ok: false,
    error: { code: "session_expired", message: "Missing credentials" },
  };
}
