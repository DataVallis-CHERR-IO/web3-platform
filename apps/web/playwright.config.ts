/**
 * apps/web/playwright.config.ts
 * Playwright configuration for a11y + design regression tests.
 * Runs against `next start` (port 3000); CI builds beforehand, locally the webServer builds first.
 */
import { defineConfig, devices } from "@playwright/test";
// Not from ./e2e: that folder is outside the Docker build context, and next build type-checks this file.
import { E2E_ECB_PORT, E2E_SESSION_SECRET } from "./playwright.env";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/screenshots",
  timeout: 60_000,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",

  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },

  projects: [
    {
      name: "chromium-1440",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: "chromium-390",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 390, height: 844 },
      },
    },
  ],

  // Start Next.js production server before running tests
  webServer: {
    // CI builds in a separate workflow step; locally we build here.
    command: process.env.CI ? "pnpm start" : "pnpm build && pnpm start",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      // `local`: /dev/ui renders, the origin check accepts localhost (the
      // logged-in tests POST from the browser), and storage is the local s3mock.
      APP_ENV: "local",
      SESSION_SECRET: E2E_SESSION_SECRET,
      // The public fake key from apps/web/.env.example.
      PRIVATE_FILES_KEY: "Y2hlcnJpby1sb2NhbC1kZXYta2V5LW5vdC1zZWNyZXQ=",
      // The ECB rate file, served from a fixture by e2e/campaign-review.spec.ts (never the live ECB in tests).
      ECB_RATES_URL: `http://127.0.0.1:${E2E_ECB_PORT}/eurofxref-daily.xml`,
      // Crypto prices (ADR-040): never CoinGecko in tests. Nothing listens here, so a refresh fails at once;
      // e2e/display-currency.spec.ts writes the rates into app.fx_rates instead.
      COINGECKO_URL: "http://127.0.0.1:9/simple/price",
    },
  },
});
