/**
 * apps/web/e2e/campaign-search-sort.spec.ts
 * Search and sort on the public campaign list (TASK-053): the sort select
 * reorders the list (live campaigns first in every order), the search box
 * narrows it to titles and organisation names, both live in the URL and
 * survive each other and the filters; the search shows as a removable tag.
 * Samoa (WS): a country no other spec uses. Needs Postgres.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import {
  deleteFakeChainRows,
  ensureFakeChain,
} from "../src/__tests__/helpers/fake-chain";
import { createApprovedOrganization, deleteTestUser } from "./helpers/session";

async function expectNoA11yViolations(page: Page, label: string) {
  await expect(page).toHaveTitle(/\S/);
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  expect(results.violations, `a11y violations on ${label}`).toEqual([]);
}

test.describe("campaign list search and sort", () => {
  let ownerId = "";
  const addresses: string[] = [];

  test.afterEach(async () => {
    const client = schema.createDb(process.env.DATABASE_URL!, { max: 1 });
    try {
      for (const a of addresses.splice(0)) await deleteFakeChainRows(client, a);
    } finally {
      await client.$client.end();
    }
    if (ownerId) await deleteTestUser(ownerId);
  });

  test("sort by ending soon / newest / most raised, search, and keep both with the filters", async ({
    page,
  }, info) => {
    const mobile = (page.viewportSize()?.width ?? 1440) <= 1024;
    const run = `${info.project.name}-${Date.now()}`;
    const titles = {
      alpha: `E2E sort Alpha well ${run}`,
      bravo: `E2E sort Bravo school ${run}`,
      charlie: `E2E sort Charlie clinic ${run}`,
    };
    const hex32 = () => `0x${randomBytes(32).toString("hex")}`;
    const nowS = Math.floor(Date.now() / 1000);
    const client = schema.createDb(process.env.DATABASE_URL!, { max: 1 });
    try {
      await ensureFakeChain(client);
      const [owner] = await client
        .insert(schema.users)
        .values({
          displayName: `E2E sort owner ${run}`,
          privyDid: `privy|e2e-sort-${run}`,
        })
        .returning({ id: schema.users.id });
      ownerId = owner!.id;
      const orgId = await createApprovedOrganization(
        ownerId,
        `E2E Sort Org ${run}`,
      );
      // [title, deadline in days, raised USDC (6 decimals), published days ago]
      const rows: [string, number, bigint, number][] = [
        [titles.alpha, 3, 10_000_000n, 5],
        [titles.bravo, 8, 300_000_000n, 1],
        [titles.charlie, 5, 50_000_000n, 9],
      ];
      for (const [title, days, raised, publishedAgo] of rows) {
        const address = `0x${randomBytes(20).toString("hex")}`;
        addresses.push(address);
        const deadline = nowS + days * 86_400;
        await client.insert(schema.campaigns).values({
          orgId,
          starterUserId: ownerId,
          beneficiaryType: "ORGANIZATION",
          title,
          slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          story: {
            format: "plain",
            text: "A campaign for the search and sort test.",
          },
          cause: title === titles.charlie ? "medical" : "community",
          country: "WS",
          goalAmountMinor: "1000000",
          durationDays: 30,
          status: "DEPLOYED",
          eurUsdRate: "1.17000000",
          rateSource: "ECB",
          rateAt: new Date(),
          targetUsdc: 11_700_000_000n,
          beneficiaryAddress: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
          deadline: new Date(deadline * 1000),
          onchainAddress: address,
          submittedAt: new Date(),
          deployedAt: new Date((nowS - publishedAgo * 86_400) * 1000),
        });
        await client.execute(sql`
          insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, state,
                                      total_raised, tx_hash, log_index, block_number, block_time)
          values (${address}, ${hex32()}, '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 0, 11700000000, ${deadline}, 'LIVE',
                  ${raised.toString()}::numeric, ${hex32()}, 0, 1, ${nowS})
        `);
      }
    } finally {
      await client.$client.end();
    }

    const order = () =>
      page
        .locator(".ch-campaigns-grid .ch-card-title")
        .filter({ hasText: run })
        .allTextContents();
    const sortSelect = page.getByLabel("Sort by");
    const search = page.getByRole("searchbox", { name: "Search campaigns" });

    // Default: ending soon.
    await page.goto("/en/campaigns?country=WS");
    await expect(sortSelect).toHaveValue("ending");
    await expect
      .poll(order)
      .toEqual([titles.alpha, titles.charlie, titles.bravo]);

    // Most raised: the select changes the URL at once, the filter stays.
    await sortSelect.selectOption("raised");
    await expect(page).toHaveURL(/\/en\/campaigns\?country=WS&sort=raised$/);
    await expect
      .poll(order)
      .toEqual([titles.bravo, titles.charlie, titles.alpha]);

    await sortSelect.selectOption("newest");
    await expect(page).toHaveURL(/\/en\/campaigns\?country=WS&sort=newest$/);
    await expect
      .poll(order)
      .toEqual([titles.bravo, titles.alpha, titles.charlie]);

    // Search keeps the sort and the filter; Enter submits.
    await search.fill(`  clinic   ${run} `);
    await search.press("Enter");
    await expect(page).toHaveURL(
      new RegExp(`/en/campaigns\\?country=WS&q=clinic\\+${run}&sort=newest$`),
    );
    await expect.poll(order).toEqual([titles.charlie]);
    await expect(page.locator(".ch-results-total")).toHaveText("1 campaign");
    await expect(search).toHaveValue(`clinic ${run}`);
    if (!mobile)
      await expectNoA11yViolations(page, "/en/campaigns with search and sort");

    // A filter change keeps the search and the sort (the sidebar is the wide-screen control).
    if (!mobile) {
      const panel = page.getByRole("complementary", { name: "Filters" });
      await panel
        .getByRole("checkbox", { name: /^Health and medical/ })
        .check({ force: true });
      await expect(page).toHaveURL(
        new RegExp(
          `/en/campaigns\\?cause=medical&country=WS&q=clinic\\+${run}&sort=newest$`,
        ),
      );
      await expect.poll(order).toEqual([titles.charlie]);
    }

    // The search is a removable tag; removing it keeps the rest.
    await page
      .getByRole("link", { name: `Remove filter: “clinic ${run}”` })
      .click();
    await expect(page).toHaveURL(
      mobile
        ? /\/en\/campaigns\?country=WS&sort=newest$/
        : /\/en\/campaigns\?cause=medical&country=WS&sort=newest$/,
    );
    await expect(search).toHaveValue("");

    // Searching the organisation name finds all three; "Clear all" keeps only the order.
    await page.goto(
      `/en/campaigns?country=WS&q=${encodeURIComponent(`E2E Sort Org ${run}`)}`,
    );
    await expect
      .poll(order)
      .toEqual([titles.alpha, titles.charlie, titles.bravo]);
    await page.goto(`/en/campaigns?country=WS&q=nothing-${run}&sort=raised`);
    await expect(
      page.getByText("No campaigns match these filters."),
    ).toBeVisible();
    await page.getByRole("link", { name: "Show all campaigns" }).click();
    await expect(page).toHaveURL(/\/en\/campaigns\?sort=raised$/);

    // Unknown sort is the default, not an error page.
    const response = await page.goto("/en/campaigns?country=WS&sort=cheapest");
    expect(response?.status()).toBe(200);
    await expect(sortSelect).toHaveValue("ending");
  });
});
