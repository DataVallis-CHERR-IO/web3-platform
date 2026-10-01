import { parseAppEnv, type AppEnv } from "@cherrio/shared";

/**
 * Returns the expected single origin for the current environment.
 */
export function getExpectedOrigin(appEnv: AppEnv): string {
  switch (appEnv) {
    case "dev":
      return "https://dev.cherr.io";
    case "uat":
      return "https://uat.cherr.io";
    case "prod":
      return "https://cherr.io";
    case "local":
    default:
      return "http://localhost:3000";
  }
}

/**
 * Verifies that a mutating request originates from this environment's own origin.
 * Strict per-environment origin check:
 *   - dev: https://dev.cherr.io
 *   - uat: https://uat.cherr.io
 *   - prod: https://cherr.io
 *   - local: http://localhost:3000 (and localhost ports in local/test)
 */
export function verifyOrigin(request: Request): boolean {
  const rawEnv = process.env.APP_ENV ?? "local";
  let appEnv: AppEnv = "local";
  try {
    appEnv = parseAppEnv(rawEnv);
  } catch {
    appEnv = "local";
  }

  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const expected = getExpectedOrigin(appEnv);

  if (appEnv === "local") {
    if (origin) {
      return (
        origin === expected ||
        origin === "http://127.0.0.1:3000" ||
        origin.startsWith("http://localhost:") ||
        origin.startsWith("http://127.0.0.1:")
      );
    }
    if (referer) {
      return (
        referer.startsWith(expected) ||
        referer.startsWith("http://127.0.0.1:3000") ||
        referer.startsWith("http://localhost:") ||
        referer.startsWith("http://127.0.0.1:")
      );
    }
    return true;
  }

  if (origin) {
    return origin === expected;
  }

  if (referer) {
    return referer === expected || referer.startsWith(`${expected}/`);
  }

  return false;
}
