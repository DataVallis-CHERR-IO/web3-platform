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
import { decodeFunctionData, getAddress, type Hex } from "viem";
import * as schema from "@cherrio/db";
import { CampaignAbi } from "@cherrio/contracts/abis";
import { ensureFakeChain, deleteFakeChainRows } from "../src/__tests__/helpers/fake-chain";
import { createApprovedOrganization, deleteTestUser, loginAsNewUser } from "./helpers/session";

const hex = (bytes: number) => `0x${randomBytes(bytes).toString("hex")}`;
const now = () => Math.floor(Date.now() / 1000);
const U = 1_000_000n;

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("E2E needs DATABASE_URL");
  return schema.createDb(url, { max: 1 });
}

/** A wallet whose simulations all succeed; records sent calldata in window.__sent. */
async function installWallet(page: Page, address: string) {
  await page.addInitScript((a: string) => {
    const zero32 = `0x${"00".repeat(32)}`;
    const win = window as unknown as { __sent: string[]; __cherrioE2eWallet: unknown };
    win.__sent = [];
    win.__cherrioE2eWallet = {
      address: a,
      provider: {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          switch (method) {
            case "eth_chainId": return "0x7a69";
            case "eth_accounts": case "eth_requestAccounts": return [a];
            case "eth_call": return "0x";
            case "eth_estimateGas": return "0x5208";
            case "eth_sendTransaction":
              win.__sent.push((params![0] as { data: string }).data);
              return `0x${"cd".repeat(32)}`;
            case "eth_getTransactionReceipt":
              return {
                transactionHash: (params as string[])[0], status: "0x1", blockNumber: "0x10", blockHash: zero32,
                transactionIndex: "0x0", from: a, to: a, cumulativeGasUsed: "0x1", gasUsed: "0x1",
                effectiveGasPrice: "0x1", logs: [], logsBloom: `0x${"00".repeat(256)}`, type: "0x2", contractAddress: null,
              };
            case "eth_getBlockByNumber":
              return {
                number: "0x10", hash: zero32, parentHash: zero32, timestamp: "0x6a0f0000", baseFeePerGas: "0x9502f9000",
                gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], uncles: [], nonce: "0x0000000000000000",
                difficulty: "0x0", logsBloom: `0x${"00".repeat(256)}`, miner: `0x${"00".repeat(20)}`, extraData: "0x",
                size: "0x1", stateRoot: zero32, receiptsRoot: zero32, transactionsRoot: zero32, sha3Uncles: zero32, mixHash: zero32,
              };
            case "eth_maxPriorityFeePerGas": return "0x59682f00";
            case "eth_blockNumber": return "0x10";
            case "eth_getTransactionByHash": return null;
            default: throw new Error(`unexpected ${method}`);
          }
        },
      },
    };
  }, address);
}

async function sentCalls(page: Page) {
  const data = await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent);
  return data.map((d) => {
    const call = decodeFunctionData({ abi: CampaignAbi, data: d as Hex });
    return { fn: call.functionName, args: call.args ?? [] };
  });
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
        targetEurCents: "1000000", durationDays: 30, status: "DEPLOYED", eurUsdRate: "1.17000000", rateSource: "ECB",
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
});
