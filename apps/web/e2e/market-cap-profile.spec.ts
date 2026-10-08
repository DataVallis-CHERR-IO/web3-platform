/**
 * apps/web/e2e/market-cap-profile.spec.ts
 * TASK-017c: an organisation's Charity Market Cap profile — score, what the
 * public record shows, register facts with the OGL attribution, JSON-LD — and
 * "Claim this organization": a visitor is asked to log in, a logged-in user gets
 * the KYB form prefilled from the listing. Needs Postgres.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { inArray } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { deleteTestUser, loginAsNewUser } from "./helpers/session";

test.describe("Charity Market Cap profile", () => {
  let orgId = "";
  let regno = "";
  let name = "";
  let userId = "";

  test.beforeEach(async ({ browserName: _b }, info) => {
    const run = `${info.project.name.replace(/\W/g, "")}${Date.now().toString(36)}`;
    name = `E2E Paws Trust ${run}`;
    regno = `9${Date.now().toString().slice(-8)}${info.project.name.endsWith("390") ? "1" : "2"}`;
    const client = schema.createDb(process.env.DATABASE_URL!, { max: 1 });
    try {
      const [o] = await client
        .insert(schema.organizations)
        .values({
          source: "IMPORTED", name, country: "GB", registry: "UK_CC", registryId: regno, causes: ["animals"], kybStatus: "NONE",
          website: "https://paws.example", description: "We rescue and rehome dogs.",
        })
        .returning({ id: schema.organizations.id });
      orgId = o!.id;
      await client.insert(schema.registryRecords).values({
        registry: "UK_CC", registryId: regno, raw: { status: "Registered", income: 125000, registeredOn: "1990-05-01" },
      });
      await client.insert(schema.trustScores).values({
        orgId, version: 1, score: "36.00", listed: true, registered: false, country: "GB", causes: ["animals"], raised: "0",
        components: { kind: "imported", active: true, website: true, description: true, figures: true, recentFiling: false },
      });
    } finally {
      await client.$client.end();
    }
  });

  test.afterEach(async () => {
    if (userId) await deleteTestUser(userId);
    userId = "";
    const client = schema.createDb(process.env.DATABASE_URL!, { max: 1 });
    try {
      await client.delete(schema.trustScores).where(inArray(schema.trustScores.orgId, [orgId]));
      await client.delete(schema.organizations).where(inArray(schema.organizations.id, [orgId]));
      await client.delete(schema.registryRecords).where(inArray(schema.registryRecords.registryId, [regno]));
    } finally {
      await client.$client.end();
    }
  });

  test("shows the score, the public record and the register, with structured data", async ({ page }) => {
    await page.goto(`/en/charity-market-cap/${orgId}`);
    await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(page.locator(".ch-trust-score")).toContainText("36");
    await expect(page.getByText("A website in the register")).toBeVisible();
    await expect(page.getByText("Income or revenue reported")).toBeVisible();
    await expect(page.getByText(/Accounts or a return filed in the last two years: No/)).toBeAttached();
    await expect(page.getByText("Charity Commission for England and Wales", { exact: true })).toBeVisible();
    await expect(page.getByText("£125,000")).toBeVisible();
    await expect(page.getByRole("link", { name: "See it on the register" })).toHaveAttribute("href", new RegExp(`charity-details/${regno}$`));
    await expect(page.getByRole("link", { name: "Open Government Licence v3.0" })).toBeVisible();

    const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent())!);
    expect(ld).toMatchObject({ "@type": "Organization", name, sameAs: ["https://paws.example"], address: { addressCountry: "GB" } });
    expect(ld.aggregateRating).toBeUndefined(); // no ratings yet

    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations).toEqual([]);

    // Not listed → not found.
    const missing = await page.goto("/en/charity-market-cap/00000000-0000-4000-8000-000000000000");
    expect(missing?.status()).toBe(404);
  });

  test("claim: a visitor is asked to log in; a member gets the form prefilled", async ({ page, context }) => {
    await page.goto(`/en/charity-market-cap/${orgId}`);
    await expect(page.getByRole("button", { name: "Log in to claim this organization" })).toBeVisible();

    userId = await loginAsNewUser(context, `claim-${orgId.slice(0, 8)}`);
    await page.goto(`/en/charity-market-cap/${orgId}`);
    await page.getByRole("link", { name: "Claim this organization" }).click();
    await expect(page).toHaveURL(new RegExp(`/en/organizations/new\\?claim=${orgId}$`));
    await expect(page.getByRole("heading", { level: 1, name: `Claim ${name}` })).toBeVisible();
    await expect(page.getByLabel("Organisation name")).toHaveValue(name);
    await expect(page.getByLabel(/^Registration number/)).toHaveValue(regno);
    await expect(page.getByLabel(/^Registration number/)).toBeDisabled();
    await expect(page.getByText("The register and the number come from the listing you are claiming.")).toBeVisible();
  });
});
