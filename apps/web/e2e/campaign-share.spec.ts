/**
 * apps/web/e2e/campaign-share.spec.ts
 * Share box on the campaign page (TASK-055, ADR-057 §5): network links and
 * "Copy link"; a visitor who arrives with `?ref=<code>` gets the first-touch
 * cookie (a later link does not replace it); a signed-in user shares a
 * personal link with their own code. Needs Postgres.
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { eq } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { createApprovedOrganization, deleteTestUser, loginAsNewUser } from "./helpers/session";

async function expectNoA11yViolations(page: Page, label: string) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations, `a11y violations on ${label}`).toEqual([]);
}

const code = () => `e2e${randomBytes(5).toString("hex")}`; // 13 lower-case hex characters

test.describe("campaign share box", () => {
  const userIds: string[] = [];
  let slug = "";
  let ownerCode = "";

  test.beforeEach(async () => {
    const info = test.info();
    const run = `${info.project.name}-${Date.now()}`;
    const client = schema.createDb(process.env.DATABASE_URL!, { max: 1 });
    try {
      ownerCode = code();
      const [owner] = await client
        .insert(schema.users)
        .values({ displayName: `E2E share owner ${run}`, privyDid: `privy|e2e-share-${run}`, refCode: ownerCode })
        .returning({ id: schema.users.id });
      userIds.push(owner!.id);
      const orgId = await createApprovedOrganization(owner!.id, `E2E Share Org ${run}`);
      slug = `e2e-share-${run}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      await client.insert(schema.campaigns).values({
        orgId, starterUserId: owner!.id, beneficiaryType: "ORGANIZATION", title: `E2E Share ${run}`, slug,
        story: { format: "plain", text: "A campaign for the share test." }, cause: "community", country: "SI",
        targetEurCents: "1000000", durationDays: 30, status: "DEPLOYED", eurUsdRate: "1.17000000", rateSource: "ECB",
        rateAt: new Date(), targetUsdc: 11_700_000_000n, beneficiaryAddress: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
        deadline: new Date(Date.now() + 10 * 86_400_000), onchainAddress: `0x${randomBytes(20).toString("hex")}`,
        submittedAt: new Date(), deployedAt: new Date(),
      });
    } finally {
      await client.$client.end();
    }
  });

  test.afterEach(async () => {
    for (const id of userIds.splice(0)) await deleteTestUser(id);
  });

  test("a visitor gets the first-touch cookie and shares the plain link", async ({ page, context }) => {
    await page.goto(`/en/campaigns/${slug}?ref=${ownerCode}`);
    const box = page.getByRole("region", { name: "Share this campaign" });
    await expect(box).toBeVisible();
    await expect(box.getByText("Log in to share your personal link")).toBeVisible();
    const x = box.getByRole("link", { name: "Share on X" });
    const href = (await x.getAttribute("href")) ?? "";
    expect(href).toContain("https://x.com/intent/tweet?");
    expect(decodeURIComponent(href)).toContain(`/en/campaigns/${slug}`);
    expect(decodeURIComponent(href)).not.toContain("ref=");
    for (const name of ["Facebook", "LinkedIn", "WhatsApp", "Telegram", "Email"]) {
      await expect(box.getByRole("link", { name: `Share on ${name}` })).toBeVisible();
    }
    const cookie = async () => (await context.cookies()).find((c) => c.name === "cherrio_ref");
    expect((await cookie())?.value).toBe(ownerCode);
    expect((await cookie())?.httpOnly).toBe(true);
    // A later link does not replace the first one.
    await page.goto(`/en/campaigns/${slug}?ref=${code()}`);
    expect((await cookie())?.value).toBe(ownerCode);
    await expectNoA11yViolations(page, "campaign page with the share box");
  });

  test("a signed-in user shares a personal link and can copy it", async ({ page, context, browserName }) => {
    const userId = await loginAsNewUser(context, "share");
    userIds.push(userId);
    await page.goto(`/en/campaigns/${slug}`);
    const box = page.getByRole("region", { name: "Share this campaign" });
    await expect(box.getByText("This is your personal link.")).toBeVisible();
    const client = schema.createDb(process.env.DATABASE_URL!, { max: 1 });
    let mine = "";
    try {
      const [row] = await client.select({ refCode: schema.users.refCode }).from(schema.users).where(eq(schema.users.id, userId));
      mine = row!.refCode!;
    } finally {
      await client.$client.end();
    }
    expect(mine).toMatch(/^[a-z0-9]{8}$/);
    const href = (await box.getByRole("link", { name: "Share on WhatsApp" }).getAttribute("href")) ?? "";
    expect(decodeURIComponent(href)).toContain(`/en/campaigns/${slug}?ref=${mine}`);
    if (browserName === "chromium") {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await box.getByRole("button", { name: "Copy link" }).click();
      await expect(box.getByRole("button", { name: "Link copied" })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`?ref=${mine}`);
    }
  });
});
