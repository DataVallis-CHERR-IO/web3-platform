/**
 * apps/web/e2e/admin-audit.spec.ts
 * Admin side menu + Audit log (TASK-021): reach the log from the menu, search by
 * action, narrow to one person and one record, jump between a record and its
 * history; axe on the page. (404 for non-admins is in admin-hidden.spec.ts.)
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { addAuditEntry, createApprovedOrganization, deleteTestUser, loginAsNewUser } from "./helpers/session";

async function expectNoA11yViolations(page: Page, label: string) {
  await expect(page).toHaveTitle(/\S/);
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations, `a11y violations on ${label}`).toEqual([]);
}

test.describe("platform admin", () => {
  let adminId = "";
  test.afterEach(async () => {
    if (adminId) await deleteTestUser(adminId);
  });

  test("audit log: menu, search, one person, one record, and back", async ({ page, context }, info) => {
    const run = `${info.project.name}-${Date.now()}`.toLowerCase();
    adminId = await loginAsNewUser(context, `audit-admin-${run}`, { admin: true });
    const orgName = `E2E Audit Org ${run}`;
    const orgId = await createApprovedOrganization(adminId, orgName);
    await addAuditEntry({ actorUserId: adminId, action: `e2e.${run}.reviewed`, entityType: "organization", entityId: orgId, data: { note: "first" } });
    await addAuditEntry({ actorUserId: adminId, action: `e2e.${run}.other`, entityType: "organization" });
    await addAuditEntry({ actorUserId: null, action: `e2e.${run}.system`, entityType: "organization", entityId: orgId });

    await page.goto("/en/admin");
    const menu = page.getByRole("navigation", { name: "Admin menu" });
    await expect(menu.getByRole("link", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
    await menu.getByRole("link", { name: "Audit log", exact: true }).click();
    await page.waitForURL("**/en/admin/audit");
    await expect(page.getByRole("heading", { level: 1, name: "Audit log" })).toBeVisible();
    await expect(menu.getByRole("link", { name: "Audit log", exact: true })).toHaveAttribute("aria-current", "page");

    // Search by part of the action name.
    await page.getByRole("searchbox", { name: "Action" }).fill(`e2e.${run}`);
    await page.waitForURL(/\/en\/admin\/audit\?q=/);
    const table = page.getByRole("region", { name: "Audit log" });
    await expect(table.getByRole("row")).toHaveCount(4); // header + three
    await expect(table.getByText('{"note":"first"}')).toBeVisible();
    await expect(table.getByText("System", { exact: true })).toBeVisible();
    await expectNoA11yViolations(page, "/en/admin/audit");

    // One person: the system row disappears.
    await table.getByRole("row", { name: new RegExp(`e2e\\.${run}\\.reviewed`) }).getByRole("link", { name: `E2E audit-admin-${run}` }).click();
    await page.waitForURL(/actor=/);
    await expect(page.getByText(/Only actions by/)).toBeVisible();
    await expect(table.getByRole("row")).toHaveCount(3);
    await page.getByRole("link", { name: "Show all" }).click();
    await page.waitForURL((url) => !url.search.includes("actor="));

    // One record: its history, then the record's own page and back.
    await table.getByRole("row", { name: new RegExp(`e2e\\.${run}\\.reviewed`) }).getByRole("link", { name: "history" }).click();
    await page.waitForURL(/entity=/);
    await expect(table.getByRole("row")).toHaveCount(3); // reviewed + system, not "other"
    await table.getByRole("row", { name: new RegExp(`e2e\\.${run}\\.reviewed`) }).getByRole("link", { name: orgId.slice(0, 8) }).click();
    await page.waitForURL(`**/en/admin/organizations/${orgId}`);
    await expect(menu.getByRole("link", { name: "Organisations", exact: true })).toHaveAttribute("aria-current", "page");
    await page.getByRole("link", { name: "Audit log of this record" }).click();
    await page.waitForURL(`**/en/admin/audit?entity=${orgId}`);
    await expect(page.getByRole("region", { name: "Audit log" }).getByText(`e2e.${run}.system`)).toBeVisible();
  });
});
