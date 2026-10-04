/**
 * apps/web/e2e/evidence.spec.ts
 * Milestone evidence on the fundraiser's dashboard (TASK-033c part 2, ADR-047):
 * after payment 1 the organisation adds a note, a private and a public file,
 * seals, and the payout wallet submits `submitEvidence(bundleHash)`. `chain.*`
 * is simulated by tables; the wallet is the E2E wallet (APP_ENV=local only).
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { getAddress } from "viem";
import * as schema from "@cherrio/db";
import { ensureFakeChain, deleteFakeChainRows } from "../src/__tests__/helpers/fake-chain";
import { createApprovedOrganization, deleteTestUser, loginAsNewUser } from "./helpers/session";
import { installWallet, sentCalls } from "./helpers/wallet";

const hex = (bytes: number) => `0x${randomBytes(bytes).toString("hex")}`;
const now = () => Math.floor(Date.now() / 1000);
const PAYOUT = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";

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

test.describe("milestone evidence", () => {
  const userIds: string[] = [];
  const chainAddresses: string[] = [];

  test.afterEach(async () => {
    const client = db();
    try {
      for (const a of chainAddresses.splice(0)) await deleteFakeChainRows(client, a);
    } finally {
      await client.$client.end();
    }
    for (const id of userIds.splice(0)) await deleteTestUser(id);
  });

  /** A deployed milestones campaign of the user's organisation, payment 1 sent. */
  async function payingCampaign(run: string, ownerId: string) {
    const client = db();
    const address = hex(20);
    chainAddresses.push(address);
    try {
      await ensureFakeChain(client);
      const orgId = await createApprovedOrganization(ownerId, `E2E Evidence Org ${run}`);
      const [row] = await client
        .insert(schema.campaigns)
        .values({
          orgId, starterUserId: ownerId, beneficiaryType: "ORGANIZATION", title: `E2E evidence ${run}`,
          slug: `e2e-evidence-${run}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
          story: { format: "plain", text: "Help us fix the shelter roof." }, cause: "animals", country: "SI",
          targetEurCents: "1000000", durationDays: 30, status: "DEPLOYED", eurUsdRate: "1.17000000", rateSource: "ECB",
          rateAt: new Date(), targetUsdc: 1_000_000_000n, beneficiaryAddress: PAYOUT,
          deadline: new Date((now() - 86_400) * 1000), onchainAddress: address, submittedAt: new Date(), deployedAt: new Date(),
        })
        .returning({ id: schema.campaigns.id });
      await client.execute(sql`
        insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, tx_hash, log_index, block_number, block_time,
          state, payout_mode, tranches_released, total_raised, released, snap_vote_window, snap_quorum_bps, snap_approval_bps)
        values (${address}, ${hex(32)}, ${PAYOUT}, 0, 1000000000, ${now() - 86_400}, ${hex(32)}, 0, 1, ${now()},
          'PAYING', 1, 1, 600000000, 198000000, 3600, 2500, 5100)
      `);
      return { id: row!.id, address };
    } finally {
      await client.$client.end();
    }
  }

  test("the organisation adds evidence and the payout wallet submits its fingerprint", async ({ page, context }, info) => {
    const run = `ev-${info.project.name}-${Date.now()}`;
    const userId = await loginAsNewUser(context, `evidence-${run}`);
    userIds.push(userId);
    const c = await payingCampaign(run, userId);
    await installWallet(page, getAddress(PAYOUT));

    await page.goto(`/en/account/campaigns/${c.id}`);
    await expect(page.locator("#lifecycle").getByRole("heading", { name: "Payment 2 of 3 is next" })).toBeVisible();
    const section = page.locator("#evidence");
    await expect(section.getByRole("heading", { name: "Evidence before payment 2 of 3" })).toBeVisible();
    await expect(section.getByRole("button", { name: "Seal and submit to the blockchain" })).toBeDisabled();

    await section.getByLabel("Note to donors").fill("Roof beams bought; invoice attached, photos of the work.");
    await section.getByRole("button", { name: "Save the note" }).click();
    await expect(section.getByRole("status")).toContainText("Note saved.");

    const pdf = Buffer.from(`%PDF-1.4\n% invoice ${run}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
    await section.getByLabel("Add a file").setInputFiles({ name: "invoice.pdf", mimeType: "application/pdf", buffer: pdf });
    await expect(section.getByRole("heading", { name: "Files (1 of 10)" })).toBeVisible();
    await expect(section.getByRole("link", { name: "Download" })).toHaveAttribute("href", /\/api\/campaigns\/.+\/evidence\/files\//);

    await section.getByLabel(/^Public/).check();
    const photo = await sharp({ create: { width: 320, height: 240, channels: 3, background: "#7a4b2a" } }).png().toBuffer();
    await section.getByLabel("Add a file").setInputFiles({ name: "roof.png", mimeType: "image/png", buffer: photo });
    await expect(section.getByRole("heading", { name: "Files (2 of 10)" })).toBeVisible();
    await expect(section.getByRole("link", { name: "Open" })).toBeVisible();
    await expectNoA11yViolations(page, "evidence draft");

    await section.getByRole("button", { name: "Seal and submit to the blockchain" }).click();
    await expect(section.getByRole("status")).toContainText("Confirmed.");

    // What the wallet signed is exactly the hash the server sealed.
    const client = db();
    let bundleHash: string;
    try {
      const [bundle] = await client.select().from(schema.evidenceBundles).where(eq(schema.evidenceBundles.campaignId, c.id));
      expect(bundle!.manifest).toContain('"note":"Roof beams bought; invoice attached, photos of the work."');
      bundleHash = `0x${bundle!.bundleHash!.toString("hex")}`;
      // The indexer would now record the round; the dashboard then shows it as on chain.
      await client.execute(sql`
        insert into chain.vote_round (campaign, round, bundle_hash, vote_end, yes_votes, no_votes, tx_hash, log_index, block_number, block_time)
        values (${c.address}, 0, ${bundleHash}, ${now() + 3600}, 0, 0, ${hex(32)}, 0, 2, ${now()})
      `);
      await client.execute(sql`update chain.campaign set state = 'VOTING', current_round = 0, vote_end = ${now() + 3600} where address = ${c.address}`);
    } finally {
      await client.$client.end();
    }
    expect(await sentCalls(page)).toEqual([{ fn: "submitEvidence", args: [bundleHash] }]);

    await page.reload();
    await expect(section.getByRole("heading", { name: "Submitted evidence" })).toBeVisible();
    await expect(section).toContainText("Evidence before payment 2 of 3 · On the blockchain");
    await expect(section).toContainText(bundleHash);
    await expect(section.getByRole("button", { name: /Seal and submit/ })).toHaveCount(0);
  });

  test("without the payout wallet connected, submitting is not offered", async ({ page, context }, info) => {
    const run = `ev-nowallet-${info.project.name}-${Date.now()}`;
    const userId = await loginAsNewUser(context, `evidence-${run}`);
    userIds.push(userId);
    const c = await payingCampaign(run, userId);
    await installWallet(page, getAddress(hex(20))); // some other wallet

    await page.goto(`/en/account/campaigns/${c.id}`);
    const section = page.locator("#evidence");
    await expect(section).toContainText("Connect the campaign's payout wallet (0x5aAe…eAed) to submit.");
    await expect(section.getByRole("button", { name: "Seal and submit to the blockchain" })).toBeDisabled();
  });
});
