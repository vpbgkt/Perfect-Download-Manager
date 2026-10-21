/**
 * Next.js proxy — protected-route gate.
 *
 * Since authentication is now JWT-based with tokens stored in sessionStorage
 * (client-side only), the proxy cannot verify authentication. Instead, all
 * application routes are allowed through, and authentication is enforced
 * client-side by the SessionProvider component, which redirects unauthenticated
 * users to /login.
 *
 * This proxy now only serves to define which routes should not trigger
 * client-side redirects (truly public routes like the login page itself).
 *
 * Requirements: 1.1
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/** The login page unauthenticated users are redirected to. */
const LOGIN_PATH = "/login";

/**
 * Path prefixes that are truly public and should never redirect.
 * All other routes are allowed through but will be checked client-side.
 */
const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  "/api/health",
  // Public, unauthenticated read models consumed by the marketing site
  // (Req 9.5) and crawlers.
  "/api/seo/public",
  "/robots.txt",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

export function proxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // All routes pass through - authentication is handled client-side
  // API routes without proper JWT will get 401 from the route handlers
  return NextResponse.next();
}

/**
 * Run the proxy on everything except Next.js internals and common static
 * assets.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|ico|webp)$).*)"],
};
