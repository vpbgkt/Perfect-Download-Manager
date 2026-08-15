/**
 * Unified principal resolution for license endpoints.
 *
 * Resolves the caller of a license endpoint through one of two credential
 * paths:
 *
 *  1. **Api_Key (Reseller_API)** — when an `x-api-key` header is present, the
 *     request is authenticated through {@link Authenticator.authenticateApiKey}.
 *     Api_Key principals are implicitly `mfaEnrolled: true` and carry a
 *     `resellerAccountId` for ownership scoping.
 *
 *  2. **Firebase ID token (interactive)** — when no `x-api-key` header is
 *     present, the existing Firebase path runs exactly as today: extract the ID
 *     token from the `Authorization: Bearer` header or a body `idToken` field,
 *     verify it through {@link Authenticator.authenticate}, and apply the same
 *     ordering and error taxonomy.
 *
 * Both paths produce the same {@link Principal} shape so downstream permission
 * checks and `resellerAccountId` scoping work identically regardless of
 * credential type.
 *
 * The MFA-enrollment gate remains Firebase-only because Api_Key callers are
 * always considered MFA-enrolled (they authenticated through the key issuance
 * ceremony rather than a browser session).
 *
 * @module lib/principal
 * Requirements: 1.7, 3.5, 5.7, 7.12
 */

import type { Authenticator, AuthOutcome, Principal } from "./auth.ts";
import { extractIdToken } from "./http.ts";

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
 * existing {@link Authenticator.authenticateApiKey}; otherwise the Firebase ID
 * token path runs exactly as today, with unchanged ordering and errors.
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

  // ── Path 2: Firebase ID token (interactive portal user) ──
  const idToken = extractIdToken(req, body);
  if (!idToken) {
    return {
      ok: false,
      error: { code: "session_expired", message: "Missing credentials" },
    };
  }

  const result = await authenticator.authenticate({ idToken });
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, value: { principal: result.value } };
}
