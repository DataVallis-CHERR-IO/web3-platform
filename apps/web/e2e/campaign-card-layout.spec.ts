/**
 * apps/web/e2e/campaign-card-layout.spec.ts
 * Campaign cards keep their content inside the card (David 2026-10-05: the
 * progress bar and "≈ 0.00 POL (0.00 USDC)" stuck out of the cards). A long
 * converted figure in POL must wrap, never widen the card's column; checked
 * on the campaign list at both viewports. Marshall Islands: a country no other test uses
 * in E2E. Needs Postgres.
 */
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { test, expect } from "@playwright/test";
import * as schema from "@cherrio/db";
import { deleteFakeChainRows, ensureFakeChain } from "../src/__tests__/helpers/fake-chain";
import { createApprovedOrganization, deleteTestUser, setFxRates } from "./helpers/session";

test.describe("campaign card layout", () => {
  let ownerId = "";
  let address = "";
  test.afterEach(async () => {
    if (address) {
      const client = schema.createDb(process.env.DATABASE_URL!, { max: 1 });
      await deleteFakeChainRows(client, address).finally(() => client.$client.end());
    }
    if (ownerId) await deleteTestUser(ownerId);
  });

  test("bar and figures stay inside the card with a long POL amount", async ({ page, context }, info) => {
    await setFxRates([
      { currency: "EUR", usdPerUnit: "1.1734", source: "ECB" },
      { currency: "POL", usdPerUnit: "0.1153", source: "COINGECKO" },
    ]);
    const run = `${info.project.name}-${Date.now()}`;
    const title = `E2E card layout Wheelchair-accessible van for a day centre ${run}`;
    const deadline = Math.floor(Date.now() / 1000) + 5 * 86_400;
    const hex32 = () => `0x${randomBytes(32).toString("hex")}`;
    const client = schema.createDb(process.env.DATABASE_URL!, { max: 1 });
    try {
      await ensureFakeChain(client);
      const [owner] = await client
        .insert(schema.users)
        .values({ displayName: `E2E card owner ${run}`, privyDid: `privy|e2e-card-${run}` })
        .returning({ id: schema.users.id });
      ownerId = owner!.id;
      address = `0x${randomBytes(20).toString("hex")}`;
      const orgId = await createApprovedOrganization(ownerId, `E2E Card Org ${run}`);
      await client.insert(schema.campaigns).values({
        orgId, starterUserId: ownerId, beneficiaryType: "ORGANIZATION", title,
        slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        story: { format: "plain", text: "A campaign for the card layout test." },
        cause: "animals", country: "MH", targetEurCents: "4200000000", durationDays: 30, status: "DEPLOYED",
        eurUsdRate: "1.17340000", rateSource: "ECB", rateAt: new Date(), targetUsdc: 49_282_800_000_000n,
        beneficiaryAddress: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
        deadline: new Date(deadline * 1000),
        onchainAddress: address,
        submittedAt: new Date(), deployedAt: new Date(),
      });
      // A large indexed raised amount → a long "≈ … POL (… USDC)" figure, the case that stuck out.
      await client.execute(sql`
        insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, state,
                                    total_raised, tx_hash, log_index, block_number, block_time)
        values (${address}, ${hex32()}, '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 0, 49282800000000, ${deadline}, 'LIVE',
                12345678912345, ${hex32()}, 0, 1, ${Math.floor(Date.now() / 1000)})
      `);
    } finally {
      await client.$client.end();
    }
    const host = new URL(info.project.use.baseURL!).hostname;
    await context.addCookies([{ name: "cherrio_currency", value: "POL", domain: host, path: "/" }]);

    await page.goto("/en/campaigns?country=MH");
    const card = page.locator("article.ch-card").filter({ has: page.getByRole("link", { name: title }) });
    await expect(card).toContainText("(12,345,678.91 USDC)");
    const box = (await card.boundingBox())!;
    for (const part of [".ch-bar", ".ch-progress-figures", ".ch-progress-meta", ".ch-card-title"]) {
      const inner = (await card.locator(part).boundingBox())!;
      expect(inner.x + inner.width, `${part} right edge`).toBeLessThanOrEqual(box.x + box.width);
    }
    // Nothing inside the card is wider than the card itself.
    const overflow = await card.locator(".ch-card-body").evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
