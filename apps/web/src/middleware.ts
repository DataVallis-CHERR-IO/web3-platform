import createMiddleware from "next-intl/middleware";
import { type NextRequest, NextResponse } from "next/server";
import { routing } from "./i18n/routing";
import { ADMIN_HEADERS, isAdminPath } from "./lib/security/admin-area";

const intlMiddleware = createMiddleware(routing);

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Skip next-intl for API routes and robots.txt — they are not localised
  if (pathname.startsWith("/api") || pathname === "/robots.txt") {
    const response = NextResponse.next();
    return applyAdminHeaders(pathname, applyNonProdHeaders(response));
  }

  const response = intlMiddleware(request);
  return applyAdminHeaders(pathname, applyNonProdHeaders(response));
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
