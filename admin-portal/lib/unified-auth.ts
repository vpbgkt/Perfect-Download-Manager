/**
 * Unified authentication helper for both Firebase and JWT tokens.
 * 
 * This module is separate from lib/http.ts to avoid loading Node.js modules
 * in Edge Runtime middleware.
 * 
 * @module lib/unified-auth
 */

import { extractAuthToken } from "./http.ts";
import type { AuthError } from "./auth.ts";

/**
 * Authenticate request using either Firebase ID token or JWT token.
 * This is a unified authentication helper that works with both auth methods.
 * 
 * Returns the authenticated principal or null if authentication fails.
 */
export async function authenticateRequest(
  req: Request,
  body: Record<string, unknown> | null = null
): Promise<{
  ok: true;
  principal: {
    identity: string;
    role: string;
    resellerAccountId: string | null;
    mfaEnrolled: boolean;
    authMethod: "firebase" | "password";
  };
} | {
  ok: false;
  error: AuthError;
}> {
  const token = extractAuthToken(req, body);
  
  if (!token) {
    return {
      ok: false,
      error: {
        code: "authentication_failed",
        message: "No authentication token provided",
      },
    };
  }

  // Try JWT verification first (for password-auth users)
  try {
    const { verifyToken } = await import("./jwt.ts");
    const jwtResult = verifyToken(token);
    
    if (jwtResult.ok) {
      // JWT token verified successfully
      return {
        ok: true,
        principal: {
          identity: jwtResult.payload.accountId,
          role: jwtResult.payload.role,
          resellerAccountId: jwtResult.payload.resellerAccountId,
          mfaEnrolled: false,
          authMethod: "password",
        },
      };
    }

    // If JWT verification failed with "malformed_token", try Firebase
    if (jwtResult.error.code === "malformed_token" || jwtResult.error.code === "invalid_token") {
      // Continue to Firebase auth below
    } else {
      // JWT token is valid format but expired or otherwise invalid
      return {
        ok: false,
        error: {
          code: jwtResult.error.code === "expired_token" ? "session_expired" : "authentication_failed",
          message: jwtResult.error.message,
        },
      };
    }
  } catch (jwtError) {
    // JWT import/verification failed, try Firebase
    // This can happen in Edge Runtime where crypto isn't available
  }

  // Try Firebase authentication
  try {
    const { getServerContext } = await import("./server-context.ts");
    const { authenticator } = getServerContext();
    
    const firebaseResult = await authenticator.authenticate({ idToken: token });
    
    if (firebaseResult.ok) {
      return {
        ok: true,
        principal: {
          identity: firebaseResult.value.identity,
          role: firebaseResult.value.role,
          resellerAccountId: firebaseResult.value.resellerAccountId,
          mfaEnrolled: firebaseResult.value.mfaEnrolled,
          authMethod: "firebase",
        },
      };
    }

    return {
      ok: false,
      error: firebaseResult.error,
    };
  } catch {
    // Both auth methods failed
    return {
      ok: false,
      error: {
        code: "authentication_failed",
        message: "Authentication failed",
      },
    };
  }
}
