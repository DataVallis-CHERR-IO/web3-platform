/**
 * Public names of each environment. No imports on purpose: the middleware uses
 * this module, and it must stay small.
 */
type Env = "local" | "dev" | "uat" | "prod";

/**
 * Returns the expected single origin for the current environment.
 */
export function getExpectedOrigin(appEnv: Env): string {
  switch (appEnv) {
    case "dev":
      // The dev environment is the public testnet beta (David, 2026-10-12).
      return "https://testnet.cherr.io";
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
 * Older public names an environment still answers on (the kamal-proxy `host`
 * list in `config/deploy.<env>.yml`). Pages on them redirect to the public
 * origin (`legacyHostRedirect`); API calls are still accepted there so open
 * tabs and links in older emails keep working. Public links always use
 * `getExpectedOrigin`.
 */
export const ALIAS_ORIGINS: Partial<Record<Env, readonly string[]>> = {
  dev: ["https://dev.cherr.io"],
};

/**
 * Where a page request on an older public name should go, or null.
 * `host` is the request's public host (`x-forwarded-host`, else `host`).
 */
export function legacyHostRedirect(appEnv: Env, host: string | null, pathAndQuery: string): string | null {
  if (!host) return null;
  const name = host.toLowerCase().replace(/:443$/, "");
  const alias = (ALIAS_ORIGINS[appEnv] ?? []).find((o) => o === `https://${name}`);
  if (!alias) return null;
  return `${getExpectedOrigin(appEnv)}${pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`}`;
}

