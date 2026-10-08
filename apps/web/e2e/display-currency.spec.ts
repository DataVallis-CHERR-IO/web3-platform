/**
 * apps/web/e2e/display-currency.spec.ts
 * Display currency (ADR-040): the default follows the browser's language and
 * region (de-CH → CHF); choosing another currency in the header converts the
 * amounts, keeps the exact original next to them and survives a reload.
 * Rates are written into app.fx_rates (never fetched in tests). Needs Postgres.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createApprovedOrganization, createSubmittedCampaign, deleteTestUser, loginAsNewUser, setFxRates } from "./helpers/session";

async function expectNoA11yViolations(page: Page, label: string) {
  await expect(page).toHaveTitle(/\S/);
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations, `a11y violations on ${label}`).toEqual([]);
}

test.use({ locale: "de-CH" });

test.describe("display currency", () => {
  let adminId = "";
  test.afterEach(async () => {
    if (adminId) await deleteTestUser(adminId);
  });

  test("defaults to the browser region, converts on choice, keeps the original", async ({ page, context }, info) => {
    // 1 EUR = 1.1734 USD, 1 CHF = 1.25 USD, 1 BTC = 64,000 USD → €12,000 = 14,080.80 USD = CHF 11,264.64 (shown ≈ CHF 11,265: whole units from 1,000) = 0.2200125 BTC
    await setFxRates([
      { currency: "EUR", usdPerUnit: "1.1734", source: "ECB" },
      { currency: "CHF", usdPerUnit: "1.25", source: "ECB" },
      { currency: "BTC", usdPerUnit: "64000", source: "COINGECKO" },
    ]);
    const run = `${info.project.name}-${Date.now()}`;
    adminId = await loginAsNewUser(context, `fx-admin-${run}`, { admin: true });
    const orgId = await createApprovedOrganization(adminId, `E2E FX Org ${run}`);
    const campaignId = await createSubmittedCampaign(adminId, orgId, `E2E fx ${run}`, `campaigns/e2e-${run}/c.webp`);

    await page.goto(`/en/admin/campaigns/${campaignId}`);
    const target = page.getByRole("row", { name: /Target/ }).first();
    // The server keeps rates in memory for 30 s (lib/fx/rates.ts): a spec that ran just
    // before may have loaded rates without CHF. Reload until the fresh rows are read.
    await expect(async () => {
      await page.reload();
      await expect(target).toContainText("≈ CHF 11,265", { timeout: 2_000 });
    }).toPass({ timeout: 45_000 });
    await expect(target).toContainText("(€12,000)");

    // On a phone the selector is in the menu.
    const mobile = info.project.name.endsWith("390");
    if (mobile) await page.getByRole("button", { name: "Open menu" }).click();
    const select = page.getByRole("combobox", { name: "Currency" });
    await expect(select).toContainText("CHF");
    await expectNoA11yViolations(page, "/en/admin/campaigns/[id] (CHF)");

    await select.click();
    await page.getByRole("option", { name: /^BTC/ }).click();
    await expect(target).toContainText("≈ 0.2200125 BTC");
    await expect(target).toContainText("(€12,000)");

    await page.reload();
    await expect(page.getByRole("row", { name: /Target/ }).first()).toContainText("≈ 0.2200125 BTC");

    // EUR is the target's own currency: exact, without "≈".
    if (mobile) await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("combobox", { name: "Currency" }).click();
    await page.getByRole("option", { name: /^EUR/ }).click();
    await expect(page.getByRole("row", { name: /Target/ }).first()).toHaveText(/€12,000$/);
    await expect(page.getByRole("row", { name: /Target/ }).first()).not.toContainText("≈");
  });
});
