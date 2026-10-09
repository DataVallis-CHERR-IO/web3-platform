/**
 * apps/web/e2e/admin-overview.spec.ts
 * Admin overview (TASK-029 §3): all organisations and all campaigns with
 * search, filters in the URL, detail pages, and axe on every page.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { createApprovedOrganization, createSubmittedCampaign, deleteTestUser, loginAsNewUser } from "./helpers/session";

async function expectNoA11yViolations(page: Page, label: string) {
  // After router.refresh() the document is briefly re-rendered (no <title> for a moment); scan a settled page.
  await expect(page).toHaveTitle(/\S/);
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations, `a11y violations on ${label}`).toEqual([]);
}

test("a non-admin gets 404 on the overview pages", async ({ page, context }, info) => {
  const userId = await loginAsNewUser(context, `overview-user-${info.project.name}`);
  try {
    for (const path of ["/en/admin/organizations", "/en/admin/organizations/01890000-0000-7000-8000-000000000000"]) {
      expect((await page.goto(path))?.status(), path).toBe(404);
    }
  } finally {
    await deleteTestUser(userId);
  }
});

test.describe("platform admin", () => {
  let adminId = "";
  let ownerId = "";
  test.afterEach(async () => {
    if (ownerId) await deleteTestUser(ownerId);
    if (adminId) await deleteTestUser(adminId);
  });

  test("find an organisation, open it, follow its campaign; filters live in the URL", async ({ page, context, browser }, info) => {
    const run = `${info.project.name}-${Date.now()}`;
    adminId = await loginAsNewUser(context, `overview-admin-${run}`, { admin: true });
    const other = await browser.newContext();
    ownerId = await loginAsNewUser(other, `overview-owner-${run}`);
    await other.close();
    const orgName = `E2E Overview Org ${run}`;
    const orgId = await createApprovedOrganization(ownerId, orgName);
    const title = `E2E overview campaign ${run}`;
    const campaignId = await createSubmittedCampaign(ownerId, orgId, title, `campaigns/e2e-${run}/c.webp`);

    await page.goto("/en/admin");
    await page.getByRole("navigation", { name: "Admin menu" }).getByRole("link", { name: "Organisations", exact: true }).click();
    await page.waitForURL("**/en/admin/organizations");
    await expectNoA11yViolations(page, "/en/admin/organizations");

    // Search updates the URL and the list.
    await page.getByRole("searchbox", { name: "Search" }).fill(orgName);
    await page.waitForURL(/\/en\/admin\/organizations\?q=/);
    await expect(page.getByRole("link", { name: orgName })).toBeVisible();
    await expect(page.getByRole("region", { name: "Organisations" }).getByRole("row")).toHaveCount(2); // header + one

    // A status tab keeps the search; "Not accepted" has no such organisation.
    await page.getByRole("link", { name: /^Not accepted/ }).click();
    await page.waitForURL(/status=REJECTED/);
    expect(page.url()).toContain("q=");
    await expect(page.getByText("Nothing matches these filters.")).toBeVisible();
    await page.getByRole("link", { name: /^Verified/ }).click();
    await page.waitForURL(/status=APPROVED/);
    // Reloading keeps the state (it lives in the URL).
    await page.reload();
    await expect(page.getByRole("searchbox", { name: "Search" })).toHaveValue(orgName);
    await page.getByRole("link", { name: orgName }).click();

    await page.waitForURL(`**/en/admin/organizations/${orgId}`);
    await expect(page.getByRole("heading", { name: orgName })).toBeVisible();
    await expect(page.getByRole("region", { name: "Members" })).toContainText("Administrator");
    await expect(page.getByRole("region", { name: "Campaigns" }).getByRole("link", { name: title })).toBeVisible();
    await expectNoA11yViolations(page, "/en/admin/organizations/[id]");
    await page.getByRole("region", { name: "Campaigns" }).getByRole("link", { name: title }).click();
    await page.waitForURL(`**/en/admin/campaigns/${campaignId}`);

    // Campaign tabs: "All" with a search by organisation name.
    await page.goto(`/en/admin/campaigns?view=all&q=${encodeURIComponent(orgName)}`);
    const region = page.getByRole("region", { name: "All" });
    await expect(region.getByRole("link", { name: title })).toBeVisible();
    await expect(region.getByRole("link", { name: orgName })).toBeVisible();
    await expectNoA11yViolations(page, "/en/admin/campaigns?view=all");
    await page.getByRole("link", { name: /^Live/ }).click();
    await page.waitForURL(/view=live/);
    await expect(page.getByText("No live campaign.")).toBeVisible();
  });

  test("a campaign for an individual (no organisation) is listed and its page opens", async ({ page, context, browser }, info) => {
    const run = `${info.project.name}-${Date.now()}`;
    adminId = await loginAsNewUser(context, `overview-admin-ind-${run}`, { admin: true });
    const other = await browser.newContext();
    ownerId = await loginAsNewUser(other, `overview-person-${run}`);
    await other.close();
    const title = `E2E individual campaign ${run}`;
    const campaignId = await createSubmittedCampaign(ownerId, null, title, `campaigns/e2e-${run}/c.webp`);

    await page.goto(`/en/admin/campaigns?view=all&q=${encodeURIComponent(title)}`);
    const row = page.getByRole("region", { name: "All" }).getByRole("row").filter({ hasText: title });
    await expect(row).toContainText("Individual (Cherrion) — no organisation");
    await row.getByRole("link", { name: title }).click();
    await page.waitForURL(`**/en/admin/campaigns/${campaignId}`);
    await expect(page.getByRole("heading", { name: `Campaign: ${title}` })).toBeVisible();
    await expect(page.getByText("Organisation: Individual (Cherrion) — no organisation")).toBeVisible();
    await expectNoA11yViolations(page, "/en/admin/campaigns/[id] (individual)");
  });
});
