/**
 * apps/web/e2e/admin-emergency-pool.spec.ts
 * Admin → Emergency Pool (TASK-046): the sub-pool table (app rows ⨝ indexed
 * pools), the Operator creating a missing sub-pool on chain from the fake
 * wallet, the audit record, and a wallet without the Operator role. Each run
 * uses its own pool ids, so the two viewport projects never share rows.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { and, eq, inArray, sql } from "drizzle-orm";
import { decodeFunctionData, type Hex } from "viem";
import * as schema from "@cherrio/db";
import { EmergencyPoolAbi } from "@cherrio/contracts/abis";
import { ensureFakeChain } from "../src/__tests__/helpers/fake-chain";
import { deleteTestUser, loginAsNewUser } from "./helpers/session";
import { installAdminWallet } from "./helpers/admin-wallet";

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

async function sentCalls(page: Page) {
  const data = await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent);
  return data.map((d) => {
    const call = decodeFunctionData({ abi: EmergencyPoolAbi, data: d as Hex });
    return { fn: call.functionName, args: call.args ?? [] };
  });
}

test.describe("admin Emergency Pool", () => {
  const userIds: string[] = [];
  let ids: number[] = [];

  test.afterEach(async () => {
    const client = db();
    try {
      if (ids.length) {
        await client.execute(sql`delete from chain.pool where id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
        const rows = await client.select({ id: schema.emergencySubpools.id }).from(schema.emergencySubpools).where(inArray(schema.emergencySubpools.poolId, ids));
        if (rows.length) await client.delete(schema.auditLog).where(inArray(schema.auditLog.entityId, rows.map((r) => r.id)));
        await client.delete(schema.emergencySubpools).where(inArray(schema.emergencySubpools.poolId, ids));
      }
    } finally {
      await client.$client.end();
    }
    ids = [];
    for (const id of userIds.splice(0)) await deleteTestUser(id);
  });

  async function seed(run: string) {
    // Unique per project and run: 9400000–9899999.
    const base = 9_400_000 + (Date.now() % 100_000) * 5 + (run.includes("390") ? 2 : 0);
    ids = [base, base + 1];
    const client = db();
    try {
      await ensureFakeChain(client);
      await client.insert(schema.emergencySubpools).values(
        ids.map((poolId, i) => ({ poolId, slug: `e2e-${run}-${i ? "missing" : "live"}`, nameKey: "x", descriptionKey: "x" }))
      );
      await client.execute(sql`insert into chain.pool (id, balance, total_contributed) values (${ids[0]}, 12500000, 20000000)`);
    } finally {
      await client.$client.end();
    }
    return { live: `e2e-${run}-live`, missing: `e2e-${run}-missing` };
  }

  test("the Operator creates a missing sub-pool on chain; it is recorded", async ({ page, context }, info) => {
    const run = `pool-${info.project.name}-${Date.now()}`;
    const names = await seed(run);
    const adminId = await loginAsNewUser(context, `pool-admin-${run}`, { admin: true });
    userIds.push(adminId);
    await installAdminWallet(page, ["OPERATOR_ROLE"]);

    await page.goto("/en/admin");
    await page.locator("#main").getByRole("link", { name: "Emergency Pool sub-pools" }).click();
    await expect(page.getByRole("heading", { name: "Sub-pools", exact: true })).toBeVisible();
    const table = page.getByRole("region", { name: "Sub-pools" });
    await expect(table.getByRole("row", { name: "Medical emergencies 1" })).toBeVisible();
    await expect(table.getByRole("row", { name: `${names.live} ${ids[0]} Yes 12.50 USDC` })).toBeVisible();
    await expect(table.getByRole("row", { name: `${names.missing} ${ids[1]} Not yet —` })).toBeVisible();

    const create = page.getByRole("button", { name: `Create “${names.missing}” on the blockchain` });
    await expect(create).toBeEnabled();
    await expectNoA11yViolations(page, "admin emergency pool");
    await create.click();
    await expect(page.getByRole("status").filter({ hasText: "Created." })).toBeVisible();
    expect(await sentCalls(page)).toEqual([{ fn: "createSubPool", args: [ids[1]] }]);
    // No second button until the indexer shows it (a second click would only meet PoolAlreadyExists).
    await expect(create).toHaveCount(0);
    await expect(page.getByText("Sent — waiting for the indexer (about a minute)")).toBeVisible();

    const client = db();
    try {
      const audit = await client
        .select({ data: schema.auditLog.data })
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.actorUserId, adminId), eq(schema.auditLog.action, "pool.subpool_create.sent")));
      expect(audit).toEqual([{ data: { poolId: ids[1], slug: names.missing, txHash: `0x${"cd".repeat(32)}` } }]);
    } finally {
      await client.$client.end();
    }
  });

  test("a wallet without the Operator role cannot create a sub-pool", async ({ page, context }, info) => {
    const run = `pool-norole-${info.project.name}-${Date.now()}`;
    const names = await seed(run);
    const adminId = await loginAsNewUser(context, `pool-norole-${run}`, { admin: true });
    userIds.push(adminId);
    await installAdminWallet(page, []);

    await page.goto("/en/admin/emergency-pool");
    await expect(page.getByText("Creating a sub-pool needs the Operator role. None of your connected wallets has it.")).toBeVisible();
    await expect(page.getByRole("button", { name: `Create “${names.missing}” on the blockchain` })).toBeDisabled();
    expect(await sentCalls(page)).toEqual([]);
  });
});
