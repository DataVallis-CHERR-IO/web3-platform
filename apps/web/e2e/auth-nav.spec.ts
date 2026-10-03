import { test, expect } from "@playwright/test";

test.describe("Navigation and coming-soon pages", () => {
  // /en/campaigns is a real page since TASK-011a (e2e/campaign-pages.spec.ts).
  const NAV_PATHS = [
    "/en/charity-market-cap",
    "/en/emergency-pool",
    "/en/how-it-works",
    "/en/about",
    "/en/docs",
  ];

  for (const path of NAV_PATHS) {
    test(`nav link ${path} returns 200 and renders Coming Soon`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.locator("h1")).toBeVisible();
      await expect(page.getByRole("link", { name: /Back to Home/i })).toBeVisible();
    });
  }

  test("nav link /en/campaigns returns 200 and renders the campaign list", async ({ page }) => {
    const response = await page.goto("/en/campaigns");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Campaigns" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Back to Home/i })).toHaveCount(0);
  });
});

test.describe("Auth guards and header", () => {
  test("/en/account redirects to /en when logged out", async ({ page }) => {
    await page.goto("/en/account");
    await page.waitForURL("**/en");
    expect(page.url()).toMatch(/\/en\/?$/);
  });

  test("/en/admin returns 404 when logged out", async ({ page }) => {
    const response = await page.goto("/en/admin");
    expect(response?.status()).toBe(404);
  });

  test("header Log in button is present", async ({ page }) => {
    await page.goto("/en");
    const isSmall = (page.viewportSize()?.width ?? 1440) < 768;
    if (isSmall) {
      await page.locator(".ch-header-burger").click();
    }
    const loginButton = page.getByRole("button", { name: "Log in" }).first();
    await expect(loginButton).toBeVisible();
  });
});
