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
      return "https://app.cherr.io";
    case "local":
    default:
      return "http://localhost:3000";
  }
}

/**
 * Extra public hostnames an environment also answers on (the kamal-proxy
 * `hosts` list in `config/deploy.<env>.yml`). The dev environment is the public
 * testnet beta, so it also serves https://testnet.cherr.io. Public links
 * (emails, previews, share links) keep using `getExpectedOrigin`.
 */
const ALIAS_ORIGINS: Partial<Record<AppEnv, readonly string[]>> = {
  dev: ["https://testnet.cherr.io"],
};

/** Every origin a deployed environment accepts on mutating requests. */
export function getAllowedOrigins(appEnv: AppEnv): string[] {
  return [getExpectedOrigin(appEnv), ...(ALIAS_ORIGINS[appEnv] ?? [])];
}

/**
 * Verifies that a mutating request originates from this environment's own origin.
 * Strict per-environment origin check:
 *   - dev: https://dev.cherr.io (and its alias https://testnet.cherr.io)
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
