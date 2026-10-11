/**
 * apps/web/e2e/contract-changes.spec.ts
 * Timelock watcher, public side (TASK-023d-2, security review M-02): every
 * scheduled contract change in plain words, readable without JavaScript, axe
 * clean; the Emergency Pool page announces a waiting change of where pool money
 * goes and links to it.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { encodeFunctionData, getAddress, type Hex } from "viem";
import { PlatformConfigAbi } from "@cherrio/contracts/abis";
import * as schema from "@cherrio/db";
import { E2E_PLATFORM_CONFIG } from "../playwright.env";
import { ensureFakeChain } from "../src/__tests__/helpers/fake-chain";

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("E2E needs DATABASE_URL");
  return schema.createDb(url, { max: 1 });
}

const hex32 = (): Hex => `0x${randomBytes(32).toString("hex")}`;
const NEW_POOL = getAddress("0x00000000000000000000000000000000e2e0d023");

test.describe("scheduled contract changes (TASK-023d)", () => {
  let moneyOp: Hex;
  let feeOp: Hex;

  test.beforeEach(async ({ browserName: _b }, info) => {
    moneyOp = hex32();
    feeOp = hex32();
    const now = Math.floor(Date.now() / 1000);
    // Newest on the page: block numbers above anything else in the test database, one range per project.
    const block = 9_100_000_000 + (Date.now() % 1_000_000) * 4 + (info.project.name.includes("390") ? 2 : 0);
    const pc = E2E_PLATFORM_CONFIG.toLowerCase();
    const client = db();
    try {
      await ensureFakeChain(client);
      await client.execute(sql`insert into chain.timelock_operation (id, calls, delay, ready_at, state, block_number, block_time, tx_hash)
        values (${moneyOp}, 1, 172800, ${now + 172_800}, 'WAITING', ${block + 1}, ${now}, ${hex32()})`);
      await client.execute(sql`insert into chain.timelock_call (op_id, index, target, data)
        values (${moneyOp}, 0, ${pc}, ${encodeFunctionData({ abi: PlatformConfigAbi, functionName: "setEmergencyPool", args: [NEW_POOL] })})`);
      await client.execute(sql`insert into chain.timelock_operation (id, calls, delay, ready_at, state, block_number, block_time, tx_hash,
          executed_tx_hash, executed_block_time)
        values (${feeOp}, 1, 300, ${now - 3_000}, 'EXECUTED', ${block}, ${now - 3_300}, ${hex32()}, ${hex32()}, ${now - 2_000})`);
      await client.execute(sql`insert into chain.timelock_call (op_id, index, target, data)
        values (${feeOp}, 0, ${pc}, ${encodeFunctionData({ abi: PlatformConfigAbi, functionName: "setFeeBps", args: [300] })})`);
    } finally {
      await client.$client.end();
    }
  });

  test.afterEach(async () => {
    const client = db();
    try {
      await client.execute(sql`delete from chain.timelock_call where op_id in (${moneyOp}, ${feeOp})`);
      await client.execute(sql`delete from chain.timelock_operation where id in (${moneyOp}, ${feeOp})`);
    } finally {
      await client.$client.end();
    }
  });

  test("every change in plain words, without JavaScript; axe clean", async ({ browser, page: jsPage }, info) => {
    const context = await browser.newContext({ baseURL: info.project.use.baseURL, javaScriptEnabled: false });
    const page = await context.newPage();
    const response = await page.goto("/en/contract-changes");
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Scheduled contract changes" })).toBeVisible();

    const money = page.locator(`#change-${moneyOp}`);
    await expect(money.getByText(`Emergency Pool contract: set to ${NEW_POOL}`)).toBeVisible();
    await expect(money.getByText("Changes where money goes")).toBeVisible();
    // The chip text includes its glyph ("○Waiting").
    await expect(money.locator(".ch-chip").filter({ hasText: "Waiting" })).toBeVisible();
    await expect(money.getByText("Can be applied from")).toBeVisible();
    await expect(money.getByText("Outside the admin console")).toBeVisible();

    const fee = page.locator(`#change-${feeOp}`);
    await expect(fee.getByText("Platform fee: set to 3%")).toBeVisible();
    await expect(fee.locator(".ch-chip").filter({ hasText: "Applied" })).toBeVisible();
    await expect(fee.getByText("Changes where money goes")).toHaveCount(0);

    await context.close();

    // axe needs JavaScript: the same page in the normal context.
    await jsPage.goto("/en/contract-changes");
    await expect(jsPage.locator(`#change-${moneyOp}`)).toBeVisible();
    const axe = await new AxeBuilder({ page: jsPage }).analyze();
    expect(axe.violations).toEqual([]);
  });

  test("the Emergency Pool page announces the waiting change and links to it; the footer links the list", async ({ page }) => {
    await page.goto("/en/emergency-pool");
    const notice = page.getByRole("status").filter({ hasText: "A change to where Emergency Pool money goes is scheduled" });
    await expect(notice).toBeVisible();
    await notice.getByRole("link", { name: "See the scheduled change" }).click();
    await expect(page).toHaveURL(new RegExp(`/en/contract-changes#change-${moneyOp}$`));
    await expect(page.locator(`#change-${moneyOp}`)).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Footer navigation" }).getByRole("link", { name: "Contract changes" })).toBeVisible();
  });
});
