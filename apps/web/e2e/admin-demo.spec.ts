/**
 * apps/web/e2e/admin-demo.spec.ts
 * TASK-038a (ADR-052): Admin → Demo campaigns. The page is hidden from
 * non-admins (404), renders for an admin with no accessibility violations, and
 * the form refuses an invalid wallet address and a batch over 10 campaigns
 * before calling the API (TASK-040a: organisations × campaigns per organisation).
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
    await page.getByRole("navigation", { name: "Admin menu" }).getByRole("link", { name: "Demo campaigns", exact: true }).click();
    await expect(page).toHaveURL(/\/en\/admin\/demo$/);
    await expect(page.getByRole("heading", { level: 1, name: "Demo campaigns" })).toBeVisible();
    await expect(page.getByText("At most 10 campaigns per batch")).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations, "a11y violations on /en/admin/demo").toEqual([]);

    // TASK-043: the cover model is a choice; the cheaper FLUX.2 [pro] is preselected.
    const models = page.getByRole("group", { name: "Cover images" }).first();
    await expect(models.getByLabel(/^FLUX\.2 \[pro\]/)).toBeChecked();
    await expect(models.getByLabel(/^Nano Banana Pro/)).not.toBeChecked();
    await models.getByLabel(/^Nano Banana Pro/).check();
    await expect(models.getByLabel(/^Nano Banana Pro/)).toBeChecked();

    await page.getByLabel("New demo organisations (0–5)").fill("3");
    await page.getByLabel("Campaigns per organisation (1–5)").fill("2");
    await expect(page.getByText("6 campaigns in this batch (at most 10).")).toBeVisible();
    await page.getByLabel("In review — you review and approve them like real ones").check();
    await page.getByLabel("Payout wallet").fill("0x1234");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "wallet address" })).toBeVisible();

    // More than 10 campaigns is refused in the form, before the API.
    await page.getByLabel("Payout wallet").fill("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");
    await page.getByLabel("New demo organisations (0–5)").fill("5");
    await page.getByLabel("Campaigns per organisation (1–5)").fill("3");
    await page.getByRole("button", { name: "Create", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "more than 10 campaigns" })).toBeVisible();
  } finally {
    await deleteTestUser(adminId);
  }
});
