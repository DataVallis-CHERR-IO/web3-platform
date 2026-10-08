/**
 * apps/web/e2e/rating.spec.ts
 * Ratings of organisations (TASK-057, ADR-058): a donor of a finished campaign
 * rates the organisation on the campaign page, signing with their wallet
 * (EIP-712, signed in Node by a test key so the server really verifies it);
 * "My donations" then shows the rating. Someone who did not donate sees no
 * rating panel. Needs Postgres.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { eq, inArray, sql } from "drizzle-orm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import * as schema from "@cherrio/db";
import { ensureFakeChain, deleteFakeChainRows } from "../src/__tests__/helpers/fake-chain";
import { createApprovedOrganization, deleteTestUser, loginAsNewUser, loginAsUser } from "./helpers/session";
import { installSigningKey, installWallet } from "./helpers/wallet";

const hex = (bytes: number) => `0x${randomBytes(bytes).toString("hex")}`;
const now = () => Math.floor(Date.now() / 1000);
const U = 1_000_000n;

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("E2E needs DATABASE_URL");
  return schema.createDb(url, { max: 1 });
}

async function expectNoA11yViolations(page: Page, label: string) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations, `a11y violations on ${label}`).toEqual([]);
}

test.describe("rate the organisation", () => {
  const userIds: string[] = [];
  const addresses: string[] = [];
  const campaigns: string[] = [];

  test.afterEach(async () => {
    const client = db();
    try {
      for (const c of campaigns.splice(0)) await deleteFakeChainRows(client, c);
      if (addresses.length > 0) await client.delete(schema.userAddresses).where(inArray(schema.userAddresses.address, addresses.splice(0)));
    } finally {
      await client.$client.end();
    }
    for (const id of userIds.splice(0)) await deleteTestUser(id);
  });

  /** A COMPLETED organisation campaign (paid out yesterday); `donor` gave 25 USDC from `wallet`. */
  async function finishedCampaign(run: string, donor?: { userId: string; wallet: string }) {
    const client = db();
    const address = hex(20);
    campaigns.push(address);
    try {
      await ensureFakeChain(client);
      const [owner] = await client
        .insert(schema.users)
        .values({ displayName: `E2E rating owner ${run}`, privyDid: `privy|e2e-rating-owner-${run}` })
        .returning({ id: schema.users.id });
      userIds.push(owner!.id);
      const orgId = await createApprovedOrganization(owner!.id, `E2E Rated Org ${run}`);
      const slug = `e2e-rating-${run}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
      await client.insert(schema.campaigns).values({
        orgId, starterUserId: owner!.id, beneficiaryType: "ORGANIZATION", title: `E2E rating ${run}`, slug,
        story: { format: "plain", text: "Help us fix the shelter roof." }, cause: "animals", country: "SI",
        targetEurCents: "1000000", durationDays: 30, status: "DEPLOYED", eurUsdRate: "1.17000000", rateSource: "ECB",
        rateAt: new Date(), targetUsdc: 1000n * U, beneficiaryAddress: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
        deadline: new Date((now() - 20 * 86_400) * 1000), onchainAddress: address, submittedAt: new Date(), deployedAt: new Date(),
      });
      await client.execute(sql`
        insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, tx_hash, log_index, block_number,
          block_time, state, total_raised, payout_mode, released, end_time, snap_vote_window, snap_quorum_bps, snap_approval_bps,
          snap_release_delay, snap_refund_sweep_delay)
        values (${address}, ${hex(32)}, '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 0, ${(1000n * U).toString()}, ${now() - 20 * 86_400},
          ${hex(32)}, 0, 1, ${now()}, 'COMPLETED', ${(300n * U).toString()}, 0, ${(300n * U).toString()}, ${now() - 20 * 86_400},
          3600, 2500, 5100, 259200, 15552000)
      `);
      await client.execute(sql`
        insert into chain.tranche_release (id, campaign, tranche_index, beneficiary, amount, fee, tx_hash, log_index, block_number, block_time)
        values (${hex(32)}, ${address}, 0, '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', ${(297n * U).toString()}, ${(3n * U).toString()},
          ${hex(32)}, 0, 2, ${now() - 86_400})
      `);
      if (donor) {
        const w = donor.wallet.toLowerCase();
        await client.insert(schema.userAddresses).values({ userId: donor.userId, address: w, kind: "EXTERNAL" });
        addresses.push(w);
        await client.execute(sql`
          insert into chain.donation (id, campaign, donor, amount, preference, sub_pool_id, tx_hash, log_index, block_number, block_time)
          values (${hex(32)}, ${address}, ${w}, ${(25n * U).toString()}, 0, 0, ${hex(32)}, 0, 1, ${now() - 25 * 86_400})
        `);
        await client.execute(sql`
          insert into chain.campaign_donor (campaign, donor, donated, preference, sub_pool_id)
          values (${address}, ${w}, ${(25n * U).toString()}::numeric, 0, 0)
        `);
      }
      return { slug, address, ownerId: owner!.id };
    } finally {
      await client.$client.end();
    }
  }

  test("a donor signs a rating with their wallet; My donations shows it", async ({ page, context }) => {
    const run = `${test.info().project.name}-${Date.now()}`;
    const account = privateKeyToAccount(generatePrivateKey());
    const userId = await loginAsNewUser(context, `rater-${run}`);
    userIds.push(userId);
    const c = await finishedCampaign(run, { userId, wallet: account.address });
    await installWallet(page, account.address);
    await installSigningKey(page, async (json) => {
      const typed = JSON.parse(json) as { domain: Record<string, unknown>; primaryType: "Rating"; message: Record<string, unknown>; types: Record<string, unknown> };
      const { EIP712Domain: _domain, ...types } = typed.types;
      const message = { ...typed.message, stars: Number(typed.message.stars), issuedAt: BigInt(String(typed.message.issuedAt)) };
      return account.signTypedData({ domain: typed.domain, types, primaryType: typed.primaryType, message } as Parameters<typeof account.signTypedData>[0]);
    });

    await page.goto(`/en/campaigns/${c.slug}`);
    const panel = page.getByRole("region", { name: "Rate the organisation" });
    await expect(panel).toBeVisible();
    await expect(panel.getByText("Only the organisation and CHERR.IO see your comment.", { exact: false })).toBeVisible();
    await expectNoA11yViolations(page, "rating panel");

    await panel.getByRole("radio", { name: "4 stars" }).check();
    await panel.getByLabel("Comment (optional)").fill("Clear updates, the invoices came late.");
    await panel.getByRole("button", { name: "Sign and save" }).click();
    await expect(panel.getByRole("status")).toHaveText("Thank you — your rating is saved.");
    await expect(panel.getByText(/Your rating: 4 of 5/)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Sign and update" })).toBeVisible();

    const client = db();
    try {
      const rows = await client
        .select({ stars: schema.ratings.stars, comment: schema.ratings.comment, signer: schema.ratings.signerAddress })
        .from(schema.ratings)
        .where(eq(schema.ratings.userId, userId));
      expect(rows).toEqual([{ stars: 4, comment: "Clear updates, the invoices came late.", signer: account.address.toLowerCase() }]);
    } finally {
      await client.$client.end();
    }
    const name = `rating-${test.info().project.name}.png`;
    await page.screenshot({ path: test.info().outputPath(name), fullPage: true });
    await test.info().attach(name, { path: test.info().outputPath(name), contentType: "image/png" });

    await page.goto("/en/account/donations");
    await expect(page.getByText("You rated it 4 of 5")).toBeVisible();
    await expect(page.getByRole("link", { name: "Rate the organisation" })).toHaveAttribute("href", `/en/campaigns/${c.slug}#rating`);

    // TASK-057b: the public page shows only the average, never the comment.
    await page.goto(`/en/campaigns/${c.slug}`);
    await expect(page.getByRole("img", { name: "Rated 4.0 of 5 by 1 donor" })).toBeVisible();
    await expect(page.getByText("Clear updates, the invoices came late.")).toHaveCount(0);
  });

  test("the organisation's member reads the private comment; nobody is named (TASK-057b)", async ({ page, context, browser }) => {
    const run = `member-${test.info().project.name}-${Date.now()}`;
    const account = privateKeyToAccount(generatePrivateKey());
    const donorContext = await browser.newContext();
    const donorId = await loginAsNewUser(donorContext, `rater2-${run}`);
    userIds.push(donorId);
    const c = await finishedCampaign(run, { userId: donorId, wallet: account.address });
    const client = db();
    try {
      // The rating as the API stores it (the signing flow is covered by the test above).
      const [campaignRow] = await client.select({ id: schema.campaigns.id, orgId: schema.campaigns.orgId }).from(schema.campaigns).where(eq(schema.campaigns.slug, c.slug));
      await client.insert(schema.ratings).values({
        orgId: campaignRow!.orgId!, campaignId: campaignRow!.id, userId: donorId, stars: 3, comment: "Please post receipts sooner.",
        signature: "0x00", signerAddress: account.address.toLowerCase(), signedAt: new Date(),
      });
    } finally {
      await client.$client.end();
    }
    await donorContext.close();

    await loginAsUser(context, c.ownerId);
    await page.goto("/en/account/organization");
    const ratings = page.getByRole("region", { name: "Ratings from donors" });
    await expect(ratings.getByRole("img", { name: "Rated 3.0 of 5 by 1 donor" })).toBeVisible();
    await expect(ratings.getByText("Please post receipts sooner.")).toBeVisible();
    await expect(ratings.getByRole("img", { name: "3 of 5" })).toBeVisible();
    await expect(ratings).not.toContainText(`rater2-${run}`);
    await expectNoA11yViolations(page, "account organisation with ratings");
    const file = test.info().outputPath(`org-ratings-${test.info().project.name}.png`);
    await ratings.screenshot({ path: file });
    await test.info().attach("org-ratings", { path: file, contentType: "image/png" });
  });

  test("someone who did not donate sees no rating panel", async ({ page, context }) => {
    const run = `${test.info().project.name}-${Date.now()}`;
    userIds.push(await loginAsNewUser(context, `visitor-${run}`));
    const c = await finishedCampaign(run);
    await installWallet(page, privateKeyToAccount(generatePrivateKey()).address);
    await page.goto(`/en/campaigns/${c.slug}`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("#lifecycle")).toBeVisible();
    await expect(page.getByRole("region", { name: "Rate the organisation" })).toHaveCount(0);
  });
});
