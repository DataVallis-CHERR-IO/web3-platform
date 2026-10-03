/**
 * apps/web/e2e/campaign-media.spec.ts
 * Campaign media (ADR-039): the organisation adds a gallery image, a video link
 * and a PDF to a submitted campaign; a platform admin sees them and removes the
 * PDF (takedown). axe on both pages. Needs Postgres and the local S3.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import sharp from "sharp";
import { createApprovedOrganization, createSubmittedCampaign, deleteTestUser, loginAsNewUser } from "./helpers/session";

const PUBLIC_BUCKET = "http://127.0.0.1:9090/cherrio-public-local";

async function expectNoA11yViolations(page: Page, label: string) {
  // After router.refresh() the document is briefly re-rendered; scan a settled page.
  await expect(page).toHaveTitle(/\S/);
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations, `a11y violations on ${label}`).toEqual([]);
}

test.beforeAll(async () => {
  const res = await fetch(PUBLIC_BUCKET, { method: "PUT" });
  if (!res.ok && res.status !== 409) throw new Error(`cannot create the public test bucket: HTTP ${res.status}`);
});

test.describe("campaign media", () => {
  let ownerId = "";
  let adminId = "";
  test.afterEach(async () => {
    if (ownerId) await deleteTestUser(ownerId);
    if (adminId) await deleteTestUser(adminId);
  });

  test("organisation adds an image, a video and a PDF; an admin takes the PDF down", async ({ page, context, browser }, info) => {
    const run = `${info.project.name}-${Date.now()}`;
    ownerId = await loginAsNewUser(context, `media-owner-${run}`);
    const orgId = await createApprovedOrganization(ownerId, `E2E Media Org ${run}`);
    const campaignId = await createSubmittedCampaign(ownerId, orgId, `E2E media ${run}`, `campaigns/e2e-${run}/c.webp`);

    // The campaign is in review, but media can still be added (it is not on-chain).
    await page.goto(`/en/account/campaigns/${campaignId}`);
    await expect(page.getByRole("heading", { name: "Photos, videos and documents" })).toBeVisible();
    await expect(page.getByText("Everything you add here is public at once")).toBeVisible();

    const photo = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#2a6f4b" } }).jpeg().toBuffer();
    await page.getByLabel("Add an image").setInputFiles({ name: "garden.jpg", mimeType: "image/jpeg", buffer: photo });
    await expect(page.getByRole("img", { name: "Gallery image 1" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Gallery (1 of 10)" })).toBeVisible();

    await page.getByLabel("Video link").fill("https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ");
    await page.getByRole("button", { name: "Add video" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "YouTube or Vimeo" })).toBeVisible();
    await page.getByLabel("Video link").fill("https://youtu.be/dQw4w9WgXcQ");
    await page.getByRole("button", { name: "Add video" }).click();
    await expect(page.getByRole("link", { name: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" })).toBeVisible();

    const pdf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");
    await page.getByLabel("Add a PDF").setInputFiles({ name: "Budget 2026.pdf", mimeType: "application/pdf", buffer: pdf });
    const pdfLink = page.getByRole("link", { name: "Budget 2026.pdf" });
    await expect(pdfLink).toBeVisible();
    const pdfUrl = await pdfLink.getAttribute("href");
    expect(pdfUrl).toMatch(new RegExp(`^${PUBLIC_BUCKET}/campaigns/${campaignId}/d-[0-9a-f]{24}\\.pdf$`));
    expect((await page.request.get(pdfUrl!)).status()).toBe(200);
    await expectNoA11yViolations(page, "/en/account/campaigns/[id] (media)");

    // The platform admin sees the media and removes the PDF.
    const adminContext = await browser.newContext();
    adminId = await loginAsNewUser(adminContext, `media-admin-${run}`, { admin: true });
    const admin = await adminContext.newPage();
    await admin.goto(`/en/admin/campaigns/${campaignId}`);
    await expect(admin.getByRole("img", { name: "Gallery image 1" })).toBeVisible();
    await expect(admin.getByRole("link", { name: "Budget 2026.pdf" })).toBeVisible();
    await expectNoA11yViolations(admin, "/en/admin/campaigns/[id] (media)");
    await admin.getByRole("button", { name: "Remove: Budget 2026.pdf" }).click();
    await admin.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
    // While the dialog is open the page behind it is aria-hidden; wait until it has closed.
    await expect(admin.getByRole("dialog")).toHaveCount(0);
    await expect(admin.getByRole("link", { name: "Budget 2026.pdf" })).toHaveCount(0);
    expect((await admin.request.get(pdfUrl!)).status()).toBe(404);
    await adminContext.close();

    // The organisation sees it gone and can remove its own image.
    await page.reload();
    await expect(page.getByRole("link", { name: "Budget 2026.pdf" })).toHaveCount(0);
    await page.getByRole("button", { name: "Remove: Gallery image 1" }).click();
    await expect(page.getByRole("img", { name: "Gallery image 1" })).toHaveCount(0);
  });
});
