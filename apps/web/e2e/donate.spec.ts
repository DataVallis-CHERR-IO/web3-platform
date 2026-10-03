/**
 * apps/web/e2e/donate.spec.ts
 * Donate panel (TASK-011b) with a mocked wallet: amount in EUR, quick amounts,
 * minimum and clip messages, failure preference, approve(exact) + donate, the
 * success state, a rejection in the wallet, the "Your donation" box with
 * setPreference, and axe. Without a wallet the panel says donating is unavailable.
 *
 * The E2E server has no Privy app. The panel honours a test wallet on
 * `window.__cherrioE2eWallet` only when APP_ENV=local (never deployed); it is
 * an EIP-1193 provider answering like the contracts. Needs Postgres; `chain.*`
 * is simulated by tables (no indexer in E2E).
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { inArray, sql } from "drizzle-orm";
import { decodeFunctionData, erc20Abi, getAddress, toFunctionSelector, type Hex } from "viem";
import * as schema from "@cherrio/db";
import { CampaignAbi } from "@cherrio/contracts/abis";
import { ensureFakeChain, deleteFakeChainRows } from "../src/__tests__/helpers/fake-chain";
import { createApprovedOrganization, deleteTestUser, loginAsNewUser, setFxRates } from "./helpers/session";

const hex = (bytes: number) => `0x${randomBytes(bytes).toString("hex")}`;
const now = () => Math.floor(Date.now() / 1000);
const U = 1_000_000n;

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("E2E needs DATABASE_URL");
  return schema.createDb(url, { max: 1 });
}

const SELECTORS = {
  state: toFunctionSelector("state()"),
  deadline: toFunctionSelector("deadline()"),
  config: toFunctionSelector("config()"),
  remaining: toFunctionSelector("remaining()"),
  donated: toFunctionSelector("donated(address)"),
  usdc: toFunctionSelector("usdc()"),
  minDonation: toFunctionSelector("minDonation()"),
  balanceOf: toFunctionSelector("balanceOf(address)"),
  allowance: toFunctionSelector("allowance(address,address)"),
};

interface FakeWorld {
  address: string;
  config: string;
  usdc: string;
  remaining: string;
  donated: string;
  deadline: string;
  sel: typeof SELECTORS;
}

/** Installs the fake wallet before any page script runs. */
async function installWallet(page: Page, world: FakeWorld) {
  await page.addInitScript((w: FakeWorld) => {
    const word = (v: string | number) => BigInt(v).toString(16).padStart(64, "0");
    const addressWord = (a: string) => a.slice(2).toLowerCase().padStart(64, "0");
    const answers: Record<string, string> = {
      [w.sel.state]: word(0),
      [w.sel.deadline]: word(w.deadline),
      [w.sel.config]: addressWord(w.config),
      [w.sel.remaining]: word(w.remaining),
      [w.sel.donated]: word(w.donated),
      [w.sel.usdc]: addressWord(w.usdc),
      [w.sel.minDonation]: word(1_000_000),
      [w.sel.balanceOf]: word(100_000_000),
      [w.sel.allowance]: word(0),
    };
    const zero32 = `0x${"00".repeat(32)}`;
    const win = window as unknown as { __sent: string[]; __rejectNext: boolean; __cherrioE2eWallet: unknown };
    win.__sent = [];
    win.__rejectNext = false;
    win.__cherrioE2eWallet = {
      address: w.address,
      provider: {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          switch (method) {
            case "eth_chainId":
              return "0x7a69"; // 31337, the local chain of APP_ENV=local
            case "eth_accounts":
            case "eth_requestAccounts":
              return [w.address];
            case "eth_call": {
              const { data } = params![0] as { data: string };
              const answer = answers[data.slice(0, 10)];
              if (!answer) throw new Error(`unexpected eth_call ${data.slice(0, 10)}`);
              return `0x${answer}`;
            }
            case "eth_sendTransaction": {
              if (win.__rejectNext) {
                win.__rejectNext = false;
                throw Object.assign(new Error("User rejected the request."), { code: 4001 });
              }
              win.__sent.push((params![0] as { data: string }).data);
              return `0x${"cd".repeat(32)}`;
            }
            case "eth_getTransactionReceipt":
              return {
                transactionHash: (params as string[])[0], status: "0x1", blockNumber: "0x10", blockHash: zero32,
                transactionIndex: "0x0", from: w.address, to: w.config, cumulativeGasUsed: "0x1", gasUsed: "0x1",
                effectiveGasPrice: "0x1", logs: [], logsBloom: `0x${"00".repeat(256)}`, type: "0x2", contractAddress: null,
              };
            case "eth_getBlockByNumber":
              return {
                number: "0x10", hash: zero32, parentHash: zero32, timestamp: "0x6a0f0000", baseFeePerGas: "0x9502f9000",
                gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], uncles: [], nonce: "0x0000000000000000",
                difficulty: "0x0", logsBloom: `0x${"00".repeat(256)}`, miner: `0x${"00".repeat(20)}`, extraData: "0x",
                size: "0x1", stateRoot: zero32, receiptsRoot: zero32, transactionsRoot: zero32, sha3Uncles: zero32, mixHash: zero32,
              };
            case "eth_maxPriorityFeePerGas":
              return "0x59682f00";
            case "eth_blockNumber":
              return "0x10";
            case "eth_getTransactionByHash":
              return null;
            default:
              throw new Error(`unexpected ${method}`);
          }
        },
      },
    };
  }, world);
}

