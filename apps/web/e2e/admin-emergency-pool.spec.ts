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
import { createApprovedOrganization, createSubmittedCampaign, deleteTestUser, loginAsNewUser } from "./helpers/session";
import { createHash, randomBytes } from "node:crypto";
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
    await page.getByRole("navigation", { name: "Admin menu" }).getByRole("link", { name: "Emergency Pool", exact: true }).click();
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

  test("the Operator proposes an allocation with a public reason; the page shows it, checkable by its hash", async ({ page, context, browser }, info) => {
    const run = `alloc-${info.project.name}-${Date.now()}`;
    const names = await seed(run);
    const adminId = await loginAsNewUser(context, `alloc-admin-${run}`, { admin: true });
    userIds.push(adminId);
    const other = await browser.newContext();
    const ownerId = await loginAsNewUser(other, `alloc-owner-${run}`);
    await other.close();
    userIds.push(ownerId);
    const orgId = await createApprovedOrganization(ownerId, `E2E Alloc Org ${run}`);
    const title = `E2E alloc campaign ${run}`;
    const campaignId = await createSubmittedCampaign(ownerId, orgId, title, `campaigns/e2e-${run}/c.webp`);
    const address = `0x${randomBytes(20).toString("hex")}`;
    const deadline = Math.floor(Date.now() / 1000) + 30 * 86_400;
    const client = db();
    try {
      await client.execute(sql`update app.campaigns set status = 'DEPLOYED', eur_usd_rate = '1.17000000', rate_source = 'ECB', rate_at = now(),
        target_usdc = 1000000000, beneficiary_address = ${"0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"}, deadline = to_timestamp(${deadline}),
        onchain_address = ${address}, deployed_at = now() where id = ${campaignId}`);
      await client.execute(sql`insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, state, tx_hash, log_index, block_number, block_time)
        values (${address}, ${`0x${randomBytes(32).toString("hex")}`}, ${"0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed"}, 0, 1000000000, ${deadline}, 'LIVE', ${`0x${randomBytes(32).toString("hex")}`}, 0, 1, ${deadline - 86_400})`);
    } finally {
      await client.$client.end();
    }
    await installAdminWallet(page, ["OPERATOR_ROLE"]);

    try {
      await page.goto("/en/admin/emergency-pool");
      const form = page.getByRole("region", { name: "Propose an allocation" });
      await form.getByRole("combobox", { name: "Sub-pool" }).click();
      await page.getByRole("option", { name: new RegExp(`^${names.live} — 12.50 USDC`) }).click();
      await form.getByRole("combobox", { name: "Live campaign" }).click();
      await page.getByRole("option", { name: title, exact: true }).click();
      await form.getByRole("textbox", { name: "Amount" }).fill("20");
      await form.getByRole("textbox", { name: "Public reason" }).fill("x");
      await form.getByRole("textbox", { name: "Amount" }).blur();
      await expect(form.getByText("This sub-pool has only 12.50 USDC available.")).toBeVisible();
      await form.getByRole("textbox", { name: "Amount" }).fill("7.5");
      const reason = `Floods in the valley — the shelter (${run}) needs food for 40 dogs.`;
      await form.getByRole("textbox", { name: "Public reason" }).fill(reason);
      await expectNoA11yViolations(page, "admin propose allocation");
      await form.getByRole("button", { name: "Propose and sign" }).click();
      await expect(form.getByRole("status").filter({ hasText: "Proposed." })).toBeVisible();

      const hash = `0x${createHash("sha256").update(reason, "utf8").digest("hex")}`;
      expect(await sentCalls(page)).toEqual([{ fn: "proposeAllocation", args: [ids[0], expect.stringMatching(new RegExp(`^${address}$`, "i")), 7_500_000n, hash] }]);

      // The indexer sees AllocationProposed: the public page shows the reason under the vote.
      const c2 = db();
      const allocationId = String(ids[0]);
      try {
        await c2.execute(sql`insert into chain.allocation (id, pool_id, campaign, amount, delivered, reason_hash, yes_votes, no_votes, vote_end, proposal_block, snap_quorum_bps, snap_approval_bps, state)
          values (${allocationId}, ${ids[0]}, ${address}, 7500000, null, ${hash}, 0, 0, ${deadline - 86_400}, 2, 2500, 5100, 'VOTING')`);
        const audit = await c2.select({ action: schema.auditLog.action }).from(schema.auditLog)
          .where(and(eq(schema.auditLog.actorUserId, adminId), inArray(schema.auditLog.action, ["pool.allocation_reason_saved", "pool.allocation_propose.sent"])));
        expect(audit.map((a) => a.action).sort()).toEqual(["pool.allocation_propose.sent", "pool.allocation_reason_saved"]);
      } finally {
        await c2.$client.end();
      }
      await page.goto("/en/emergency-pool");
      const vote = page.getByRole("listitem").filter({ hasText: `Allocation #${allocationId}` });
      await expect(vote).toContainText(reason);
      await expect(vote).toContainText(`Check: SHA-256 of this text = ${hash}`);
      await expect(vote.getByRole("link", { name: title })).toBeVisible();
    } finally {
      const c3 = db();
      try {
        await c3.execute(sql`delete from chain.allocation where id = ${String(ids[0])}`);
        await c3.execute(sql`delete from chain.campaign where address = ${address}`);
      } finally {
        await c3.$client.end();
      }
    }
  });
});
