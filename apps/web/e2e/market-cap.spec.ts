/**
 * apps/web/e2e/market-cap.spec.ts
 * TASK-017b: the public Charity Market Cap — ranked rows, search, order and the
 * "on CHERR.IO" filter in the URL, the methodology page and the data sources.
 * Rows are seeded straight into trust_scores (the worker computes them on dev).
 * Needs Postgres.
 */
import { test, expect } from "@playwright/test";
import { inArray } from "drizzle-orm";
import * as schema from "@cherrio/db";

test.describe("Charity Market Cap", () => {
  const orgIds: string[] = [];
  let run = "";

  test.beforeEach(async ({ browserName: _b }, info) => {
    run = `Cmc${info.project.name.replace(/\W/g, "")}${Date.now().toString(36)}`;
    const client = schema.createDb(process.env.DATABASE_URL!, { max: 1 });
    try {
      const seed = [
        { name: `${run} Zebra Rescue`, score: "72.40", registered: true, raised: "1500000000", country: "SI" },
        { name: `${run} Apple Trust`, score: "36.00", registered: false, raised: "0", country: "GB" },
        { name: `${run} Mango Fund`, score: "28.00", registered: false, raised: "0", country: "US" },
      ];
      for (const s of seed) {
        const [o] = await client
          .insert(schema.organizations)
          .values({
            source: s.registered ? "REGISTERED" : "IMPORTED", name: s.name, country: s.country, registry: "NONE",
            causes: ["animals"], kybStatus: s.registered ? "APPROVED" : "NONE",
          })
          .returning({ id: schema.organizations.id });
        orgIds.push(o!.id);
        await client.insert(schema.trustScores).values({
          orgId: o!.id, version: 1, score: s.score, components: {}, listed: true, registered: s.registered,
          country: s.country, causes: ["animals"], raised: s.raised,
        });
      }
    } finally {
      await client.$client.end();
    }
  });

  test.afterEach(async () => {
    const client = schema.createDb(process.env.DATABASE_URL!, { max: 1 });
    try {
      await client.delete(schema.trustScores).where(inArray(schema.trustScores.orgId, orgIds));
      await client.delete(schema.organizations).where(inArray(schema.organizations.id, orgIds));
    } finally {
      await client.$client.end();
    }
    orgIds.length = 0;
  });

  test("ranks by score, searches, orders by name and filters in the URL", async ({ page }) => {
    await page.goto(`/en/charity-market-cap?q=${encodeURIComponent(run)}`);
    await expect(page.getByRole("heading", { level: 1, name: "Charity Market Cap" })).toBeVisible();
    const table = page.getByRole("region", { name: "Organisations ranked by Trust Score" });
    const rows = table.locator(".ch-cmc-row");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText(`${run} Zebra Rescue`);
    await expect(rows.nth(0)).toContainText("72.40");
    await expect(rows.nth(0)).toContainText("On CHERR.IO");
    await expect(rows.nth(1)).toContainText(`${run} Apple Trust`);
    await expect(rows.nth(1)).toContainText("Not on CHERR.IO");
    await expect(rows.nth(2)).toContainText("United States");

    await page.getByRole("combobox", { name: "Order" }).click();
    await page.getByRole("option", { name: "Name (A–Z)" }).click();
    await expect(page).toHaveURL(/[?&]sort=name/);
    await expect(rows.nth(0)).toContainText(`${run} Apple Trust`);
    await expect(rows.nth(2)).toContainText(`${run} Zebra Rescue`);

    await page.getByRole("combobox", { name: "On CHERR.IO" }).click();
    await page.getByRole("option", { name: "Not on CHERR.IO" }).click();
    await expect(page).toHaveURL(/[?&]on=other/);
    await expect(rows).toHaveCount(2);
    await expect(table).not.toContainText("Zebra Rescue");

    // The organisation links to its profile (TASK-017c).
    await expect(rows.nth(0).getByRole("link", { name: `${run} Apple Trust` })).toHaveAttribute(
      "href",
      new RegExp(`/en/charity-market-cap/${orgIds[1]}$`)
    );
  });

  test("names its data sources and explains the score", async ({ page }) => {
    await page.goto("/en/charity-market-cap");
    await expect(page.getByRole("link", { name: "Open Government Licence v3.0" })).toHaveAttribute(
      "href",
      /open-government-licence\/version\/3/
    );
    await expect(page.getByText(/IRS Exempt Organizations Business Master File/)).toBeVisible();
    await page.getByRole("link", { name: "How the score works" }).first().click();
    await expect(page).toHaveURL(/\/en\/charity-market-cap\/methodology$/);
    await expect(page.getByRole("heading", { level: 1, name: "How the Trust Score works" })).toBeVisible();
    await expect(page.getByText("Donor ratings · 30%")).toBeVisible();
    await expect(page.getByText("between 20 and 40", { exact: false })).toBeVisible();
  });
});
