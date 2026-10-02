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