/** The transactions the page sent, decoded. */
async function sentCalls(page: Page) {
  const data = await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent);
  return data.map((d) => {
    try {
      const call = decodeFunctionData({ abi: erc20Abi, data: d as Hex });
      return { fn: call.functionName, args: call.args };
    } catch {
      const call = decodeFunctionData({ abi: CampaignAbi, data: d as Hex });
      return { fn: call.functionName, args: call.args };
    }
  });
}

async function expectNoA11yViolations(page: Page, label: string) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations, `a11y violations on ${label}`).toEqual([]);
}

test.describe("donate panel", () => {
  const userIds: string[] = [];
  const addresses: string[] = [];
  let campaignAddress = "";

  test.afterEach(async () => {
    const client = db();
    try {
      if (campaignAddress) await deleteFakeChainRows(client, campaignAddress);
      if (addresses.length > 0) await client.delete(schema.userAddresses).where(inArray(schema.userAddresses.address, addresses.splice(0)));
    } finally {
      await client.$client.end();
    }
    for (const id of userIds.splice(0)) await deleteTestUser(id);
  });

  /** A DEPLOYED, LIVE campaign whose target is 20 USDC short. Returns its slug. */
  async function liveCampaign(run: string, ownerId: string): Promise<string> {
    const client = db();
    try {
      await ensureFakeChain(client);
      const orgId = await createApprovedOrganization(ownerId, `E2E Donate Org ${run}`);
      const deadline = now() + 12 * 86_400;
      const slug = `e2e-donate-${run}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
      await client.insert(schema.campaigns).values({
        orgId, starterUserId: ownerId, beneficiaryType: "ORGANIZATION", title: `E2E donate ${run}`, slug,
        story: { format: "plain", text: "Help us fix the shelter roof." }, cause: "animals", country: "SI",
        targetEurCents: "1000000", durationDays: 30, status: "DEPLOYED", eurUsdRate: "1.17000000", rateSource: "ECB",
        rateAt: new Date(), targetUsdc: 11_700_000_000n, beneficiaryAddress: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
        deadline: new Date(deadline * 1000), onchainAddress: campaignAddress, submittedAt: new Date(), deployedAt: new Date(),
      });
      await client.execute(sql`
        insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, state,
                                    total_raised, tx_hash, log_index, block_number, block_time)
        values (${campaignAddress}, ${hex(32)}, '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 0, 11700000000, ${deadline}, 'LIVE',
                11680000000, ${hex(32)}, 0, 1, ${now()})
      `);
      return slug;
    } finally {
      await client.$client.end();
    }
  }

  test("amount rules, approve + donate, rejection, and changing the preference", async ({ page, context }, info) => {
    const run = `${info.project.name}-${Date.now()}`;
    campaignAddress = hex(20);
    const wallet = getAddress(hex(20));
    await setFxRates([{ currency: "EUR", usdPerUnit: "1.1734", source: "ECB" }]);
    const userId = await loginAsNewUser(context, `donor-${run}`);
    userIds.push(userId);
    const slug = await liveCampaign(run, userId);

    // The donor already gave 5 USDC from this wallet (refund preference): "Your donation" shows it.
    const client = db();
    try {
      await client.insert(schema.userAddresses).values({ userId, address: wallet.toLowerCase(), kind: "EXTERNAL" });
      addresses.push(wallet.toLowerCase());
      await client.execute(sql`
        insert into chain.campaign_donor (campaign, donor, donated, preference, sub_pool_id)
        values (${campaignAddress}, ${wallet.toLowerCase()}, 5000000, 0, 0)
      `);
    } finally {
      await client.$client.end();
    }

    await installWallet(page, {
      address: wallet, config: hex(20), usdc: hex(20), remaining: (20n * U).toString(), donated: (5n * U).toString(),
      deadline: String(now() + 12 * 86_400), sel: SELECTORS,
    });
    await page.goto(`/en/campaigns/${slug}`);

    const panel = page.locator("#donate");
    await expect(panel.getByRole("heading", { name: "Give to this campaign" })).toBeVisible();
    const amount = panel.getByRole("textbox", { name: "Amount" });
    await expect(amount).toHaveValue("25");
    // €25 = 29.335 USDC, but only 20 USDC are missing.
    await expect(panel.getByText("This campaign needs only 20.00 USDC more, so only that will be taken.")).toBeVisible();

    await panel.getByRole("button", { name: "€10", exact: true }).click();
    await expect(panel.getByRole("button", { name: "€10", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByText(/needs only/)).toHaveCount(0);
    await panel.getByText("Details").click();
    await expect(panel.getByText("You send exactly 11.734 USDC.")).toBeVisible();
    await expect(panel.getByText("Rate: €1 = 1.1734 USDC (European Central Bank reference, for display).")).toBeVisible();

    await amount.fill("0.5");
    await expect(panel.getByText("The minimum donation is €1.")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Donate", exact: true })).toBeDisabled();
    await amount.fill("10");

    // "Your donation": 5 USDC, refund.
    const mine = page.locator(".ch-donate-mine");
    await expect(mine.getByText("You gave 5.00 USDC.")).toBeVisible();
    await expect(mine.getByText("If the campaign does not reach 10%, you get your money back.")).toBeVisible();
    await expectNoA11yViolations(page, "/en/campaigns/[slug] with the donate panel");
    // No sideways scrolling on a phone (the converted key figure used to widen the page).
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // A rejection in the wallet: nothing sent, a fixable message.
    await page.evaluate(() => { (window as unknown as { __rejectNext: boolean }).__rejectNext = true; });
    await panel.getByRole("button", { name: "Donate", exact: true }).click();
    await expect(panel.getByRole("alert")).toHaveText("You cancelled in your wallet. Nothing was sent.");
    expect(await sentCalls(page)).toEqual([]);

    // Emergency Pool preference, then donate: approve(exact) and donate(amount, 1, 0).
    await panel.getByLabel("Send it to the Emergency Pool").check();
    await panel.getByRole("button", { name: "Donate", exact: true }).click();
    await expect(panel.getByText(/Thank you! Your donation is recorded on the blockchain/)).toBeVisible({ timeout: 20_000 });
    const sent = await sentCalls(page);
    expect(sent.map((c) => c.fn)).toEqual(["approve", "donate"]);
    expect(sent[0]!.args).toEqual([getAddress(campaignAddress), 11_734_000n]);
    expect(sent[1]!.args).toEqual([11_734_000n, 1, 0]);

    // Change the preference of the earlier donation.
    await page.locator(".ch-donate-mine").getByRole("button", { name: "Change", exact: true }).click();
    await page.locator(".ch-donate-mine").getByLabel("Send it to the Emergency Pool").check();
    await page.locator(".ch-donate-mine").getByRole("button", { name: "Save choice" }).click();
    await expect(page.locator(".ch-donate-mine").getByText("Saved. It shows here within a minute.")).toBeVisible({ timeout: 20_000 });
    const all = await sentCalls(page);
    expect(all.at(-1)).toEqual({ fn: "setPreference", args: [1, 0] });

    // On a phone the panel is reached from a bottom bar.
    if (info.project.name.endsWith("390")) {
      await expect(page.getByRole("link", { name: "Donate to this campaign" })).toBeVisible();
    } else {
      await expect(page.getByRole("link", { name: "Donate to this campaign" })).toBeHidden();
    }
  });

  test("without a wallet the panel says donating is unavailable", async ({ page }, info) => {
    const run = `${info.project.name}-nw-${Date.now()}`;
    campaignAddress = hex(20);
    const client = db();
    let ownerId: string;
    try {
      const [owner] = await client
        .insert(schema.users)
        .values({ displayName: `E2E owner ${run}`, privyDid: `privy|e2e-donate-owner-${run}` })
        .returning({ id: schema.users.id });
      ownerId = owner!.id;
    } finally {
      await client.$client.end();
    }
    userIds.push(ownerId);
    const slug = await liveCampaign(run, ownerId);
    await page.goto(`/en/campaigns/${slug}`);
    await expect(page.locator("#donate")).toHaveText("Donating is not available right now. Please try again later.");
    await expect(page.getByRole("button", { name: "Donate", exact: true })).toHaveCount(0);
  });
});
