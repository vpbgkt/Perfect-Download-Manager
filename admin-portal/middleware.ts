/**
 * Next.js middleware — protected-route gate.
 *
 * Redirects unauthenticated access to any protected route to the login page
 * (Req 1.1). Because the VPS is stateless and identity is delegated to
 * Firebase, this edge check is a lightweight **presence** check for the
 * session cookie opened by `POST /api/auth/otp/verify`. Authoritative
 * verification (Firebase ID-token validity, 30-minute idle expiry, logout
 * invalidation) still happens server-side in the Route Handlers / auth
 * middleware on every request — this gate only spares unauthenticated users a
 * blank protected page and sends them to `/login`.
 *
 * Public paths (the login page, the auth Route Handlers, the health check, and
 * Next.js static assets) are always allowed through.
 *
 * Requirements: 1.1
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "./lib/http.ts";

/** The login page unauthenticated users are redirected to. */
const LOGIN_PATH = "/login";

/**
 * Path prefixes that never require an authenticated session. The auth Route
 * Handlers must be reachable so a user can actually log in; the health probe is
 * intentionally public.
 */
const PUBLIC_PREFIXES = [
  "/login",
  "/verify-otp",
  "/api/auth",
  "/api/health",
  // Public, unauthenticated read models consumed by the marketing site
  // (Req 9.5) and crawlers. These must never redirect to login.
  "/api/seo/public",
  "/robots.txt",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  if (hasSession) {
    return NextResponse.next();
  }

  // Unauthenticated access to a protected route → redirect to the login page,
  // preserving the intended destination so the app can return there post-login.
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = LOGIN_PATH;
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

/**
 * Run the middleware on everything except Next.js internals and common static
 * assets. Public application paths are handled by {@link isPublicPath} above.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|ico|webp)$).*)"],
};
