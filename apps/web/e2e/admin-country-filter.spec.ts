/**
 * apps/web/e2e/admin-country-filter.spec.ts
 * Admin lists (David 2026-10-08): the country filter offers only countries that
 * occur in the list, with their counts, and typing filters at once (the chosen
 * name is selected on click, so typing replaces it). Needs Postgres.
 */
import { test, expect } from "@playwright/test";
import { eq } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { createApprovedOrganization, deleteTestUser, loginAsNewUser } from "./helpers/session";

test.describe("admin organisation list — country filter", () => {
  let adminId = "";
  test.afterEach(async () => {
    if (adminId) await deleteTestUser(adminId);
  });

  test("only countries in use, with counts; type to filter", async ({ page, context }, info) => {
    const run = `${info.project.name}-${Date.now()}`;
    adminId = await loginAsNewUser(context, `country-${run}`, { admin: true });
    const orgId = await createApprovedOrganization(adminId, `E2E Vanuatu Org ${run}`);
    const client = schema.createDb(process.env.DATABASE_URL!, { max: 1 });
    try {
      await client.update(schema.organizations).set({ country: "VU" }).where(eq(schema.organizations.id, orgId));
    } finally {
      await client.$client.end();
    }

    await page.goto("/en/admin/organizations");
    const country = page.getByRole("combobox", { name: "Country" });
    await country.click();
    const list = page.getByRole("listbox");
    await expect(list.getByRole("option", { name: /^Vanuatu \(\d+\)$/ })).toBeVisible();
    // A country nobody is registered in is not offered.
    await expect(list.getByRole("option", { name: /^Antarctica/ })).toHaveCount(0);

    await page.keyboard.type("vanu"); // replaces "Any country" (selected on click)
    await expect(list.getByRole("option")).toHaveCount(1);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/[?&]country=VU/);
    await expect(page.getByRole("link", { name: `E2E Vanuatu Org ${run}` })).toBeVisible();
  });
});
