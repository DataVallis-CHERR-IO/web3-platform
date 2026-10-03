/**
 * apps/web/e2e/kyb-review.spec.ts
 * KYB review (TASK-008c): an applicant and a platform admin in two browser
 * contexts — submit, download a document, reject with a note, "Submit again",
 * approve with the payout-address confirmation. Plus 404 for non-admins and axe.
 * Needs Postgres and s3mock (docker-compose.dev.yml / CI services).
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { deleteTestUser, loginAsNewUser } from "./helpers/session";

const PAYOUT = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const NOTE = "The extract is older than three months. Please upload a current one.";
const pdf = Buffer.concat([Buffer.from("%PDF-1.7\ngenerated test document\n"), randomBytes(512)]);

async function expectNoA11yViolations(page: Page, label: string) {
  // After router.refresh() the document is briefly re-rendered (no <title> for a moment); scan a settled page.
  await expect(page).toHaveTitle(/\S/);
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations, `a11y violations on ${label}`).toEqual([]);
}

async function uploadDocumentsAndSubmit(page: Page) {
  for (const label of [
    "Extract from the official register (required)",
    "Proof that you may represent the organisation (required)",
  ]) {
    await page.getByLabel(label).setInputFiles({ name: "document.pdf", mimeType: "application/pdf", buffer: pdf });
  }
  await expect(page.getByText(/^Uploaded — \d+ KB$/)).toHaveCount(2);
  await page.getByRole("button", { name: "Submit for review" }).click();
  await page.waitForURL("**/en/account/organization");
}

