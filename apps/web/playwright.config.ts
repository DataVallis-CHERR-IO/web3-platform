/**
 * apps/web/playwright.config.ts
 * Playwright configuration for a11y + design regression tests.
 * Runs against `next start` (port 3000); CI builds beforehand, locally the webServer builds first.
 */
import { defineConfig, devices } from "@playwright/test";

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
      APP_ENV: "dev", // allow /dev/ui to render
    },
  },
});
