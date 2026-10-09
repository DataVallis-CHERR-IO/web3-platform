/**
 * apps/web/e2e/emergency-pool.spec.ts
 * Public Emergency Pool page (TASK-014a): a sub-pool card and an open allocation
 * vote from the (fake) chain views, readable without JavaScript; axe clean.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { ensureFakeChain } from "../src/__tests__/helpers/fake-chain";
import { setFxRates } from "./helpers/session";

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("E2E needs DATABASE_URL");
  return schema.createDb(url, { max: 1 });
}

test.describe("public Emergency Pool page", () => {
  let poolId = 0;
  let allocationId = "";

  test.beforeEach(async ({ page: _page }, info) => {
    // Unique per project and run: 9900000–9999999.
    poolId = 9_900_000 + (Date.now() % 50_000) * 2 + (info.project.name.includes("390") ? 1 : 0);
    allocationId = String(poolId);
    const donor = `0x${poolId.toString(16).padStart(40, "0")}`;
    const campaign = `0x${(poolId + 1).toString(16).padStart(40, "c")}`;
    const later = Math.floor(Date.now() / 1000) + 86_400;
    const client = db();
    try {
      await ensureFakeChain(client);
      await client.insert(schema.emergencySubpools).values({ poolId, slug: `e2e-pool-${poolId}`, nameKey: "x", descriptionKey: "x" });
      await client.insert(schema.emergencySubpools).values({ poolId: poolId + 100_000, slug: `e2e-pool-${poolId + 100_000}`, nameKey: "x", descriptionKey: "x" });
      await client.execute(sql`insert into chain.pool (id, balance, total_contributed) values (${poolId}, 9000000, 12000000), (${poolId + 100_000}, 0, 0)`);
      await client.execute(sql`insert into chain.pool_contribution (id, pool_id, donor, amount, source, block_number)
        values (${`e2e-${poolId}`}, ${poolId}, ${donor}, 12000000, 'DIRECT', 5)`);
      await client.execute(sql`insert into chain.allocation (id, pool_id, campaign, amount, delivered, yes_votes, no_votes, vote_end, proposal_block, snap_quorum_bps, snap_approval_bps, state)
        values (${allocationId}, ${poolId}, ${campaign}, 3000000, null, 5000000, 0, ${later}, 10, 2500, 5100, 'VOTING')`);
    } finally {
      await client.$client.end();
    }
  });

  test.afterEach(async () => {
    const client = db();
    try {
      await client.execute(sql`delete from chain.allocation where id = ${allocationId}`);
      await client.execute(sql`delete from chain.pool_contribution where pool_id = ${poolId}`);
      await client.execute(sql`delete from chain.pool where id in (${poolId}, ${poolId + 100_000})`);
      await client.execute(sql`delete from app.emergency_subpools where pool_id in (${poolId}, ${poolId + 100_000})`);
    } finally {
      await client.$client.end();
    }
  });

  test("sub-pool card and an open vote, without JavaScript", async ({ browser }, info) => {
    const context = await browser.newContext({ baseURL: info.project.use.baseURL, javaScriptEnabled: false });
    const page = await context.newPage();
    const response = await page.goto("/en/emergency-pool");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Emergency Pool" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Back to Home/i })).toHaveCount(0);

    const cards = page.getByRole("list", { name: "Sub-pools" });
    const card = cards.getByRole("listitem").filter({ has: page.getByRole("heading", { name: `Pool ${poolId}`, exact: true }) });
    await expect(card).toContainText("Available now");
    await expect(card).toContainText("9.00 USDC");
    await expect(card).toContainText("12.00 USDC");

    const vote = page.getByRole("listitem").filter({ hasText: `Allocation #${allocationId}` });
    await expect(vote).toContainText("Vote open");
    await expect(vote).toContainText(`from Pool ${poolId} to`);
    await expect(vote).toContainText("41.7% (needs 25%)"); // 5 of 12 USDC voted
    await expect(vote).toContainText("100% (needs 51%)");
    await context.close();
  });

  test("an empty sub-pool reads “0 USDC”, not a converted zero; “How it works” leads to the landing section", async ({ page, context }, info) => {
    await setFxRates([{ currency: "POL", usdPerUnit: "0.1153", source: "COINGECKO" }]);
    const host = new URL(info.project.use.baseURL!).hostname;
    await context.addCookies([{ name: "cherrio_currency", value: "POL", domain: host, path: "/" }]);
    await page.goto("/en/emergency-pool");
    const empty = page.getByRole("list", { name: "Sub-pools" }).getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: `Pool ${poolId + 100_000}`, exact: true }) });
    await expect(empty).toContainText("Available now0 USDC");
    await expect(empty).not.toContainText("≈");
    // A non-zero amount is still converted.
    const full = page.getByRole("list", { name: "Sub-pools" }).getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: `Pool ${poolId}`, exact: true }) });
    await expect(full).toContainText("POL (9.00 USDC)");

    // On phones the link sits in the closed menu: read its target, then follow it.
    const href = await page.locator("header.ch-header a", { hasText: "How it works" }).first().getAttribute("href");
    expect(href).toMatch(/^\/en\/?#how-it-works$/);
    await page.goto(href!);
    await expect(page.locator("#how-it-works")).toBeVisible();
  });

  test("axe: no violations", async ({ page }) => {
    await page.goto("/en/emergency-pool");
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
  });
});