test("review: reject with a note → applicant submits again → approve; documents download; non-admins get 404", async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const applicantContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const tag = `${testInfo.project.name}-${testInfo.workerIndex}`;
  const applicantId = await loginAsNewUser(applicantContext, `applicant-${tag}`);
  const adminId = await loginAsNewUser(adminContext, `admin-${tag}`, { admin: true });
  const applicant = await applicantContext.newPage();
  const admin = await adminContext.newPage();
  const name = `E2E Review ${tag} ${Date.now()}`;

  try {
    // ── Applicant: a new organisation ──────────────────────────────────────
    await applicant.goto("/en/organizations/new");
    await applicant.getByLabel("Organisation name").fill(name);
    await applicant.getByLabel("Legal name").fill(`${name} Society`);
    await applicant.getByRole("combobox", { name: "Country" }).click();
    await applicant.getByRole("option", { name: "Slovenia" }).click();
    await applicant.getByRole("combobox", { name: "Official register" }).click();
    await applicant.getByRole("option", { name: "Not in any of these registers" }).click();
    await applicant.getByLabel("Short description").fill("A generated organisation for the review test.");
    await applicant.getByLabel("Animals").check();
    await applicant.getByLabel("Payout address").fill(PAYOUT);
    await uploadDocumentsAndSubmit(applicant);
    await expect(applicant.getByText("Waiting for review")).toBeVisible();

    // ── Not an admin: the admin pages do not exist ─────────────────────────
    expect((await applicant.goto("/en/admin/kyb"))?.status()).toBe(404);
    await expect(applicant.getByText("Applications waiting for review")).toHaveCount(0);

    // ── Admin: queue → detail → download → reject ──────────────────────────
    await admin.goto("/en/admin");
    await admin.getByRole("link", { name: "Review organisation applications" }).click();
    await admin.waitForURL("**/en/admin/kyb");
    await expectNoA11yViolations(admin, "/en/admin/kyb");
    await admin.getByRole("link", { name }).click();
    await admin.waitForURL(/\/en\/admin\/kyb\/[0-9a-f-]{36}$/);
    const firstDetailUrl = admin.url();
    await expect(admin.getByRole("heading", { name: `Application: ${name}` })).toBeVisible();
    await expect(admin.getByText(PAYOUT)).toBeVisible(); // in full, checksummed
    await expect(admin.getByRole("columnheader", { name: "On CHERR.IO now" })).toHaveCount(0); // new organisation
    await expectNoA11yViolations(admin, "/en/admin/kyb/[submissionId]");

    expect((await applicant.goto(firstDetailUrl))?.status()).toBe(404);
    const href = await admin.getByRole("link", { name: "Download: Extract from the register" }).getAttribute("href");
    const download = await adminContext.request.get(href!);
    expect(download.status()).toBe(200);
    expect(download.headers()["content-disposition"]).toMatch(/^attachment; filename="kyb_registration_extract-/);
    expect((await download.body()).equals(pdf)).toBe(true);
    expect((await applicantContext.request.get(href!)).status()).toBe(404);

    await admin.getByLabel("Reason for the rejection").fill(NOTE);
    await admin.getByRole("button", { name: "Reject with this note" }).click();
    await expect(admin.getByText("This application has been reviewed.")).toBeVisible();
    await expect(admin.locator("h1 + .ch-chip", { hasText: "Rejected" })).toBeVisible();

    // ── Applicant: sees the note, submits again ────────────────────────────
    await applicant.goto("/en/account/organization");
    await expect(applicant.getByText("Not accepted")).toBeVisible();
    await expect(applicant.getByText(NOTE)).toBeVisible();
    await applicant.getByRole("link", { name: "Submit again" }).click();
    await applicant.waitForURL("**/en/organizations/new?organization=*");
    await expect(applicant.getByRole("heading", { name: "Submit your application again" })).toBeVisible();
    await expect(applicant.getByLabel("Organisation name")).toHaveValue(name); // prefilled
    await expect(applicant.getByLabel("Payout address")).toHaveValue(PAYOUT.toLowerCase());
    await applicant.getByLabel("Legal name").fill(`${name} Association`);
    await uploadDocumentsAndSubmit(applicant);
    await expect(applicant.getByText("Waiting for review")).toBeVisible();

    // ── Admin: the resubmission shows what changes and the earlier note; approve ──
    await admin.goto("/en/admin/kyb");
    await admin.getByRole("link", { name }).click();
    await admin.waitForURL((url) => /\/admin\/kyb\/[0-9a-f-]{36}$/.test(url.pathname) && url.href !== firstDetailUrl);
    await expect(admin.getByRole("columnheader", { name: "On CHERR.IO now" })).toBeVisible();
    await expect(admin.getByRole("cell", { name: `${name} Society`, exact: true })).toBeVisible(); // current
    await expect(admin.getByRole("cell", { name: `${name} Association`, exact: true })).toBeVisible(); // submitted
    await expect(admin.getByText(NOTE)).toBeVisible(); // earlier applications
    await expectNoA11yViolations(admin, "/en/admin/kyb/[submissionId] (resubmission)");

    await admin.getByRole("button", { name: "Approve", exact: true }).click();
    const confirm = admin.getByRole("button", { name: "Approve and verify" });
    await expect(confirm).toBeDisabled(); // nothing typed yet
    await admin.getByLabel("Last 6 characters of the payout address").fill("abcdef");
    await confirm.click();
    await expect(admin.getByText("The characters you typed do not match")).toBeVisible();
    await expectNoA11yViolations(admin, "approve dialog");
    await admin.getByLabel("Last 6 characters of the payout address").fill(PAYOUT.slice(-6));
    await confirm.click();
    await expect(admin.getByText("This application has been reviewed.")).toBeVisible();
    await expect(admin.locator("h1 + .ch-chip", { hasText: "Approved" })).toBeVisible();

    // ── Applicant: verified ────────────────────────────────────────────────
    await applicant.goto("/en/account/organization");
    await expect(applicant.locator(".ch-chip", { hasText: "Verified" })).toBeVisible();
    await expect(applicant.getByRole("link", { name: "Submit again" })).toHaveCount(0);
  } finally {
    await applicantContext.close();
    await adminContext.close();
    await deleteTestUser(applicantId); // first: its submissions reference the reviewer
    await deleteTestUser(adminId);
  }
});
