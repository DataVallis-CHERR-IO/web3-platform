/**
 * apps/web/e2e/impact.spec.ts
 * "My impact" (TASK-056b, ADR-057 §6): a signed-in user sees their level, what
 * is still missing for the next one, their statistics and the latest points —
 * all read from the points ledger. Signed out, the page sends you home.
 * Needs Postgres.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import * as schema from "@cherrio/db";
import { deleteTestUser, loginAsNewUser } from "./helpers/session";

async function expectNoA11yViolations(page: Page, label: string) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations, `a11y violations on ${label}`).toEqual([]);
}

type Entry = { reason: "REGISTRATION" | "FIRST_DONATION" | "DONATION" | "VOTE" | "REFERRAL"; delta: number; refKey: string; month: number };

async function seedLedger(userId: string, entries: Entry[]) {
  const client = schema.createDb(process.env.DATABASE_URL!, { max: 1 });
  try {
    await client.insert(schema.pointsLedger).values(
      entries.flatMap((e) =>
        (["STATUS", "REWARD"] as const).map((bucket) => ({
          userId, bucket, delta: BigInt(e.delta), reason: e.reason, refKey: e.refKey, ruleVersion: 2,
          createdAt: new Date(Date.UTC(2026, e.month, 15)),
        }))
      )
    );
  } finally {
    await client.$client.end();
  }
}

test.describe("My impact", () => {
  const userIds: string[] = [];

  test.afterEach(async () => {
    for (const id of userIds.splice(0)) await deleteTestUser(id);
  });

  test("signed out, the page redirects home", async ({ page }) => {
    await page.goto("/en/account/impact");
    await expect(page).toHaveURL(/\/en\/?$/);
  });

  test("a new user has no level and is told the first step", async ({ page, context }) => {
    userIds.push(await loginAsNewUser(context, "impact-new"));
    await page.goto("/en/account/impact");
    await expect(page.getByRole("heading", { level: 1, name: "My impact" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "No level yet" })).toBeVisible();
    await expect(page.getByText("To reach Level 1 · Supporter:")).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "earn 50 more points" })).toBeVisible();
    await expect(page.getByText("No points yet. Your first donation earns 100.")).toBeVisible();
  });

  test("level, missing steps, statistics and latest points come from the ledger", async ({ page, context }) => {
    const userId = await loginAsNewUser(context, "impact-giver");
    userIds.push(userId);
    // 50 + 100 + 30 + 50 + 70 + 30 + 20 = 350 points, 3 campaigns, 1 vote, 1 person; the vote is the latest.
    await seedLedger(userId, [
      { reason: "REGISTRATION", delta: 50, refKey: "registration", month: 3 },
      { reason: "FIRST_DONATION", delta: 100, refKey: "first-donation", month: 4 },
      { reason: "DONATION", delta: 30, refKey: "donation:0xaa:30", month: 4 },
      { reason: "DONATION", delta: 50, refKey: "donation:0xbb:50", month: 5 },
      { reason: "DONATION", delta: 70, refKey: "donation:0xcc:70", month: 5 },
      { reason: "VOTE", delta: 30, refKey: "vote2:0xaa:1", month: 7 },
      { reason: "REFERRAL", delta: 20, refKey: "link:0xaa:11111111-1111-4111-8111-111111111111", month: 6 },
    ]);
    await page.goto("/en/account/impact");

    const level = page.getByRole("region", { name: "Level 2 · Giver" });
    await expect(level).toBeVisible();
    await expect(level.getByText("350 status points")).toBeVisible();
    await expect(level.getByRole("progressbar", { name: "Progress to Guardian" })).toHaveAttribute("aria-valuenow", "350");
    await expect(level.getByText("To reach Level 3 · Guardian:")).toBeVisible();
    // The vote is done; points and a rating are missing.
    await expect(level.getByRole("listitem")).toHaveText([
      "earn 350 more points",
      "rate an organisation after a campaign",
    ]);

    const stats = page.getByRole("region", { name: "What you did" });
    await expect(stats.getByRole("definition")).toHaveText(["3", "0", "1", "1"]);

    const recent = page.getByRole("region", { name: "Latest points" });
    await expect(recent.getByRole("listitem")).toHaveCount(7);
    await expect(recent.getByRole("listitem").first()).toContainText("Milestone vote");
    await expect(recent.getByText("Reward points: 350.", { exact: false })).toBeVisible();

    await expectNoA11yViolations(page, "/en/account/impact");
    // The account side menu (TASK-058) shows the same level and marks the current page.
    const menu = page.getByRole("navigation", { name: "Account navigation" });
    await expect(menu.getByRole("link", { name: "My impact" })).toHaveAttribute("aria-current", "page");
    await page.goto("/en/account");
    await expect(page.getByRole("navigation", { name: "Account navigation" }).getByRole("link", { name: "My account" })).toHaveAttribute("aria-current", "page");
    await page.getByRole("link", { name: "Level 2 · Giver" }).click();
    await expect(page).toHaveURL(/\/en\/account\/impact$/);
    const name = `impact-${test.info().project.name}.png`;
    const file = test.info().outputPath(name);
    await page.screenshot({ path: file, fullPage: true });
    await test.info().attach(name, { path: file, contentType: "image/png" });
  });
});
