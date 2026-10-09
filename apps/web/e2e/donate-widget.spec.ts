/**
 * apps/web/e2e/donate-widget.spec.ts
 * TASK-019: another website embeds a campaign with /widget.js + <cherrio-donate>.
 * The iframe shows the organisation, title, progress and a Donate link that opens
 * the campaign in a new tab; the widget page may be framed by any site, the app
 * itself may not (clickjacking). Needs Postgres; chain rows are simulated.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect } from "@playwright/test";
import { sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { ensureFakeChain, deleteFakeChainRows } from "../src/__tests__/helpers/fake-chain";
import { createApprovedOrganization, deleteTestUser } from "./helpers/session";

const hex = (bytes: number) => `0x${randomBytes(bytes).toString("hex")}`;

test.describe("donate widget", () => {
  let userId = "";
  let address = "";
  let slug = "";
  let title = "";

  test.beforeEach(async ({ browserName: _b }, info) => {
    const run = `${info.project.name}-${Date.now()}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
    title = `Widget <b>${run}</b>`;
    address = hex(20);
    const client = schema.createDb(process.env.DATABASE_URL!, { max: 1 });
    try {
      await ensureFakeChain(client);
      const [owner] = await client
        .insert(schema.users)
        .values({ displayName: `E2E widget ${run}`, privyDid: `privy|e2e-widget-${run}` })
        .returning({ id: schema.users.id });
      userId = owner!.id;
      const orgId = await createApprovedOrganization(userId, `E2E Widget Org ${run}`);
      const deadline = Math.floor(Date.now() / 1000) + 5 * 86_400 + 3600;
      const [c] = await client
        .insert(schema.campaigns)
        .values({
          orgId, starterUserId: userId, beneficiaryType: "ORGANIZATION", title, slug: `e2e-widget-${run}`,
          story: { format: "plain", text: "Story." }, cause: "animals", country: "SI", goalAmountMinor: "1500000", durationDays: 30,
          status: "DEPLOYED", eurUsdRate: "1.17000000", rateSource: "ECB", rateAt: new Date(), targetUsdc: 17_550_000_000n,
          beneficiaryAddress: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", deadline: new Date(deadline * 1000),
          onchainAddress: address, submittedAt: new Date(), deployedAt: new Date(),
        })
        .returning({ slug: schema.campaigns.slug });
      slug = c!.slug;
      await client.execute(sql`
        insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, state,
                                    total_raised, tx_hash, log_index, block_number, block_time)
        values (${address}, ${hex(32)}, '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', 0, 17550000000, ${deadline}, 'LIVE',
                4387500000, ${hex(32)}, 0, 1, ${Math.floor(Date.now() / 1000)})
      `);
    } finally {
      await client.$client.end();
    }
  });

  test.afterEach(async () => {
    const client = schema.createDb(process.env.DATABASE_URL!, { max: 1 });
    try {
      if (address) await deleteFakeChainRows(client, address);
    } finally {
      await client.$client.end();
    }
    if (userId) await deleteTestUser(userId);
  });

  test("an outside page embeds the campaign; Donate opens it in a new tab", async ({ page, request }, info) => {
    const base = info.project.use.baseURL!;
    // The host page is "someone else's site": a small server on another origin
    // (127.0.0.1:<port> vs localhost:3000), both loopback for Chrome's private-network rules.
    const html = `<!doctype html><html><body><h1>Partner site</h1><script src="${base}/widget.js"></script><cherrio-donate campaign="${slug}"></cherrio-donate></body></html>`;
    const partner = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
    await new Promise<void>((resolve) => partner.listen(0, "127.0.0.1", resolve));
    const port = (partner.address() as AddressInfo).port;
    try {
      await page.goto(`http://127.0.0.1:${port}/`);
    const frame = page.frameLocator("cherrio-donate iframe");
    await expect(frame.getByRole("heading", { level: 1 })).toHaveText(title); // escaped, not HTML
    await expect(frame.getByText(/E2E Widget Org/)).toBeVisible();
    await expect(frame.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    await expect(frame.getByText(/25 % of €15,000 goal/)).toBeVisible();
    const donate = frame.getByRole("link", { name: "Donate" });
    await expect(donate).toHaveAttribute("target", "_blank");
    await expect(donate).toHaveAttribute("href", new RegExp(`/en/campaigns/${slug}\\?utm_source=widget$`));

    const embed = await request.get(`/embed/campaigns/${slug}`);
    expect(embed.headers()["content-security-policy"]).toContain("frame-ancestors *");
    expect((await request.get("/embed/campaigns/unknown-slug-xyz")).status()).toBe(404);
    const app = await request.get("/en");
    expect(app.headers()["x-frame-options"]).toBe("SAMEORIGIN");
    expect(app.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
    } finally {
      partner.close();
    }
  });

  test("the campaign page offers the code to embed", async ({ page }) => {
    await page.goto(`/en/campaigns/${slug}`);
    await page.getByText("Put this campaign on your website").click();
    await expect(page.getByLabel("Code to embed")).toHaveValue(new RegExp(`<cherrio-donate campaign="${slug}"></cherrio-donate>`));
  });
});
