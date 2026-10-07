import createMiddleware from "next-intl/middleware";
import { type NextRequest, NextResponse } from "next/server";
import { routing } from "./i18n/routing";
import { ADMIN_HEADERS, isAdminPath } from "./lib/security/admin-area";
import { REF_COOKIE, REF_COOKIE_MAX_AGE, firstTouchRefCode } from "./lib/referral-cookie";

const intlMiddleware = createMiddleware(routing);

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip next-intl for API routes and robots.txt — they are not localised
  if (pathname.startsWith("/api") || pathname === "/robots.txt") {
    const response = NextResponse.next();
    return applyAdminHeaders(pathname, applyNonProdHeaders(response));
  }

  const response = intlMiddleware(request);
  applyReferralCookie(request, response);
  return applyAdminHeaders(pathname, applyNonProdHeaders(response));
}

/** `?ref=<code>` on any page: first-touch share cookie for 30 days (ADR-057 §5, TASK-055). */
function applyReferralCookie(request: NextRequest, response: NextResponse): void {
  const code = firstTouchRefCode(request.nextUrl.searchParams.get("ref"), request.cookies.get(REF_COOKIE)?.value);
  if (!code) return;
  response.cookies.set(REF_COOKIE, code, {
    maxAge: REF_COOKIE_MAX_AGE,
    httpOnly: true,
    sameSite: "lax",
    secure: (process.env.APP_ENV ?? "prod") !== "local", // unset = prod, as in applyNonProdHeaders
    path: "/",
  });
}

/** Every environment: the admin area is never indexed, archived or cached (TASK-035). */
function applyAdminHeaders(pathname: string, response: NextResponse): NextResponse {
  if (isAdminPath(pathname)) {
    for (const [name, value] of Object.entries(ADMIN_HEADERS)) response.headers.set(name, value);
  }
  return response;
}

/** Non-prod: tell crawlers to stay away. */
function applyNonProdHeaders(response: NextResponse): NextResponse {
  const env = process.env.APP_ENV ?? "prod";
  if (env !== "prod") {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return response;
}

export const config = {
  // Match all paths except Next.js internals and static files
  matcher: ["/", "/(en)/:path*", "/api/:path*", "/robots.txt"],
};
