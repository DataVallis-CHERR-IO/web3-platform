/**
 * apps/web/e2e/guardian.spec.ts
 * Admin chain actions (TASK-033d): the queue, a NEEDS_REVIEW campaign decided
 * by the Guardian with a required note, the payout mode set by the operator,
 * and a wallet without the role. `chain.*` is simulated by tables; the wallet
 * is a fake EIP-1193 provider (APP_ENV=local only) that answers PlatformConfig
 * role reads and accepts every Campaign simulation.
 * TASK-033f: the manual fallbacks (finish 7 days late, move unclaimed refunds)
 * are sent from an admin wallet without any role.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { and, eq, like, sql } from "drizzle-orm";
import { decodeFunctionData, type Hex } from "viem";
import * as schema from "@cherrio/db";
import { CampaignAbi } from "@cherrio/contracts/abis";
import { ensureFakeChain, deleteFakeChainRows } from "../src/__tests__/helpers/fake-chain";
import { createApprovedOrganization, deleteTestUser, loginAsNewUser } from "./helpers/session";
import { ADMIN_WALLET, installAdminWallet } from "./helpers/admin-wallet";

const PAYOUT = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
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

async function sentCalls(page: Page) {
  const data = await page.evaluate(() => (window as unknown as { __sent: string[] }).__sent);
  return data.map((d) => {
    const call = decodeFunctionData({ abi: CampaignAbi, data: d as Hex });
    return { fn: call.functionName, args: call.args ?? [] };
  });
}

test.describe("admin chain actions", () => {
  const userIds: string[] = [];
  const chainAddresses: string[] = [];

  test.afterEach(async () => {
    const client = db();
    try {
      for (const a of chainAddresses.splice(0)) await deleteFakeChainRows(client, a);
    } finally {
      await client.$client.end();
    }
    // Owner first (their campaigns and the audit rows on them), then the admin.
    for (const id of userIds.splice(0)) await deleteTestUser(id);
  });

  async function campaign(run: string, ownerId: string, orgId: string, n: number, chain: { state: string; payoutMode: number | null; round?: boolean; deadline?: number; settlementStart?: number; sweepDelay?: number }) {
    const client = db();
    const address = hex(20);
    chainAddresses.push(address);
    try {
      await ensureFakeChain(client);
      const [row] = await client
        .insert(schema.campaigns)
        .values({
          orgId, starterUserId: ownerId, beneficiaryType: "ORGANIZATION", title: `E2E guardian ${run} ${n}`,
          slug: `e2e-guardian-${run}-${n}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
          story: { format: "plain", text: "Help us fix the shelter roof." }, cause: "animals", country: "SI",
          targetEurCents: "1000000", durationDays: 30, status: "DEPLOYED", eurUsdRate: "1.17000000", rateSource: "ECB",
          rateAt: new Date(), targetUsdc: 1000n * U, beneficiaryAddress: PAYOUT,
          deadline: new Date((now() - 86_400) * 1000), onchainAddress: address, submittedAt: new Date(), deployedAt: new Date(),
        })
        .returning({ id: schema.campaigns.id });
      const bundleHash = hex(32);
      await client.execute(sql`
        insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, tx_hash, log_index, block_number, block_time,
          state, payout_mode, tranches_released, current_round, total_raised, released, end_time, vote_end,
          snap_vote_window, snap_quorum_bps, snap_approval_bps, settlement_start, snap_refund_sweep_delay)
        values (${address}, ${hex(32)}, ${PAYOUT}, 0, ${(1000n * U).toString()}, ${chain.deadline ?? now() - 86_400}, ${hex(32)}, 0, 1, ${now()},
          ${chain.state}, ${chain.payoutMode}, ${chain.round ? 1 : 0}, ${chain.round ? 1 : 0}, ${(600n * U).toString()},
          ${chain.round ? (198n * U).toString() : "0"}, ${now() - 86_000 + n}, ${chain.round ? now() - 60 : 0}, 3600, 2500, 5100,
          ${chain.settlementStart ?? 0}, ${chain.sweepDelay ?? 15_552_000})
      `);
      if (chain.round) {
        // 60 of 600 USDC voted (10 % < 25 % quorum) → NEEDS_REVIEW.
        await client.execute(sql`
          insert into chain.vote_round (campaign, round, bundle_hash, vote_end, yes_votes, no_votes, outcome, closed_at, tx_hash, log_index, block_number, block_time)
          values (${address}, 1, ${bundleHash}, ${now() - 60}, ${(40n * U).toString()}, ${(20n * U).toString()}, 'NEEDS_REVIEW', ${now() - 30}, ${hex(32)}, 0, 2, ${now()})
        `);
        await client.insert(schema.evidenceBundles).values({
          campaignId: row!.id, round: 1, note: "Roof beams bought; invoice attached.", bundleHash: Buffer.from(bundleHash.slice(2), "hex"),
          manifest: "{}", sealedAt: new Date(), status: "SUBMITTED_ONCHAIN",
        });
      }
      return { id: row!.id, address };
    } finally {
      await client.$client.end();
    }
  }

  test("the Guardian decides a vote with a note; the operator sets the payout plan", async ({ page, context }, info) => {
    const run = `gd-${info.project.name}-${Date.now()}`;
    const ownerId = await loginAsNewUser(context, `guardian-owner-${run}`);
    const orgId = await createApprovedOrganization(ownerId, `E2E Guardian Org ${run}`);
    const adminId = await loginAsNewUser(context, `guardian-admin-${run}`, { admin: true });
    userIds.push(ownerId, adminId);
    const review = await campaign(run, ownerId, orgId, 1, { state: "NEEDS_REVIEW", payoutMode: 1, round: true });
    const succeeded = await campaign(run, ownerId, orgId, 2, { state: "SUCCEEDED", payoutMode: null });
    await installAdminWallet(page, ["OPERATOR_ROLE", "GUARDIAN_ROLE"]);

    // Queue
    await page.goto("/en/admin/guardian");
    const queue = page.getByRole("region", { name: "Chain actions" });
    await expect(queue.getByRole("row", { name: new RegExp(`E2E guardian ${run} 1 .*Decide the vote`) })).toBeVisible();
    await expect(queue.getByRole("row", { name: new RegExp(`E2E guardian ${run} 2 .*Set the payout plan`) })).toBeVisible();
    await expectNoA11yViolations(page, "chain actions queue");

    // Review: state, vote result, evidence, wallet roles
    await queue.getByRole("link", { name: `E2E guardian ${run} 1` }).click();
    const section = page.locator("section[aria-labelledby='chain-actions']");
    await expect(section.getByRole("row", { name: /State Needs a Guardian decision/ })).toBeVisible();
    await expect(section.getByRole("row", { name: /Turnout \(quorum 25 %\) 10 %/ })).toBeVisible();
    await expect(section.getByRole("row", { name: /Yes votes \(needed 51 %\) 66\.7 %/ })).toBeVisible();
    await expect(section.getByText("Evidence before payment 2 of 3 · On the blockchain")).toBeVisible();
    await expect(section.getByText("Roof beams bought; invoice attached.")).toBeVisible();
    await expect(section.getByRole("list", { name: "Connected wallets" })).toContainText(`${ADMIN_WALLET}: Operator, Guardian`);

    const reject = section.getByRole("button", { name: "Reject — donors get the rest back" });
    await expect(reject).toBeDisabled();
    await section.getByLabel(/^Note \(required/).first().fill("short");
    await expect(section.getByText("Write a note of at least 10 characters.").first()).toBeVisible();
    await expect(reject).toBeDisabled();
    await section.getByLabel(/^Note \(required/).first().fill("Only 10 % voted; the invoices do not match the plan.");
    await expectNoA11yViolations(page, "admin campaign — review");
    await reject.click();
    await expect(section.getByRole("status").filter({ hasText: "Sent." })).toBeVisible();
    expect(await sentCalls(page)).toEqual([{ fn: "resolve", args: [false] }]);

    // The note and the transaction are on the page and in audit_log.
    const log = section.getByRole("list", { name: "Notes and transactions" });
    await expect(log).toContainText("decided: reject");
    await expect(log).toContainText("Only 10 % voted; the invoices do not match the plan.");
    await expect(log).toContainText(`0x${"cd".repeat(32)}`);
    const client = db();
    try {
      const rows = await client
        .select({ action: schema.auditLog.action })
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.entityId, review.id), like(schema.auditLog.action, "chain.%")));
      expect(rows.map((r) => r.action).sort()).toEqual(["chain.resolve.requested", "chain.resolve.sent"]);
    } finally {
      await client.$client.end();
    }

    // Payout plan: the organisation's second campaign without a rating → "milestones" suggested
    // (and preselected); the admin decides otherwise.
    await page.goto(`/en/admin/campaigns/${succeeded.id}`);
    await expect(section.getByText(/Suggested: Three milestone payments — not the first campaign and no rating yet/)).toBeVisible();
    await expect(section.getByRole("radio", { name: "Three milestone payments" })).toBeChecked();
    await section.getByRole("radio", { name: "One payment", exact: true }).check();
    await section.getByRole("button", { name: "Set the payout plan" }).click();
    await expect(section.getByRole("status").filter({ hasText: "Sent." })).toBeVisible();
    expect(await sentCalls(page)).toEqual([{ fn: "setPayoutMode", args: [0] }]);
  });

  test("a wallet without the Guardian role cannot freeze", async ({ page, context }, info) => {
    const run = `gn-${info.project.name}-${Date.now()}`;
    const ownerId = await loginAsNewUser(context, `guardian-owner-${run}`);
    const orgId = await createApprovedOrganization(ownerId, `E2E Guardian Org ${run}`);
    const adminId = await loginAsNewUser(context, `guardian-admin-${run}`, { admin: true });
    userIds.push(ownerId, adminId);
    const live = await campaign(run, ownerId, orgId, 1, { state: "LIVE", payoutMode: null });
    await installAdminWallet(page, ["OPERATOR_ROLE"]);

    await page.goto(`/en/admin/campaigns/${live.id}`);
    const section = page.locator("section[aria-labelledby='chain-actions']");
    await expect(section.getByRole("list", { name: "Connected wallets" })).toContainText(`${ADMIN_WALLET}: Operator`);
    await expect(section.getByText("None of your connected wallets has the Guardian role.")).toBeVisible();
    await section.getByLabel(/^Note \(required/).fill("Reported as a scam by the bank.");
    await section.getByLabel("I understand that this stops the campaign for everyone.").check();
    await expect(section.getByRole("button", { name: "Freeze the campaign" })).toBeDisabled();
    expect(await sentCalls(page)).toEqual([]);
  });

  test("nobody acted: an admin wallet without a role finishes the campaign and moves unclaimed refunds (TASK-033f)", async ({ page, context }, info) => {
    const run = `gf-${info.project.name}-${Date.now()}`;
    const ownerId = await loginAsNewUser(context, `guardian-owner-${run}`);
    const orgId = await createApprovedOrganization(ownerId, `E2E Guardian Org ${run}`);
    const adminId = await loginAsNewUser(context, `guardian-admin-${run}`, { admin: true });
    userIds.push(ownerId, adminId);
    const late = await campaign(run, ownerId, orgId, 1, { state: "LIVE", payoutMode: null, deadline: now() - 8 * 86_400 });
    const failed = await campaign(run, ownerId, orgId, 2, { state: "FAILED", payoutMode: null, settlementStart: now() - 200 * 86_400, sweepDelay: 180 * 86_400 });
    // Still inside the 7 days: not in the queue.
    await campaign(run, ownerId, orgId, 3, { state: "LIVE", payoutMode: null, deadline: now() - 86_400 });
    await installAdminWallet(page, []);

    await page.goto("/en/admin/guardian");
    const queue = page.getByRole("region", { name: "Chain actions" });
    await expect(queue.getByRole("row", { name: new RegExp(`E2E guardian ${run} 1 .*Finish — nobody did for 7 days`) })).toBeVisible();
    await expect(queue.getByRole("row", { name: new RegExp(`E2E guardian ${run} 2 .*Move unclaimed refunds to the Emergency Pool`) })).toBeVisible();
    await expect(queue.getByRole("row", { name: new RegExp(`E2E guardian ${run} 3 `) })).toHaveCount(0);

    await page.goto(`/en/admin/campaigns/${late.id}`);
    const section = page.locator("section[aria-labelledby='chain-actions']");
    await expect(section.getByRole("list", { name: "Connected wallets" })).toContainText(`${ADMIN_WALLET}: no role`);
    await expect(section.getByRole("heading", { name: "CHERR.IO steps in" })).toBeVisible();
    await expectNoA11yViolations(page, "admin campaign — fallback finalize");
    await section.getByRole("button", { name: "Finish the campaign" }).click();
    await expect(section.getByRole("status").filter({ hasText: "Sent." })).toBeVisible();
    expect(await sentCalls(page)).toEqual([{ fn: "finalize", args: [] }]);
    await expect(section.getByRole("list", { name: "Notes and transactions" })).toContainText("finished the campaign (7 days after the deadline)");

    await page.goto(`/en/admin/campaigns/${failed.id}`);
    const sweep = section.getByRole("button", { name: "Move to the Emergency Pool" });
    await expect(sweep).toBeDisabled();
    await section.getByLabel("I understand that donors can no longer claim a refund afterwards.").check();
    await sweep.click();
    await expect(section.getByRole("status").filter({ hasText: "Sent." })).toBeVisible();
    expect(await sentCalls(page)).toEqual([{ fn: "sweepUnclaimed", args: [] }]);
  });
});
