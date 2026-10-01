/**
 * apps/web/e2e/a11y.spec.ts
 * Playwright + axe-core tests:
 *   1. Accessibility — zero violations on /en and /en/dev/ui (light + dark)
 *   2. No Google Fonts — zero runtime requests to fonts.googleapis.com
 *   3. Screenshots — light/dark × 1440/390 for both pages
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PAGES = [
  { name: "home", url: "/en" },
  { name: "gallery", url: "/en/dev/ui" },
  { name: "campaigns", url: "/en/campaigns" },
  { name: "cmc", url: "/en/charity-market-cap" },
  { name: "emergency-pool", url: "/en/emergency-pool" },
  { name: "how-it-works", url: "/en/how-it-works" },
  { name: "about", url: "/en/about" },
  { name: "docs", url: "/en/docs" },
];

const THEMES: Array<{ name: "light" | "dark"; cookie: string }> = [
  { name: "light", cookie: "light" },
  { name: "dark",  cookie: "dark" },
];

for (const { name: pageName, url } of PAGES) {
  for (const { name: theme, cookie } of THEMES) {
    test(`[${theme}] ${pageName}: no a11y violations`, async ({ page }) => {
      // Set theme cookie before navigation
      await page.context().addCookies([
        { name: "theme", value: cookie, domain: "localhost", path: "/" },
      ]);

      await page.goto(url, { waitUntil: "load" });

      const results = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();

      expect(results.violations, `a11y violations on ${url} [${theme}]`).toEqual([]);
    });

    test(`[${theme}] ${pageName}: screenshot`, async ({ page, browserName: _b }, testInfo) => {
      await page.context().addCookies([
        { name: "theme", value: cookie, domain: "localhost", path: "/" },
      ]);

      await page.goto(url, { waitUntil: "load" });

      const projectName = testInfo.project.name; // chromium-1440 or chromium-390
      const screenshotName = `${pageName}-${theme}-${projectName}.png`;
      const screenshotPath = path.join(
        __dirname,
        "screenshots",
        screenshotName,
      );

      await page.screenshot({ path: screenshotPath, fullPage: true });
      // Attach to Playwright report
      await testInfo.attach(screenshotName, { path: screenshotPath, contentType: "image/png" });
    });
  }
}

test("no horizontal scroll at 360px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/en", { waitUntil: "load" });

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth, "page should not scroll horizontally at 360px").toBeLessThanOrEqual(clientWidth);
});

test("no requests to fonts.googleapis.com on any page", async ({ page }) => {
  const googleFontRequests: string[] = [];

  page.on("request", (req) => {
    if (req.url().includes("fonts.googleapis.com")) {
      googleFontRequests.push(req.url());
    }
  });

  for (const { url } of PAGES) {
    await page.goto(url, { waitUntil: "load" });
  }

  expect(
    googleFontRequests,
    `Found runtime requests to fonts.googleapis.com:\n${googleFontRequests.join("\n")}`,
  ).toHaveLength(0);
});
