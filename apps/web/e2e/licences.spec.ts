/**
 * apps/web/e2e/licences.spec.ts
 * The licences page carries the notices the Reown/WalletConnect and MetaMask
 * SDK licences require (THIRD_PARTY_NOTICES.md), is linked from the footer,
 * and passes axe.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("footer → licences page with the required third-party notices", async ({ page }) => {
  await page.goto("/en");
  await page.getByRole("contentinfo").getByRole("link", { name: "Licences" }).click();
  await expect(page).toHaveURL(/\/en\/licences$/);
  await expect(page.getByRole("heading", { level: 1, name: "Licences" })).toBeVisible();
  await expect(page.getByText("Portions © 2025 Reown, Inc. All Rights Reserved.")).toHaveCount(2);
  await expect(page.getByText("This product uses the MetaMask SDK, © ConsenSys Software Inc.")).toBeVisible();
  await expect(page.getByRole("link", { name: "MIT licence" })).toHaveAttribute("href", /\/LICENSE$/);
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations).toEqual([]);
});

test("every footer link keeps the locale prefix and opens a page", async ({ page }) => {
  await page.goto("/en");
  const links = page.getByRole("contentinfo").getByRole("navigation").getByRole("link");
  const hrefs = await links.evaluateAll((els) => els.map((el) => el.getAttribute("href")));
  expect(hrefs.length).toBeGreaterThanOrEqual(4);
  for (const href of hrefs) {
    expect(href, `footer link ${href}`).toMatch(/^\/en\//);
    const res = await page.goto(href!);
    expect(res?.status(), `footer link ${href}`).toBe(200);
  }
});
