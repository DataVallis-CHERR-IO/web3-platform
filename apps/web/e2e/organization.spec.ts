/**
 * apps/web/e2e/organization.spec.ts
 * Organisation onboarding (TASK-008b): application form with document upload,
 * status page, a11y on both pages, and the logged-out redirect.
 * Needs Postgres and s3mock (docker-compose.dev.yml / CI services).
 */
import { randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { deleteTestUser, loginAsNewUser } from "./helpers/session";

const pdf = Buffer.concat([Buffer.from("%PDF-1.7\ngenerated test document\n"), randomBytes(512)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(256)]);

async function expectNoA11yViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations, `a11y violations on ${label}`).toEqual([]);
}

test.describe("logged out", () => {
  for (const path of ["/en/organizations/new", "/en/account/organization"]) {
    test(`${path} redirects to /en`, async ({ page }) => {
      await page.goto(path);
      await page.waitForURL(/\/en\/?$/, { timeout: 10_000 });
      await expect(page.getByRole("heading", { name: "Your organisations" })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Register your organisation" })).toHaveCount(0);
    });
  }
});

test.describe("logged in", () => {
  let userId = "";
  test.beforeEach(async ({ context }, testInfo) => {
    userId = await loginAsNewUser(context, `${testInfo.project.name}-${testInfo.workerIndex}`);
  });
  test.afterEach(async () => {
    await deleteTestUser(userId);
  });

  test("register an organisation: fill the form, upload a PDF and a PNG, submit, see it waiting for review", async ({
    page,
  }, testInfo) => {
    await page.goto("/en/account/organization");
    await expect(page.getByText("You have not registered an organisation yet.")).toBeVisible();
    await expectNoA11yViolations(page, "/en/account/organization (empty)");
    await page.getByRole("link", { name: "Register an organisation" }).click();
    await page.waitForURL("**/en/organizations/new");

    // Submitting the empty form shows what is missing and sends nothing.
    await page.getByRole("button", { name: "Submit for review" }).click();
    await expect(page.getByText("Choose a country.")).toBeVisible();
    await expect(page.getByText("Upload the extract from the register and the proof")).toBeVisible();

    const name = `E2E Shelter ${testInfo.project.name} ${Date.now()}`;
    await page.getByLabel("Organisation name").fill(name);
    await page.getByLabel("Legal name").fill(`${name} Society`);
    await page.getByRole("combobox", { name: "Country" }).click();
    await page.getByRole("option", { name: "Slovenia" }).click();
    await page.getByRole("combobox", { name: "Official register" }).click();
    await page.getByRole("option", { name: "Not in any of these registers" }).click();
    await page.getByLabel("Website").fill("https://shelter.example.org");
    await page.getByLabel("Short description").fill("A generated organisation for the end-to-end test.");
    await page.getByLabel("Animals").check();
    await page.getByLabel("Local community").check();
    await page.getByLabel("Payout address").fill("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed");

    await page
      .getByLabel("Extract from the official register (required)")
      .setInputFiles({ name: "extract.pdf", mimeType: "application/pdf", buffer: pdf });
    await page
      .getByLabel("Proof that you may represent the organisation (required)")
      .setInputFiles({ name: "authorisation.png", mimeType: "image/png", buffer: png });
    await expect(page.getByText(/^Uploaded — \d+ KB$/)).toHaveCount(2);
    // A file that is not PDF, JPEG or PNG is refused by the server, with a message.
    await page
      .getByLabel("Statute or founding act (optional)")
      .setInputFiles({ name: "statute.pdf", mimeType: "application/pdf", buffer: Buffer.from("<html></html>") });
    await expect(page.getByText("Only PDF, JPEG and PNG files are accepted.")).toBeVisible();

    await expectNoA11yViolations(page, "/en/organizations/new (filled)");

    await page.getByRole("button", { name: "Submit for review" }).click();
    await page.waitForURL("**/en/account/organization");
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await expect(page.getByText("Waiting for review")).toBeVisible();
    await expect(page.getByRole("link", { name: "Register an organisation" })).toHaveCount(0); // one pending at a time
    await expectNoA11yViolations(page, "/en/account/organization (pending)");
  });
});
