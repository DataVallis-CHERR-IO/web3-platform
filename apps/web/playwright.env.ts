/**
 * Values shared by playwright.config.ts (the E2E server's environment) and the
 * E2E helpers. This file must stay outside e2e/: that folder is not in the
 * Docker build context, and `next build` type-checks playwright.config.ts.
 */

/** Session secret of the E2E server (APP_ENV=local only); not a real secret. */
export const E2E_SESSION_SECRET = "e2e-session-secret-not-a-real-secret-0123456789abcdef";

/**
 * Where the E2E server fetches the ECB rate file (ECB_RATES_URL, honoured only
 * with APP_ENV=local). e2e/campaign-review.spec.ts serves a fixture on this port.
 */
export const E2E_ECB_PORT = 4010;

/**
 * Contract addresses of the admin console on the E2E server (APP_ENV=local has no
 * deployment file; LOCAL_* env, TASK-034b). Nothing is deployed there: the E2E fake
 * wallet answers for these addresses.
 */
export const E2E_TIMELOCK = "0x725e30EfCc66f65257130b4C63c8e986d4b3351d";
export const E2E_PLATFORM_CONFIG = "0xFdC7134BDcE8e3Ed07322eD1F90DA15297ca5e0B";
/** Admin → Emergency Pool (TASK-046): the fake wallet accepts every simulation sent to it. */
export const E2E_EMERGENCY_POOL = "0x3a108a45BdD0843612Bd55C2797B1147f06223bD";
