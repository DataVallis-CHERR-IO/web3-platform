import { parseAppEnv, type AppEnv } from "@cherrio/shared/env";
import { ALIAS_ORIGINS, getExpectedOrigin, legacyHostRedirect } from "./hosts";

export { getExpectedOrigin, legacyHostRedirect };

/** Every origin a deployed environment accepts on mutating requests. */
export function getAllowedOrigins(appEnv: AppEnv): string[] {
  return [getExpectedOrigin(appEnv), ...(ALIAS_ORIGINS[appEnv] ?? [])];
}

/**
 * Verifies that a mutating request originates from this environment's own origin.
 * Strict per-environment origin check:
 *   - dev: https://testnet.cherr.io (and its older name https://dev.cherr.io)
 *   - uat: https://uat.cherr.io
 *   - prod: https://app.cherr.io
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

  const allowed = getAllowedOrigins(appEnv);

  if (origin) {
    return allowed.includes(origin);
  }

  if (referer) {
    return allowed.some((o) => referer === o || referer.startsWith(`${o}/`));
  }

  return false;
}
