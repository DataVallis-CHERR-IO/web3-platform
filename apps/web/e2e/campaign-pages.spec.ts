/**
 * apps/web/e2e/campaign-pages.spec.ts
 * Public campaign pages (TASK-011a): the list shows a published campaign, the
 * card opens its page, the page shows the story, a video through
 * youtube-nocookie, progress, and the donor list per ADR-043 (a name,
 * "Anonymous", a short address). axe on both pages.
 * Needs Postgres; `chain.*` is simulated by tables (no indexer in E2E).
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { inArray, sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { ensureFakeChain, deleteFakeChainRows } from "../src/__tests__/helpers/fake-chain";
import { createApprovedOrganization, deleteTestUser } from "./helpers/session";

const hex = (bytes: number) => `0x${randomBytes(bytes).toString("hex")}`;
const now = () => Math.floor(Date.now() / 1000);

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("E2E needs DATABASE_URL");
  return schema.createDb(url, { max: 1 });
}

async function expectNoA11yViolations(page: Page, label: string) {
  await expect(page).toHaveTitle(/\S/);
  await page.waitForLoadState("networkidle");
  // The video player is a third-party document (YouTube/Vimeo) whose markup we
  // cannot change; our part — the iframe's title — is checked by the test.
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .exclude(".ch-campaign-video iframe")
    .analyze();
  expect(results.violations, `a11y violations on ${label}`).toEqual([]);
}

test.describe("public campaign pages", () => {
  const userIds: string[] = [];
  const addresses: string[] = [];
  let campaignAddress = "";

  test.afterEach(async () => {
    const client = db();
    try {
      if (campaignAddress) await deleteFakeChainRows(client, campaignAddress);
      if (addresses.length > 0) await client.delete(schema.userAddresses).where(inArray(schema.userAddresses.address, addresses));
    } finally {
      await client.$client.end();
    }
    for (const id of userIds) await deleteTestUser(id);
  });

  test("list → campaign page with story, video, progress and donors", async ({ page }, info) => {
    // No real YouTube in tests: deterministic and offline (CI has internet, the sandbox does not).
    await page.route("https://www.youtube-nocookie.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: '<!doctype html><html lang="en"><title>Video</title><p>Video</p></html>' })
    );
    const run = `${info.project.name}-${Date.now()}`;
    const title = `E2E public ${run}`;
    campaignAddress = hex(20);
    const named = hex(20);
    const anon = hex(20);
    const unknown = hex(20);
    addresses.push(named, anon);

    const client = db();
    try {
      await ensureFakeChain(client);
      const [owner, donorNamed, donorAnon] = await client
        .insert(schema.users)
        .values([
          { displayName: `E2E owner ${run}`, privyDid: `privy|e2e-pub-owner-${run}` },
          { displayName: "Maja Novak", privyDid: `privy|e2e-pub-named-${run}` },
          { displayName: "Hidden Donor", privyDid: `privy|e2e-pub-anon-${run}`, anonymousDonations: true },
        ])
        .returning({ id: schema.users.id });
      userIds.push(owner!.id, donorNamed!.id, donorAnon!.id);
      await client.insert(schema.userAddresses).values([
        { userId: donorNamed!.id, address: named, kind: "EXTERNAL" },
        { userId: donorAnon!.id, address: anon, kind: "EMBEDDED" },
      ]);
      const orgId = await createApprovedOrganization(owner!.id, `E2E Public Org ${run}`);
      const deadline = now() + 12 * 86_400;
      const [campaign] = await client
        .insert(schema.campaigns)
        .values({
          orgId, starterUserId: owner!.id, beneficiaryType: "ORGANIZATION", title,
          slug: `e2e-public-${run}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
          story: { format: "plain", text: "The roof of our shelter leaks.\n\nWith your help we replace it before winter." },
          cause: "animals", country: "SI", goalAmountMinor: "1000000", durationDays: 30, status: "DEPLOYED",
          eurUsdRate: "1.17000000", rateSource: "ECB", rateAt: new Date(), targetUsdc: 11_700_000_000n,
          beneficiaryAddress: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", deadline: new Date(deadline * 1000),
          onchainAddress: campaignAddress, submittedAt: new Date(), deployedAt: new Date(),
        })
        .returning({ id: schema.campaigns.id, slug: schema.campaigns.slug });
      await client.insert(schema.campaignMedia).values({
        campaignId: campaign!.id, kind: "VIDEO", cid: "youtube:dQw4w9WgXcQ", storage: "EXTERNAL", sort: 0, createdBy: owner!.id,
      });
      await client.execute(sql`
        insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, state,
                                    total_raised, tx_hash, log_index, block_number, block_time)
        values (${campaignAddress}, ${hex(32)}, '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 0, 11700000000, ${deadline}, 'LIVE',
                1500000000, ${hex(32)}, 0, 1, ${now()})
      `);
      let block = 10;
      for (const [donor, amount] of [[named, 500_000_000n], [anon, 700_000_000n], [unknown, 300_000_000n]] as const) {
        block += 1;
        await client.execute(sql`
          insert into chain.donation (id, campaign, donor, amount, preference, sub_pool_id, tx_hash, log_index, block_number, block_time)
          values (${`${campaignAddress}-${block}`}, ${campaignAddress}, ${donor}, ${amount.toString()}::numeric, 0, 0, ${hex(32)}, 0, ${block}, ${now()})
        `);
        await client.execute(sql`
          insert into chain.campaign_donor (campaign, donor, donated, preference, sub_pool_id)
          values (${campaignAddress}, ${donor}, ${amount.toString()}::numeric, 0, 0)
        `);
      }

      await page.goto("/en/campaigns");
      await expect(page.getByRole("heading", { level: 1, name: "Campaigns" })).toBeVisible();
      const card = page.getByRole("link", { name: title });
      await expect(card).toBeVisible();
      await expectNoA11yViolations(page, "/en/campaigns");

      await card.click();
      await expect(page).toHaveURL(new RegExp(`/en/campaigns/${campaign!.slug}$`));
      await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
      await expect(page.getByText("The roof of our shelter leaks.")).toBeVisible();
      await expect(page.getByText("3 donors").first()).toBeVisible();
      await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "13");
      // The panel shows the raised amount once (key figure); the bar has no second figures row.
      const panel = page.locator(".ch-campaign-panel");
      await expect(panel.locator(".ch-campaign-key")).toHaveCount(1);
      await expect(panel.locator(".ch-progress-figures")).toHaveCount(0);
      await expect(panel.locator(".ch-progress-meta")).toContainText(/\d+% raised/);

      const video = page.locator("iframe");
      await expect(video).toHaveAttribute("src", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
      await expect(video).toHaveAttribute("title", `Video 1 about ${title}`);

      const ledger = page.locator("#proof table");
      await expect(ledger.getByText("Maja Novak")).toBeVisible();
      await expect(ledger.getByText("Anonymous")).toBeVisible();
      await expect(ledger.getByText(`${unknown.slice(0, 6)}…${unknown.slice(-4)}`)).toBeVisible();
      await expect(page.getByText("Hidden Donor")).toHaveCount(0);
      await expectNoA11yViolations(page, "/en/campaigns/[slug]");

      const missing = await page.goto("/en/campaigns/no-such-campaign-e2e");
      expect(missing?.status()).toBe(404);
    } finally {
      await client.$client.end();
    }
  });
});
