/**
 * apps/web/e2e/lifecycle.spec.ts
 * Campaign lifecycle panel (TASK-033b part 3) with a mocked wallet: a donor
 * votes in an open round, a donor gets their money back from a failed campaign,
 * anyone can finish an ended campaign, and a visitor sees the vote without
 * buttons. `chain.*` is simulated by tables (no indexer in E2E); the wallet is
 * `window.__cherrioE2eWallet` (APP_ENV=local only), answering every simulation
 * with success and recording what is sent.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { inArray, sql } from "drizzle-orm";
import { getAddress } from "viem";
import * as schema from "@cherrio/db";
import { ensureFakeChain, deleteFakeChainRows } from "../src/__tests__/helpers/fake-chain";
import { createApprovedOrganization, deleteTestUser, loginAsNewUser } from "./helpers/session";
import { installWallet, sentCalls } from "./helpers/wallet";

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

test.describe("campaign lifecycle panel", () => {
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

  /** A DEPLOYED campaign with a chain row in the given state; optionally a donor row for `donor`. */
  async function campaign(run: string, ownerId: string, chain: Record<string, string | number>, donor?: { address: string; amount: bigint; userId: string }) {
    const client = db();
    const address = hex(20);
    campaigns.push(address);
    try {
      await ensureFakeChain(client);
      const orgId = await createApprovedOrganization(ownerId, `E2E Lifecycle Org ${run}`);
      const slug = `e2e-lifecycle-${run}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
      await client.insert(schema.campaigns).values({
        orgId, starterUserId: ownerId, beneficiaryType: "ORGANIZATION", title: `E2E lifecycle ${run}`, slug,
        story: { format: "plain", text: "Help us fix the shelter roof." }, cause: "animals", country: "SI",
        goalAmountMinor: "1000000", durationDays: 30, status: "DEPLOYED", eurUsdRate: "1.17000000", rateSource: "ECB",
        rateAt: new Date(), targetUsdc: 1000n * U, beneficiaryAddress: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
        deadline: new Date((now() - 86_400) * 1000), onchainAddress: address, submittedAt: new Date(), deployedAt: new Date(),
      });
      const cols: Record<string, string | number> = {
        snap_vote_window: 3600, snap_quorum_bps: 2500, snap_approval_bps: 5100, snap_release_delay: 259200, snap_refund_sweep_delay: 15552000,
        ...chain,
      };
      const names = Object.keys(cols);
      await client.execute(sql`
        insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline,
          tx_hash, log_index, block_number, block_time, ${sql.raw(names.join(", "))})
        values (${address}, ${hex(32)}, '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 0, ${(1000n * U).toString()}, ${now() - 86_400},
          ${hex(32)}, 0, 1, ${now()}, ${sql.join(names.map((k) => sql`${cols[k]}`), sql`, `)})
      `);
      if (donor) {
        await client.insert(schema.userAddresses).values({ userId: donor.userId, address: donor.address, kind: "EXTERNAL" });
        addresses.push(donor.address);
        await client.execute(sql`
          insert into chain.campaign_donor (campaign, donor, donated, preference, sub_pool_id)
          values (${address}, ${donor.address}, ${donor.amount.toString()}::numeric, 0, 0)
        `);
      }
      return { slug, address };
    } finally {
      await client.$client.end();
    }
  }

  async function voteRound(campaignAddress: string, voteEnd: number, yes: bigint) {
    const client = db();
    try {
      await client.execute(sql`
        insert into chain.vote_round (campaign, round, bundle_hash, vote_end, yes_votes, no_votes, tx_hash, log_index, block_number, block_time)
        values (${campaignAddress}, 1, ${hex(32)}, ${voteEnd}, ${yes.toString()}::numeric, 0, ${hex(32)}, 0, 2, ${now()})
      `);
    } finally {
      await client.$client.end();
    }
  }

  test("a donor approves the next payment from the wallet they donated with", async ({ page, context }, info) => {
    const run = `vote-${info.project.name}-${Date.now()}`;
    const wallet = getAddress(hex(20));
    const userId = await loginAsNewUser(context, `voter-${run}`);
    userIds.push(userId);
    const voteEnd = now() + 3600;
    const c = await campaign(run, userId, {
      state: "VOTING", total_raised: (400n * U).toString(), payout_mode: 1, tranches_released: 1, current_round: 1, vote_end: voteEnd,
    }, { address: wallet.toLowerCase(), amount: 100n * U, userId });
    await voteRound(c.address, voteEnd, 50n * U);
    await installWallet(page, wallet);

    await page.goto(`/en/campaigns/${c.slug}`);
    const panel = page.locator("#lifecycle");
    await expect(panel.getByRole("heading", { name: "Vote on payment 2 of 3" })).toBeVisible();
    await expect(panel).toContainText("12.5% (needs 25%)"); // 50 of 400
    await expect(panel).toContainText("100% (needs 51%)");
    await expect(panel).toContainText(`You gave 100.00 USDC from ${wallet.slice(0, 6)}…${wallet.slice(-4)}.`);
    await expectNoA11yViolations(page, "voting panel");

    await panel.getByRole("button", { name: "Approve payment 2" }).click();
    await expect(panel.getByRole("status")).toContainText("Confirmed. This panel updates within about a minute.");
    expect(await sentCalls(page)).toEqual([{ fn: "vote", args: [true] }]);
  });

  test("a donor gets their money back from a failed campaign", async ({ page, context }, info) => {
    const run = `refund-${info.project.name}-${Date.now()}`;
    const wallet = getAddress(hex(20));
    const userId = await loginAsNewUser(context, `refund-${run}`);
    userIds.push(userId);
    const c = await campaign(run, userId, { state: "FAILED", total_raised: (50n * U).toString() }, { address: wallet.toLowerCase(), amount: 25n * U, userId });
    await installWallet(page, wallet);

    await page.goto(`/en/campaigns/${c.slug}`);
    const panel = page.locator("#lifecycle");
    await expect(panel.getByRole("heading", { name: "The campaign did not reach 10%" })).toBeVisible();
    await panel.getByRole("button", { name: "Get your money back (25.00 USDC)" }).click();
    await expect(panel.getByRole("status")).toContainText("Confirmed.");
    expect(await sentCalls(page)).toEqual([{ fn: "claimRefund", args: [] }]);
  });

  test("anyone can finish an ended campaign; a visitor sees a vote without buttons", async ({ page, context }, info) => {
    const run = `finish-${info.project.name}-${Date.now()}`;
    const userId = await loginAsNewUser(context, `owner-${run}`);
    userIds.push(userId);
    const ended = await campaign(run, userId, { state: "LIVE", total_raised: (500n * U).toString() });
    await installWallet(page, getAddress(hex(20)));
    await page.goto(`/en/campaigns/${ended.slug}`);
    const panel = page.locator("#lifecycle");
    await expect(panel.getByRole("heading", { name: "This campaign has ended" })).toBeVisible();
    await expect(page.locator("#donate")).toHaveCount(0);
    await panel.getByRole("button", { name: "Finish the campaign" }).click();
    await expect(panel.getByRole("status")).toContainText("Confirmed.");
    expect(await sentCalls(page)).toEqual([{ fn: "finalize", args: [] }]);

    // A visitor (no session, no wallet) sees the open vote and no vote buttons.
    const visitor = await context.browser()!.newPage();
    const run2 = `visitor-${info.project.name}-${Date.now()}`;
    const voteEnd = now() + 3600;
    const voting = await campaign(run2, userId, {
      state: "VOTING", total_raised: (400n * U).toString(), payout_mode: 1, tranches_released: 1, current_round: 1, vote_end: voteEnd,
    });
    await voteRound(voting.address, voteEnd, 0n);
    await visitor.goto(`/en/campaigns/${voting.slug}`);
    const vPanel = visitor.locator("#lifecycle");
    await expect(vPanel.getByRole("heading", { name: "Vote on payment 2 of 3" })).toBeVisible();
    await expect(vPanel.getByRole("button", { name: /Approve/ })).toHaveCount(0);
    await visitor.close();
  });

  test("My donations lists every campaign with the next step and the votes waiting", async ({ page, context }, info) => {
    const run = `mine-${info.project.name}-${Date.now()}`;
    const wallet = getAddress(hex(20));
    const userId = await loginAsNewUser(context, `mine-${run}`);
    userIds.push(userId);
    const voteEnd = now() + 3600;
    const voting = await campaign(`${run}-v`, userId, {
      state: "VOTING", total_raised: (400n * U).toString(), payout_mode: 1, tranches_released: 1, current_round: 1, vote_end: voteEnd,
    }, { address: wallet.toLowerCase(), amount: 40n * U, userId });
    await voteRound(voting.address, voteEnd, 0n);
    const failed = await campaign(`${run}-f`, userId, { state: "FAILED", total_raised: (30n * U).toString() });
    const client = db();
    try {
      await client.execute(sql`
        insert into chain.campaign_donor (campaign, donor, donated, preference, sub_pool_id)
        values (${failed.address}, ${wallet.toLowerCase()}, ${(15n * U).toString()}::numeric, 0, 0)
      `);
    } finally {
      await client.$client.end();
    }

    await page.goto("/en/account/donations");
    await expect(page.getByRole("heading", { name: "My donations", level: 1 })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "A vote is waiting for you." })).toBeVisible();
    await expect(page.getByRole("link", { name: "Vote now" })).toHaveAttribute("href", `/en/campaigns/${voting.slug}#lifecycle`);
    await expect(page.getByRole("link", { name: "Get your money back (15.00 USDC)" })).toHaveAttribute("href", `/en/campaigns/${failed.slug}#lifecycle`);
    await expect(page.getByText(`40.00 USDC from ${wallet.slice(0, 6)}…${wallet.slice(-4)}`)).toBeVisible();
    await expectNoA11yViolations(page, "my donations");

    // Without a session the page is not shown.
    const visitor = await context.browser()!.newPage();
    await visitor.goto("/en/account/donations");
    await expect(visitor).toHaveURL(/\/en$/);
    await visitor.close();
  });
});
