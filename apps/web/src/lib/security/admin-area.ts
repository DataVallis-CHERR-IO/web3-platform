import { routing } from "@/i18n/routing";

// The admin area (TASK-035, David 2026-10-04): only platform owners use it, so
// for everyone else — people, search engines, AI crawlers — it must look like
// it does not exist. Pages and routes answer 404 to non-admins (own check +
// admin/layout.tsx); the middleware adds these headers to every admin response
// in every environment, prod included.

const LOCALES = routing.locales.join("|");
const ADMIN_PATH = new RegExp(`^(?:/(?:${LOCALES}))?/admin(?:/|$)|^/api/admin(?:/|$)`);

/** /en/admin…, /admin… (before the locale redirect) and /api/admin…. */
export function isAdminPath(pathname: string): boolean {
  return ADMIN_PATH.test(pathname);
}

export const ADMIN_HEADERS: Readonly<Record<string, string>> = {
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
  "Cache-Control": "private, no-store",
};
