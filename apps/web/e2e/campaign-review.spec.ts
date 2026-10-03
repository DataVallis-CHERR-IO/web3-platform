/**
 * apps/web/e2e/campaign-review.spec.ts
 * Campaign review (TASK-010b): a platform admin sees submitted campaigns,
 * rejects one with a note (the organisation sees it) and approves another with
 * the ECB snapshot. The ECB file is served here from a fixture (ECB_RATES_URL,
 * APP_ENV=local). The publish panel is shown; signing is not automated (the
 * linking is covered by integration tests). axe on every page.
 */
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import sharp from "sharp";
import { E2E_ECB_PORT } from "../playwright.env";
import { createApprovedOrganization, createSubmittedCampaign, deleteTestUser, loginAsNewUser } from "./helpers/session";

const PUBLIC_BUCKET = "http://127.0.0.1:9090/cherrio-public-local";
const FIXTURE = readFileSync(new URL("../src/__tests__/fixtures/ecb-eurofxref-daily.xml", import.meta.url), "utf8");

async function expectNoA11yViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations, `a11y violations on ${label}`).toEqual([]);
}

let ecb: Server | undefined;
test.beforeAll(async () => {
  // The fixture dated today, so it is the "latest" rate. Another worker may already serve it on the same port.
  ecb = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/xml" }).end(FIXTURE.replace("2026-10-01", new Date().toISOString().slice(0, 10)));
  });
  await new Promise<void>((resolve, reject) => {
    ecb!.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EADDRINUSE") return reject(error);
      ecb = undefined;
      resolve();
    });
    ecb!.listen(E2E_ECB_PORT, "127.0.0.1", () => resolve());
  });
  const bucket = await fetch(PUBLIC_BUCKET, { method: "PUT" });
  if (!bucket.ok && bucket.status !== 409) throw new Error(`cannot create the public test bucket: HTTP ${bucket.status}`);
});
test.afterAll(async () => {
  if (ecb) await new Promise((resolve) => ecb!.close(resolve));
});

test("a non-admin gets 404 on the campaign review pages", async ({ page, context }, testInfo) => {
  const userId = await loginAsNewUser(context, `campaign-review-user-${testInfo.project.name}`);
  try {
    for (const path of ["/en/admin/campaigns", "/en/admin/campaigns/01890000-0000-7000-8000-000000000000"]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
    }
  } finally {
    await deleteTestUser(userId);
  }
});

