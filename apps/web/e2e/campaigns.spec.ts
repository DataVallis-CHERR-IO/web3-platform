/**
 * apps/web/e2e/campaigns.spec.ts
 * Campaign drafts (TASK-010a): an admin of a verified organisation creates a
 * campaign, adds a cover image and submits it for review. axe on every page.
 * Needs Postgres and s3mock (docker-compose.dev.yml / CI services).
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import sharp from "sharp";
import { createApprovedOrganization, deleteTestUser, loginAsNewUser } from "./helpers/session";

const PUBLIC_BUCKET = "http://127.0.0.1:9090/cherrio-public-local";

async function expectNoA11yViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations, `a11y violations on ${label}`).toEqual([]);
}

test.beforeAll(async () => {
  // The public bucket of the local s3mock (also created by compose on a fresh start).
  const res = await fetch(PUBLIC_BUCKET, { method: "PUT" });
  if (!res.ok && res.status !== 409) throw new Error(`cannot create the public test bucket: HTTP ${res.status}`);
});

for (const path of ["/en/account/campaigns", "/en/account/campaigns/new"]) {
  test(`logged out: ${path} redirects to /en`, async ({ page }) => {
    await page.goto(path);
    await page.waitForURL(/\/en\/?$/, { timeout: 10_000 });
  });
}

test.describe("organisation admin", () => {
  let userId = "";
  test.beforeEach(async ({ context }, testInfo) => {
    userId = await loginAsNewUser(context, `campaign-${testInfo.project.name}-${testInfo.workerIndex}`);
  });
  test.afterEach(async () => {
    await deleteTestUser(userId);
  });

  test("without a verified organisation there is nothing to start", async ({ page }) => {
    await page.goto("/en/account/campaigns");
    await expect(page.getByText("Only a verified organisation can start a campaign.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Start a campaign" })).toHaveCount(0);
    await page.goto("/en/account/campaigns/new");
    await page.waitForURL("**/en/account/campaigns");
  });

  test("create a draft, add a cover image, submit it for review", async ({ page }, testInfo) => {
    await createApprovedOrganization(userId, `E2E Campaign Org ${testInfo.project.name}`);
    const title = `E2E roof ${testInfo.project.name} ${Date.now()}`;

    await page.goto("/en/account/campaigns");
    await expect(page.getByText("There is no campaign yet.")).toBeVisible();
    await expectNoA11yViolations(page, "/en/account/campaigns (empty)");
    await page.getByRole("link", { name: "Start a campaign" }).click();
    await page.waitForURL("**/en/account/campaigns/new");

    // An empty form shows what is missing and creates nothing.
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByText("Enter a title of 5 to 120 characters.")).toBeVisible();
    await expect(page.getByText("Choose a cause.")).toBeVisible();

    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Story").fill("The roof of our shelter leaks.\n\nWith your help we replace it before winter.");
    await page.getByRole("combobox", { name: "Cause" }).click();
    await page.getByRole("option", { name: "Animals" }).click();
    await page.getByRole("combobox", { name: "Country" }).click();
    await page.getByRole("option", { name: "Slovenia" }).click();
    await page.getByLabel("Target").fill("12000");
    await page.getByLabel("Duration").fill("45");
    await expectNoA11yViolations(page, "/en/account/campaigns/new (filled)");
    await page.getByRole("button", { name: "Save draft" }).click();

    await page.waitForURL(/\/en\/account\/campaigns\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: "Edit your campaign" })).toBeVisible();
    await expect(page.getByLabel("Title")).toHaveValue(title);

    // Submitting without a cover is refused with a clear message.
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByText("Add a cover image before you submit the campaign.")).toBeVisible();

    const photo = await sharp({ create: { width: 1200, height: 800, channels: 3, background: "#b03040" } }).jpeg().toBuffer();
    await page.getByLabel("Cover image").setInputFiles({ name: "cover.jpg", mimeType: "image/jpeg", buffer: photo });
    const cover = page.getByRole("img", { name: "Cover image of the campaign" });
    await expect(cover).toBeVisible();
    const src = await cover.getAttribute("src");
    expect(src).toMatch(new RegExp(`^${PUBLIC_BUCKET}/campaigns/[0-9a-f-]{36}/[0-9a-f]{24}\\.webp$`));
    expect((await page.request.get(src!)).status()).toBe(200); // readable without credentials
    await expectNoA11yViolations(page, "/en/account/campaigns/[id] (draft with cover)");

    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByText("Our team is checking your campaign. You cannot change it now.")).toBeVisible();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
    await expectNoA11yViolations(page, "/en/account/campaigns/[id] (in review)");

    await page.goto("/en/account/campaigns");
    await expect(page.getByRole("link", { name: title })).toBeVisible();
    await expect(page.locator(".ch-chip", { hasText: "Waiting for review" })).toBeVisible();
    await expectNoA11yViolations(page, "/en/account/campaigns (one campaign)");
  });
});
