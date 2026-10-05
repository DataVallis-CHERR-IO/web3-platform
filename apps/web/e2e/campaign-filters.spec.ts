/**
 * apps/web/e2e/campaign-filters.spec.ts
 * Shop-style filters on the public campaign list (TASK-039, TASK-042):
 * wide screens — a sidebar of checkbox groups that update the list at once;
 * phones — a "Filters" button that opens the same groups in a bottom sheet.
 * Several values in a group match any of them; active filters show as
 * removable tags; no match shows the empty state; unknown URL values are
 * ignored. axe on a filtered page and on the open sheet.
 * Kiribati and Palau: countries no other spec uses. Needs Postgres.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Locator, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import * as schema from "@cherrio/db";
import { ensureFakeChain } from "../src/__tests__/helpers/fake-chain";
import { createApprovedOrganization, deleteTestUser } from "./helpers/session";

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("E2E needs DATABASE_URL");
  return schema.createDb(url, { max: 1 });
}

async function expectNoA11yViolations(page: Page, label: string) {
  await expect(page).toHaveTitle(/\S/);
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations, `a11y violations on ${label}`).toEqual([]);
}

/** Ticks an option, opening "Show all" first when the option is collapsed away. */
async function tick(panel: Locator, name: RegExp) {
  const box = panel.getByRole("checkbox", { name });
  if ((await box.count()) === 0) await panel.getByRole("button", { name: /^Show all \d+$/ }).first().click();
  // The real input is visually hidden behind its styled label.
  await panel.getByRole("checkbox", { name }).check({ force: true });
}

test.describe("campaign list filters", () => {
  let ownerId = "";

  test.afterEach(async () => {
    if (ownerId) await deleteTestUser(ownerId);
  });

  test("filter by cause and country, remove a tag, empty state, unknown values", async ({ page }, info) => {
    const mobile = (page.viewportSize()?.width ?? 1440) <= 1024;
    const run = `${info.project.name}-${Date.now()}`;
    const titles = {
      kiAnimals: `E2E filter KI animals ${run}`,
      kiClimate: `E2E filter KI climate ${run}`,
      pwClimate: `E2E filter PW climate ${run}`,
    };
    const client = db();
    try {
      await ensureFakeChain(client);
      const [owner] = await client
        .insert(schema.users)
        .values({ displayName: `E2E filter owner ${run}`, privyDid: `privy|e2e-filter-${run}` })
        .returning({ id: schema.users.id });
      ownerId = owner!.id;
      const orgId = await createApprovedOrganization(ownerId, `E2E Filter Org ${run}`);
      const rows: [string, string, string, number][] = [
        [titles.kiAnimals, "animals", "KI", 5],
        [titles.kiClimate, "climate", "KI", 6],
        [titles.pwClimate, "climate", "PW", 7],
      ];
      for (const [title, cause, country, days] of rows) {
        await client.insert(schema.campaigns).values({
          orgId, starterUserId: ownerId, beneficiaryType: "ORGANIZATION", title,
          slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          story: { format: "plain", text: "A campaign for the filter test." },
          cause, country, targetEurCents: "1000000", durationDays: 30, status: "DEPLOYED",
          eurUsdRate: "1.17000000", rateSource: "ECB", rateAt: new Date(), targetUsdc: 11_700_000_000n,
          beneficiaryAddress: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
          deadline: new Date(Date.now() + days * 86_400_000),
          onchainAddress: `0x${randomBytes(20).toString("hex")}`,
          submittedAt: new Date(), deployedAt: new Date(),
        });
      }
    } finally {
      await client.$client.end();
    }

    const card = (title: string) => page.getByRole("link", { name: title });
    const total = page.locator(".ch-results-total");

    // Start from a country in the URL: both Kiribati campaigns, not the Palau one.
    await page.goto("/en/campaigns?country=KI");
    await expect(card(titles.kiAnimals)).toBeVisible();
    await expect(card(titles.kiClimate)).toBeVisible();
    await expect(card(titles.pwClimate)).toHaveCount(0);
    await expect(total).toHaveText("2 campaigns");
    await expect(page.getByRole("link", { name: "Remove filter: Kiribati" })).toBeVisible();

    let panel: Locator;
    if (mobile) {
      await expect(page.getByRole("complementary", { name: "Filters" })).toBeHidden();
      await page.getByRole("button", { name: "Filters (1)" }).click();
      panel = page.getByRole("dialog", { name: "Filters" });
      await expect(panel).toBeVisible();
      await expectNoA11yViolations(page, "filter sheet");
    } else {
      panel = page.getByRole("complementary", { name: "Filters" });
      await expect(page.getByRole("button", { name: /^Filters/ })).toBeHidden();
    }
    await expect(panel.getByRole("checkbox", { name: /^Kiribati/ })).toBeChecked();

    // A cause narrows the list at once and keeps the country.
    await tick(panel, /^Climate and nature/);
    await expect(page).toHaveURL(/\/en\/campaigns\?cause=climate&country=KI$/);
    if (mobile) {
      // The open sheet hides the page from assistive tech; its button carries the count.
      await expect(panel.getByRole("button", { name: "Show 1 campaign" })).toBeVisible();
    } else {
      await expect(card(titles.kiClimate)).toBeVisible();
      await expect(card(titles.kiAnimals)).toHaveCount(0);
    }

    // A second country: either country matches.
    await tick(panel, /^Palau/);
    await expect(page).toHaveURL(/\/en\/campaigns\?cause=climate&country=KI&country=PW$/);
    if (mobile) {
      await panel.getByRole("button", { name: "Show 2 campaigns" }).click();
      await expect(panel).toBeHidden();
      await expect(page.getByRole("button", { name: "Filters (3)" })).toBeVisible();
    }
    await expect(card(titles.pwClimate)).toBeVisible();
    await expect(card(titles.kiClimate)).toBeVisible();
    await expect(card(titles.kiAnimals)).toHaveCount(0);
    await expect(total).toHaveText("2 campaigns");
    if (!mobile) await expectNoA11yViolations(page, "/en/campaigns?cause=climate&country=KI&country=PW");

    // Removing a tag drops only that value.
    await page.getByRole("link", { name: "Remove filter: Kiribati" }).click();
    await expect(page).toHaveURL(/\/en\/campaigns\?cause=climate&country=PW$/);
    await expect(card(titles.kiClimate)).toHaveCount(0);
    await expect(card(titles.pwClimate)).toBeVisible();

    // No match: the empty state offers the full list.
    await page.goto("/en/campaigns?cause=medical&country=PW");
    await expect(page.getByText("No campaigns match these filters.")).toBeVisible();
    await page.getByRole("link", { name: "Show all campaigns" }).click();
    await expect(page).toHaveURL(/\/en\/campaigns$/);
    await expect(page.getByText("No campaigns match these filters.")).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Active filters" })).toHaveCount(0);

    // Unknown values are ignored, not an error page.
    const response = await page.goto("/en/campaigns?cause=crypto&country=XX");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("list", { name: "Active filters" })).toHaveCount(0);
  });
});
