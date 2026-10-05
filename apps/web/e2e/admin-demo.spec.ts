/**
 * apps/web/e2e/admin-demo.spec.ts
 * TASK-038a (ADR-052): Admin → Demo campaigns. The page is hidden from
 * non-admins (404), renders for an admin with no accessibility violations, and
 * the form refuses an invalid wallet address before calling the API.
 * Creating campaigns is covered by src/__tests__/demo-campaigns.test.ts
 * (needs the ECB stub, which campaign-review.spec.ts owns in E2E).
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { deleteTestUser, loginAsNewUser } from "./helpers/session";

test("a non-admin gets 404 on the demo page", async ({ page, context }, info) => {
  const userId = await loginAsNewUser(context, `demo-user-${info.project.name}`);
  try {
    const response = await page.goto("/en/admin/demo");
    expect(response?.status()).toBe(404);
  } finally {
    await deleteTestUser(userId);
  }
});

test("an admin sees the demo form, accessible, and an invalid wallet is refused", async ({ page, context }, info) => {
  const adminId = await loginAsNewUser(context, `demo-admin-${info.project.name}-${Date.now()}`, { admin: true });
  try {
    await page.goto("/en/admin");
    await page.getByRole("link", { name: "Demo campaigns" }).click();
    await expect(page).toHaveURL(/\/en\/admin\/demo$/);
    await expect(page.getByRole("heading", { level: 1, name: "Demo campaigns" })).toBeVisible();
    await expect(page.getByText("At most 10 per batch")).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations, "a11y violations on /en/admin/demo").toEqual([]);

    await page.getByLabel("How many (1–10)").fill("3");
    await page.getByLabel("Payout wallet").fill("0x1234");
    await page.getByRole("button", { name: "Create 3 demo campaigns" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "wallet address" })).toBeVisible();
  } finally {
    await deleteTestUser(adminId);
  }
});
