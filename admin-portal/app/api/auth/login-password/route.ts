/**
 * `POST /api/auth/login-password` — authenticate distributor/reseller/dealer
 * accounts using email and password.
 *
 * Flow:
 *  1. Validate email and password format.
 *  2. Authenticate via authenticator.authenticatePassword method.
 *  3. On success, generate JWT token and return account information.
 *  4. On failure, return uniform authentication_failed error.
 *
 * This endpoint differs from the Firebase-based admin login:
 *  - No Firebase ID token required (this IS the login endpoint)
 *  - No OTP/MFA required (password is the credential)
 *  - Returns JWT token for subsequent API calls
 *
 * @module app/api/auth/login-password/route
 */

import { NextResponse } from "next/server";
import { getServerContext } from "@/lib/server-context.ts";
import { readJsonBody } from "@/lib/http.ts";
import { signToken } from "@/lib/jwt.ts";

// Force Node.js runtime (required for bcrypt and JWT)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/auth/login-password — authenticate with email and password.
 */
export async function POST(req: Request): Promise<NextResponse> {
  try {
    const body = await readJsonBody(req);

    const { authenticator } = getServerContext();

    // 1. Validate input format
    const email = body?.email;
    const password = body?.password;

    console.log("[login-password] Attempt for email:", email);

    if (!email || typeof email !== "string" || email.trim().length === 0) {
      return NextResponse.json(
        { error: "validation_error", field: "email", message: "Email is required" },
        { status: 400 }
      );
    }

    if (!password || typeof password !== "string" || password.length === 0) {
      return NextResponse.json(
        { error: "validation_error", field: "password", message: "Password is required" },
        { status: 400 }
      );
    }

    // 2. Authenticate via password
    console.log("[login-password] Calling authenticator.authenticatePassword...");
    const result = await authenticator.authenticatePassword({
      email: email.trim(),
      password,
    });

    console.log("[login-password] Authenticator result:", { ok: result.ok, error: result.ok ? null : result.error });

    if (!result.ok) {
      console.error("[login-password] Authentication failed:", result.error);
      // Uniform failure response - never disclose which field was wrong
      return NextResponse.json(
        {
          error: result.error.code,
          message: result.error.message,
        },
        { status: 401 }
      );
    }

    // 3. Generate JWT token
    const principal = result.value;
    
    console.log("[login-password] Generating JWT for:", principal.identity);
    
    const token = signToken({
      accountId: principal.identity,
      email: email.trim().toLowerCase(),
      role: principal.role as any, // Support all roles: super_admin, admin, distributor, reseller, dealer
      resellerAccountId: principal.resellerAccountId || principal.identity,
      sessionVersion: principal.sessionVersion ?? 0,
    });

    console.log("[login-password] Authentication successful for:", principal.identity);

    // 4. Return successful authentication with JWT token
    return NextResponse.json({
      success: true,
      token,
      account: {
        accountId: principal.identity,
        resellerAccountId: principal.resellerAccountId,
        role: principal.role,
        authMethod: principal.authMethod,
      },
    });
  } catch (error) {
    console.error("[login-password] Unexpected error:", error);
    return NextResponse.json(
      { error: "internal_error", message: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
