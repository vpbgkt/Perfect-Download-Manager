/**
 * JWT token management for password-based authentication.
 * 
 * This module provides JWT signing and verification for distributors/resellers/dealers
 * who authenticate via email+password instead of Firebase.
 * 
 * Token payload includes:
 *  - accountId: The reseller account ID
 *  - role: Account role (distributor/reseller/dealer)
 *  - resellerAccountId: Same as accountId for consistency
 *  - authMethod: "password" to distinguish from Firebase auth
 *  - iat: Issued at timestamp
 *  - exp: Expiration timestamp
 * 
 * @module lib/jwt
 */

import jwt from "jsonwebtoken";

// ─── Configuration ───────────────────────────────────────────────────────────

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must be configured with at least 32 characters");
  }
  return secret;
}

/** Token expiration time - 7 days */
const JWT_EXPIRATION = "7d";

/** Token issuer */
const JWT_ISSUER = "pdm-portal";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface JwtPayload {
  /** Account ID (adminId for admins, resellerAccountId for others) */
  accountId: string;
  /** Normalized account email, used for current-record validation. */
  email: string;
  /** Account role */
  role: "super_admin" | "admin" | "readonly_admin" | "distributor" | "reseller" | "dealer";
  /** Reseller account ID (null for admins) */
  resellerAccountId: string | null;
  /** Authentication method */
  authMethod: "password";
  /** Server-side account token generation. Incrementing it revokes existing JWTs. */
  sessionVersion: number;
  /** Issuer */
  iss: string;
  /** Issued at (Unix timestamp) */
  iat: number;
  /** Expiration (Unix timestamp) */
  exp: number;
}

export interface TokenSignData {
  accountId: string;
  email: string;
  role: "super_admin" | "admin" | "readonly_admin" | "distributor" | "reseller" | "dealer";
  resellerAccountId: string | null;
  sessionVersion: number;
}

// ─── Token Generation ────────────────────────────────────────────────────────

/**
 * Sign a JWT token for a password-authenticated account.
 * 
 * @param data - Account data to include in token
 * @returns Signed JWT token string
 */
export function signToken(data: TokenSignData): string {
  const secret = getJwtSecret();
  const payload = {
    accountId: data.accountId,
    email: data.email.toLowerCase(),
    role: data.role,
    resellerAccountId: data.resellerAccountId,
    authMethod: "password" as const,
    sessionVersion: data.sessionVersion,
  };

  return jwt.sign(payload, secret, {
    expiresIn: JWT_EXPIRATION,
    issuer: JWT_ISSUER,
  });
}

// ─── Token Verification ──────────────────────────────────────────────────────

export interface VerifyResult {
  ok: true;
  payload: JwtPayload;
}

export interface VerifyError {
  ok: false;
  error: {
    code: "invalid_token" | "expired_token" | "malformed_token";
    message: string;
  };
}

/**
 * Verify and decode a JWT token.
 * 
 * @param token - JWT token string to verify
 * @returns Verification result with payload or error
 */
export function verifyToken(token: string): VerifyResult | VerifyError {
  const secret = getJwtSecret();
  try {
    const decoded = jwt.verify(token, secret, {
      issuer: JWT_ISSUER,
    }) as JwtPayload;

    // Validate payload structure
    const validRoles: JwtPayload["role"][] = [
      "super_admin",
      "admin",
      "readonly_admin",
      "distributor",
      "reseller",
      "dealer",
    ];
    if (
      typeof decoded.accountId !== "string" ||
      typeof decoded.email !== "string" ||
      !validRoles.includes(decoded.role) ||
      decoded.authMethod !== "password" ||
      (decoded.resellerAccountId !== null &&
        typeof decoded.resellerAccountId !== "string") ||
      typeof decoded.sessionVersion !== "number" ||
      !Number.isInteger(decoded.sessionVersion) ||
      decoded.sessionVersion < 0
    ) {
      return {
        ok: false,
        error: {
          code: "malformed_token",
          message: "Token payload is missing required fields",
        },
      };
    }

    return {
      ok: true,
      payload: decoded,
    };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return {
        ok: false,
        error: {
          code: "expired_token",
          message: "Token has expired",
        },
      };
    }

    if (err instanceof jwt.JsonWebTokenError) {
      return {
        ok: false,
        error: {
          code: "invalid_token",
          message: "Token is invalid",
        },
      };
    }

    return {
      ok: false,
      error: {
        code: "invalid_token",
        message: "Token verification failed",
      },
    };
  }
}

// ─── Token Extraction ────────────────────────────────────────────────────────

/**
 * Extract JWT token from Authorization header.
 * Supports both "Bearer <token>" and raw token formats.
 * 
 * @param authHeader - Authorization header value
 * @returns Token string or null if not found
 */
export function extractTokenFromHeader(authHeader: string | null): string | null {
  if (!authHeader) return null;

  // Handle "Bearer <token>" format
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }

  // Handle raw token
  return authHeader;
}

/**
 * Extract JWT token from request headers.
 * 
 * @param req - Request object
 * @returns Token string or null if not found
 */
export function extractTokenFromRequest(req: Request): string | null {
  const authHeader = req.headers.get("Authorization");
  return extractTokenFromHeader(authHeader);
}
