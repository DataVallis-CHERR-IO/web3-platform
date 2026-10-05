/**
 * apps/web/e2e/campaign-filters.spec.ts
 * Cause / country filters on the public campaign list (TASK-039): chips change
 * the cause and keep the country, the country form keeps the cause, a choice
 * with no campaigns shows the empty state with a way back, unknown values are
 * ignored. axe on a filtered page. Kiribati and Palau: countries no other spec uses.
 * Needs Postgres; no chain rows are needed (cards show without on-chain figures).
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
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

test.describe("campaign list filters", () => {
  let ownerId = "";

  test.afterEach(async () => {
    if (ownerId) await deleteTestUser(ownerId);
  });

  test("cause chips, country form, empty state and unknown values", async ({ page }, info) => {
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
    const filters = page.getByRole("region", { name: "Filter campaigns" });

    // Country from the URL: both Kiribati campaigns, not the Palau one.
    await page.goto("/en/campaigns?country=KI");
    await expect(card(titles.kiAnimals)).toBeVisible();
    await expect(card(titles.kiClimate)).toBeVisible();
    await expect(card(titles.pwClimate)).toHaveCount(0);
    await expect(page.getByLabel("Country", { exact: true })).toHaveValue("KI");
    await expect(filters.getByRole("link", { name: "All causes" })).toHaveAttribute("aria-current", "true");
    await expect(filters.getByRole("status")).toContainText("2 campaigns");

    // A cause chip narrows the list and keeps the country.
    await filters.getByRole("link", { name: /^Climate and nature \(\d+\)$/ }).click();
    await expect(page).toHaveURL(/\/en\/campaigns\?cause=climate&country=KI$/);
    await expect(card(titles.kiClimate)).toBeVisible();
    await expect(card(titles.kiAnimals)).toHaveCount(0);
    await expect(filters.getByRole("link", { name: /^Climate and nature/ })).toHaveAttribute("aria-current", "true");
    await expect(filters.getByRole("status")).toContainText("1 campaign");
    await expectNoA11yViolations(page, "/en/campaigns?cause=climate&country=KI");

    // The country form keeps the cause.
    await page.getByLabel("Country", { exact: true }).selectOption("PW");
    await filters.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(/\/en\/campaigns\?cause=climate&country=PW$/);
    await expect(card(titles.pwClimate)).toBeVisible();
    await expect(card(titles.kiClimate)).toHaveCount(0);

    // A choice with no campaigns: the empty state offers the full list.
    await page.goto("/en/campaigns?cause=medical&country=PW");
    await expect(page.getByText("No campaigns match these filters.")).toBeVisible();
    await expect(page.getByLabel("Country", { exact: true })).toHaveValue("PW");
    await page.getByRole("link", { name: "Show all campaigns" }).click();
    await expect(page).toHaveURL(/\/en\/campaigns$/);
    await expect(page.getByRole("heading", { level: 1, name: "Campaigns" })).toBeVisible();
    await expect(page.getByText("No campaigns match these filters.")).toHaveCount(0);

    // Unknown values are ignored, not an error page.
    const response = await page.goto("/en/campaigns?cause=crypto&country=XX");
    expect(response?.status()).toBe(200);
    await expect(filters.getByRole("link", { name: "All causes" })).toHaveAttribute("aria-current", "true");
    await expect(page.getByLabel("Country", { exact: true })).toHaveValue("");
    await expect(filters.getByRole("link", { name: "Clear filters" })).toHaveCount(0);
  });
});
