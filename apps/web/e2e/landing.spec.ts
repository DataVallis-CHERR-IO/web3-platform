/**
 * apps/web/e2e/landing.spec.ts
 * TASK-037: the landing page shows real published campaigns, not sample data.
 * TASK-038a: the seeded campaign is a demo one, so the "Demo" tag and notice are checked too.
 * A live campaign that ends soon is seeded; it must appear on /en (as the hero
 * or in the grid — parallel projects seed their own) and link to its page.
 * Needs Postgres; `chain.*` is simulated by tables (no indexer in E2E).
 */
import { randomBytes } from "node:crypto";
import { test, expect } from "@playwright/test";
import { sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { ensureFakeChain, deleteFakeChainRows } from "../src/__tests__/helpers/fake-chain";
import { createApprovedOrganization, deleteTestUser } from "./helpers/session";

const hex = (bytes: number) => `0x${randomBytes(bytes).toString("hex")}`;
const now = () => Math.floor(Date.now() / 1000);

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("E2E needs DATABASE_URL");
  return schema.createDb(url, { max: 1 });
}

test.describe("landing page", () => {
  let userId = "";
  let campaignAddress = "";

  test.afterEach(async () => {
    const client = db();
    try {
      if (campaignAddress) await deleteFakeChainRows(client, campaignAddress);
    } finally {
      await client.$client.end();
    }
    if (userId) await deleteTestUser(userId);
  });

  test("shows a real live campaign and no sample data", async ({ page }, info) => {
    const run = `${info.project.name}-${Date.now()}`;
    const title = `E2E landing ${run}`;
    campaignAddress = hex(20);
    // Ends in 15 minutes: sooner than campaigns other specs seed (days), so it
    // is among the first live campaigns the landing shows.
    const deadline = now() + 15 * 60;

    const client = db();
    let slug = "";
    try {
      await ensureFakeChain(client);
      const [owner] = await client
        .insert(schema.users)
        .values({ displayName: `E2E landing owner ${run}`, privyDid: `privy|e2e-landing-${run}` })
        .returning({ id: schema.users.id });
      userId = owner!.id;
      const orgId = await createApprovedOrganization(userId, `E2E Landing Org ${run}`);
      const [campaign] = await client
        .insert(schema.campaigns)
        .values({
          orgId, starterUserId: userId, beneficiaryType: "ORGANIZATION", title,
          slug: `e2e-landing-${run}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
          story: { format: "plain", text: "Warm meals for the winter." },
          cause: "animals", country: "SI", targetEurCents: "1000000", durationDays: 30, status: "DEPLOYED",
          eurUsdRate: "1.17000000", rateSource: "ECB", rateAt: new Date(), targetUsdc: 11_700_000_000n,
          beneficiaryAddress: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", deadline: new Date(deadline * 1000),
          onchainAddress: campaignAddress, submittedAt: new Date(), deployedAt: new Date(), isDemo: true,
        })
        .returning({ slug: schema.campaigns.slug });
      slug = campaign!.slug;
      await client.execute(sql`
        insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, state,
                                    total_raised, tx_hash, log_index, block_number, block_time)
        values (${campaignAddress}, ${hex(32)}, '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 0, 11700000000, ${deadline}, 'LIVE',
                2340000000, ${hex(32)}, 0, 1, ${now()})
      `);
    } finally {
      await client.$client.end();
    }

    await page.goto("/en");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // The sample data of TASK-007 is gone.
    await expect(page.getByText("Surgery for Susan, 7")).toHaveCount(0);
    await expect(page.getByText("Shelter Paws Ljubljana")).toHaveCount(0);
    // No fake Charity Market Cap ranking either.
    await expect(page.getByText("The ranking appears once organisations")).toBeVisible();

    const link = page.getByRole("link", { name: title, exact: true });
    await expect(link).toBeVisible();
    // ADR-052: the seeded campaign is a demo campaign — its card or hero carries the "Demo" tag.
    const holder = page.locator("article", { has: link });
    await expect(holder.locator(".ch-card-tag")).toHaveText("Demo");
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/en/campaigns/${slug}$`));
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(page.getByText("Demo campaign: made up for testing on the test network.")).toBeVisible();
  });
});
