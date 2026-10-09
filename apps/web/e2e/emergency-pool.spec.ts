/**
 * apps/web/e2e/emergency-pool.spec.ts
 * Public Emergency Pool page (TASK-014a): a sub-pool card and an open allocation
 * vote from the (fake) chain views, readable without JavaScript; axe clean.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { sql } from "drizzle-orm";
import { decodeFunctionData, erc20Abi, getAddress, toFunctionSelector, type Hex } from "viem";
import { EmergencyPoolAbi } from "@cherrio/contracts/abis";
import { E2E_EMERGENCY_POOL } from "../playwright.env";
import * as schema from "@cherrio/db";
import { ensureFakeChain } from "../src/__tests__/helpers/fake-chain";
import { setFxRates } from "./helpers/session";

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("E2E needs DATABASE_URL");
  return schema.createDb(url, { max: 1 });
}

const GIVER = "0x00000000000000000000000000000000000e2e14";
const CONFIG = "0x0000000000000000000000000000000000c0ffee";
const USDC = "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582";

/** A wallet that answers EmergencyPool / PlatformConfig / USDC reads; records sends and smart-account batches. */
async function installGiver(page: Page, smart: boolean) {
  const sel = {
    poolExists: toFunctionSelector("poolExists(uint32)"),
    config: toFunctionSelector("config()"),
    usdc: toFunctionSelector("usdc()"),
    minDonation: toFunctionSelector("minDonation()"),
    balanceOf: toFunctionSelector("balanceOf(address)"),
    allowance: toFunctionSelector("allowance(address,address)"),
  };
  await page.addInitScript((w: { giver: string; config: string; usdc: string; smart: boolean; sel: Record<string, string> }) => {
    const word = (v: number) => v.toString(16).padStart(64, "0");
    const addr = (a: string) => a.slice(2).padStart(64, "0");
    const answers: Record<string, string> = {
      [w.sel.poolExists!]: word(1), [w.sel.config!]: addr(w.config), [w.sel.usdc!]: addr(w.usdc),
      [w.sel.minDonation!]: word(1_000_000), [w.sel.balanceOf!]: word(100_000_000), [w.sel.allowance!]: word(0),
    };
    const zero32 = `0x${"00".repeat(32)}`;
    const win = window as unknown as { __sent: string[]; __batches: string[][]; __cherrioE2eWallet: unknown };
    win.__sent = [];
    win.__batches = [];
    win.__cherrioE2eWallet = {
      address: w.giver,
      sendCalls: w.smart ? async (calls: { data: string }[]) => { win.__batches.push(calls.map((c) => c.data)); return `0x${"ef".repeat(32)}`; } : undefined,
      provider: {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          switch (method) {
            case "eth_chainId": return "0x7a69";
            case "eth_accounts": case "eth_requestAccounts": return [w.giver];
            case "eth_call": {
              const answer = answers[(params![0] as { data: string }).data.slice(0, 10)];
              if (!answer) throw new Error("unexpected eth_call");
              return `0x${answer}`;
            }
            case "eth_sendTransaction": win.__sent.push((params![0] as { data: string }).data); return `0x${"cd".repeat(32)}`;
            case "eth_getTransactionReceipt":
              return { transactionHash: (params as string[])[0], status: "0x1", blockNumber: "0x10", blockHash: zero32, transactionIndex: "0x0",
                from: w.giver, to: w.usdc, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [],
                logsBloom: `0x${"00".repeat(256)}`, type: "0x2", contractAddress: null };
            case "eth_getBlockByNumber":
              return { number: "0x10", hash: zero32, parentHash: zero32, timestamp: "0x6a0f0000", baseFeePerGas: "0x9502f9000",
                gasLimit: "0x1c9c380", gasUsed: "0x0", transactions: [], uncles: [], nonce: "0x0000000000000000", difficulty: "0x0",
                logsBloom: `0x${"00".repeat(256)}`, miner: `0x${"00".repeat(20)}`, extraData: "0x", size: "0x1", stateRoot: zero32,
                receiptsRoot: zero32, transactionsRoot: zero32, sha3Uncles: zero32, mixHash: zero32 };
            case "eth_maxPriorityFeePerGas": return "0x59682f00";
            case "eth_blockNumber": return "0x10";
            case "eth_getTransactionByHash": return null;
            default: throw new Error(`unexpected ${method}`);
          }
        },
      },
    };
  }, { giver: GIVER, config: CONFIG, usdc: USDC, smart, sel });
}

const decodeGift = (data: string) => {
  try {
    const c = decodeFunctionData({ abi: erc20Abi, data: data as Hex });
    return [c.functionName, ...(c.args ?? [])];
  } catch {
    const c = decodeFunctionData({ abi: EmergencyPoolAbi, data: data as Hex });
    return [c.functionName, ...(c.args ?? [])];
  }
};

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
    // The server keeps rates in memory for 30 s: reload until the POL rate is in use (like display-currency.spec).
    await expect(async () => {
      await page.reload();
      await expect(page.getByText("Available in all sub-pools:").locator("..")).toContainText("POL", { timeout: 1_000 });
    }).toPass({ timeout: 45_000 });
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

  test("give to a sub-pool from an own wallet: approve exactly, then donate(poolId, amount)", async ({ page }) => {
    await installGiver(page, false);
    await page.goto("/en/emergency-pool");
    const card = page.getByRole("list", { name: "Sub-pools" }).getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: `Pool ${poolId}`, exact: true }) });
    await card.getByText("Give to this pool").click();
    const amount = card.getByRole("textbox", { name: "Amount" });
    await amount.fill("0.5");
    await amount.blur();
    await expect(card.getByText("The minimum gift is 1 USDC.")).toBeVisible();
    await amount.fill("12.5");
    await card.getByRole("button", { name: `Give to Pool ${poolId}` }).click();
    await expect(card.getByRole("status").filter({ hasText: `Thank you — 12.50 USDC went to Pool ${poolId}.` })).toBeVisible();
    const sent = await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent);
    expect(sent.map(decodeGift)).toEqual([
      ["approve", getAddress(E2E_EMERGENCY_POOL), 12_500_000n],
      ["donate", poolId, 12_500_000n],
    ]);
  });

  test("a CHERR.IO smart account gives in one sponsored step", async ({ page }) => {
    await installGiver(page, true);
    await page.goto("/en/emergency-pool");
    const card = page.getByRole("list", { name: "Sub-pools" }).getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: `Pool ${poolId}`, exact: true }) });
    await card.getByText("Give to this pool").click();
    await expect(card.getByText("No network fee: CHERR.IO pays it for your CHERR.IO wallet.")).toBeVisible();
    await card.getByRole("button", { name: `Give to Pool ${poolId}` }).click();
    await expect(card.getByRole("status").filter({ hasText: "went to" })).toBeVisible();
    const state = await page.evaluate(() => {
      const w = window as unknown as { __sent: string[]; __batches: string[][] };
      return { sent: w.__sent, batches: w.__batches };
    });
    expect(state.sent).toEqual([]);
    expect(state.batches.map((b) => b.map(decodeGift))).toEqual([[
      ["approve", getAddress(E2E_EMERGENCY_POOL), 10_000_000n],
      ["donate", poolId, 10_000_000n],
    ]]);
  });

  test("axe: no violations", async ({ page }) => {
    await page.goto("/en/emergency-pool");
    await page.waitForLoadState("networkidle");
    await page.getByText("Give to this pool").first().click(); // the open gift form is checked too
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
  });
});