test.describe("platform admin", () => {
  let adminId = "";
  let ownerId = "";

  test.afterEach(async () => {
    // The organisation's campaigns reference the reviewer, so they go first.
    if (ownerId) await deleteTestUser(ownerId);
    if (adminId) await deleteTestUser(adminId);
  });

  test("reject one campaign with a note, approve another with the ECB snapshot", async ({ page, context, browser }, testInfo) => {
    const run = `${testInfo.project.name}-${Date.now()}`;
    adminId = await loginAsNewUser(context, `campaign-reviewer-${run}`, { admin: true });
    const ownerContext = await browser.newContext();
    ownerId = await loginAsNewUser(ownerContext, `campaign-owner-${run}`);
    const orgId = await createApprovedOrganization(ownerId, `E2E Review Org ${run}`);

    const cover = await sharp({ create: { width: 800, height: 400, channels: 3, background: "#b03040" } }).webp().toBuffer();
    const coverKey = `campaigns/e2e-${run}/cover.webp`;
    const put = await fetch(`${PUBLIC_BUCKET}/${coverKey}`, { method: "PUT", body: new Uint8Array(cover), headers: { "Content-Type": "image/webp" } });
    expect(put.ok).toBe(true);
    const rejectTitle = `E2E reject ${run}`;
    const approveTitle = `E2E approve ${run}`;
    const rejectId = await createSubmittedCampaign(ownerId, orgId, rejectTitle, coverKey);
    const approveId = await createSubmittedCampaign(ownerId, orgId, approveTitle, coverKey);

    await page.goto("/en/admin");
    await page.getByRole("link", { name: "Campaigns: review and publish" }).click();
    await page.waitForURL("**/en/admin/campaigns");
    await expect(page.getByRole("link", { name: rejectTitle })).toBeVisible();
    await expect(page.getByRole("link", { name: approveTitle })).toBeVisible();
    await expectNoA11yViolations(page, "/en/admin/campaigns");

    // Reject with a note.
    await page.getByRole("link", { name: rejectTitle }).click();
    await page.waitForURL(`**/en/admin/campaigns/${rejectId}`);
    await expect(page.getByRole("heading", { name: `Campaign: ${rejectTitle}` })).toBeVisible();
    await expect(page.getByRole("img", { name: "Cover image" })).toBeVisible();
    await expect(page.getByText("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed").first()).toBeVisible();
    await expectNoA11yViolations(page, "/en/admin/campaigns/[id] (pending)");
    const note = "Please explain what the money is spent on.";
    await page.getByLabel("Reason for the rejection").fill(note);
    await page.getByRole("button", { name: "Reject with this note" }).click();
    await expect(page.getByText("This campaign has been reviewed.")).toBeVisible();
    await expect(page.locator(".ch-chip", { hasText: "Not accepted" })).toBeVisible();

    // The organisation sees the note and can edit again.
    const ownerPage = await ownerContext.newPage();
    await ownerPage.goto(`/en/account/campaigns/${rejectId}`);
    await expect(ownerPage.getByText(note)).toBeVisible();
    await expect(ownerPage.getByRole("button", { name: "Save draft" })).toBeVisible();
    await ownerContext.close();

    // Approve the other one: the ECB rate (fixture: 1.1734) and the USDC target are shown.
    await page.goto(`/en/admin/campaigns/${approveId}`);
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed")).toBeVisible();
    await expectNoA11yViolations(page, "/en/admin/campaigns/[id] (approve dialog)");
    await dialog.getByRole("button", { name: "Approve with the ECB rate" }).click();
    await expect(page.getByRole("heading", { name: "Approval snapshot" })).toBeVisible();
    await expect(page.getByText("1.17340000")).toBeVisible();
    await expect(page.getByText("14,080.80 USDC")).toBeVisible(); // 12,000 EUR × 1.1734
    // Publishing (TASK-010c): the panel is shown. The E2E server has no Privy app,
    // so it cannot sign; "Check status" answers that this environment has no contracts/indexer.
    await expect(page.getByRole("heading", { name: "Publish on Polygon" })).toBeVisible();
    await expect(page.getByText("Wallet sign-in is not configured in this environment")).toBeVisible();
    await page.getByRole("button", { name: "Check status" }).click();
    await expect(page.getByRole("status")).toHaveText("The indexer data is not available in this environment.");
    await expect(page.locator(".ch-chip", { hasText: "Approved" })).toBeVisible();
    await expectNoA11yViolations(page, "/en/admin/campaigns/[id] (approved)");

    // The rejected one has left the queue; the approved one waits to be published.
    await page.goto("/en/admin/campaigns");
    await expect(page.getByRole("link", { name: rejectTitle })).toHaveCount(0);
    await page.getByRole("link", { name: /^Approved — waiting to be published/ }).click();
    await page.waitForURL("**/en/admin/campaigns?view=publish");
    const approvedList = page.getByRole("region", { name: "Approved — waiting to be published" });
    await expect(approvedList.getByRole("link", { name: approveTitle })).toBeVisible();
    await expect(approvedList.getByRole("row", { name: new RegExp(approveTitle) })).toContainText("Not published yet");
    await expectNoA11yViolations(page, "/en/admin/campaigns (approved list)");
    await approvedList.getByRole("link", { name: approveTitle }).click();
    await page.waitForURL(`**/en/admin/campaigns/${approveId}`);
    await expect(page.getByRole("heading", { name: "Publish on Polygon" })).toBeVisible();
  });
});
