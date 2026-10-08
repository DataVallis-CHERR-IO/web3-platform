/**
 * apps/web/e2e/account-nav.spec.ts
 * TASK-058 (David 2026-10-08): the account area has its own side menu (a tab row
 * on phones) and the campaign share box is a compact link + copy + icon row.
 * Both themes are checked with axe (WCAG 2.1 AA) and screenshotted. Needs Postgres.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import * as schema from "@cherrio/db";
import { createApprovedOrganization, deleteTestUser, loginAsNewUser } from "./helpers/session";

async function expectNoA11yViolations(page: Page, label: string) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations, `a11y violations on ${label}`).toEqual([]);
}

async function shot(page: Page, name: string) {
  const file = test.info().outputPath(`${name}-${test.info().project.name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await test.info().attach(name, { path: file, contentType: "image/png" });
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`[${theme}] account menu and share box`, () => {
    const userIds: string[] = [];

    test.beforeEach(async ({ context }) => {
      await context.addCookies([{ name: "theme", value: theme, domain: "localhost", path: "/" }]);
    });

    test.afterEach(async () => {
      for (const id of userIds.splice(0)) await deleteTestUser(id);
    });

    test("every account page has the side menu with the current page marked", async ({ page, context }) => {
      userIds.push(await loginAsNewUser(context, `nav-${theme}-${test.info().project.name}-${Date.now()}`));
      for (const [path, name] of [
        ["/en/account/donations", "My donations"],
        ["/en/account/notifications", "Email notifications"],
        ["/en/account/organization", "My organisation"],
        ["/en/account/campaigns", "My campaigns"],
        ["/en/account", "My account"],
      ] as const) {
        await page.goto(path);
        const menu = page.getByRole("navigation", { name: "Account navigation" });
        await expect(menu.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
        await expect(menu.locator('[aria-current="page"]')).toHaveCount(1);
      }
      await expect(page.getByRole("link", { name: "No level yet" })).toHaveAttribute("href", "/en/account/impact");
      await expectNoA11yViolations(page, `/en/account [${theme}]`);
      // No horizontal page scroll on phones: the tab row scrolls by itself.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await shot(page, `account-${theme}`);
    });

    test("the share box: personal link with copy, network icons, the reward", async ({ page, context }) => {
      const run = `${theme}-${test.info().project.name}-${Date.now()}`;
      const userId = await loginAsNewUser(context, `share-${run}`);
      userIds.push(userId);
      const orgId = await createApprovedOrganization(userId, `E2E Share Box Org ${run}`);
      const slug = `e2e-share-box-${run}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const client = schema.createDb(process.env.DATABASE_URL!, { max: 1 });
      try {
        await client.insert(schema.campaigns).values({
          orgId, starterUserId: userId, beneficiaryType: "ORGANIZATION", title: `E2E Share Box ${run}`, slug,
          story: { format: "plain", text: "A campaign for the share box test." }, cause: "community", country: "SI",
          targetEurCents: "1000000", durationDays: 30, status: "DEPLOYED", eurUsdRate: "1.17000000", rateSource: "ECB",
          rateAt: new Date(), targetUsdc: 11_700_000_000n, beneficiaryAddress: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
          deadline: new Date(Date.now() + 10 * 86_400_000), onchainAddress: `0x${randomBytes(20).toString("hex")}`,
          submittedAt: new Date(), deployedAt: new Date(),
        });
      } finally {
        await client.$client.end();
      }
      await page.goto(`/en/campaigns/${slug}`);
      const box = page.getByRole("region", { name: "Share this campaign" });
      await expect(box.getByText("+20 points")).toBeVisible();
      await expect(box.locator(".ch-share-url")).toHaveText(new RegExp(`/en/campaigns/${slug}\\?ref=[a-z0-9]{8}$`));
      await expect(box.getByRole("button", { name: "Copy link" })).toBeVisible();
      await expect(box.getByRole("link", { name: /^Share on / })).toHaveCount(6);
      // Compact: the six networks are one row of icons (was two rows of buttons plus two full-width buttons).
      const tops = await box.getByRole("link", { name: /^Share on / }).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
      expect(new Set(tops).size).toBe(1);
      await expectNoA11yViolations(page, `campaign share box [${theme}]`);
      await box.scrollIntoViewIfNeeded();
      const file = test.info().outputPath(`share-${theme}-${test.info().project.name}.png`);
      await box.screenshot({ path: file });
      await test.info().attach(`share-${theme}`, { path: file, contentType: "image/png" });
    });
  });
}
