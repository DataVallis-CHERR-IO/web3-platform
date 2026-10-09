/**
 * apps/web/e2e/admin-hidden.spec.ts
 * TASK-035: to anyone who is not a platform admin, the admin area looks exactly
 * like a URL that does not exist — same status, same page — and every admin
 * response tells robots not to index or store it.
 */
import { test, expect, type Page } from "@playwright/test";
import { deleteTestUser, loginAsNewUser } from "./helpers/session";

const ADMIN_PAGES = ["/en/admin", "/en/admin/contracts", "/en/admin/kyb", "/en/admin/campaigns", "/en/admin/organizations", "/en/admin/audit"];

async function notFoundHeading(page: Page, url: string) {
  const res = await page.goto(url);
  expect(res?.status(), url).toBe(404);
  return (await page.locator("main h1").innerText()).trim();
}

test("anonymous: admin pages are the same 404 as an unknown URL, with noindex and no-store", async ({ page }) => {
  const unknown = await notFoundHeading(page, "/en/this-page-does-not-exist");
  expect(unknown.length).toBeGreaterThan(0);
  for (const url of ADMIN_PAGES) {
    expect(await notFoundHeading(page, url), url).toBe(unknown);
    const res = await page.request.get(url, { maxRedirects: 0 });
    expect(res.status(), url).toBe(404);
    expect(res.headers()["x-robots-tag"], url).toContain("noindex");
    expect(res.headers()["cache-control"], url).toContain("no-store");
  }
  const api = await page.request.get("/api/admin/contracts/changes");
  expect(api.status()).toBe(404);
  expect(api.headers()["x-robots-tag"]).toContain("noindex");
});

test("logged-in non-admin: the same 404", async ({ page, context }, info) => {
  const userId = await loginAsNewUser(context, `hidden-user-${info.project.name}`);
  try {
    const unknown = await notFoundHeading(page, "/en/this-page-does-not-exist");
    for (const url of ADMIN_PAGES) expect(await notFoundHeading(page, url), url).toBe(unknown);
  } finally {
    await deleteTestUser(userId);
  }
});

test("admin: the console renders and still says noindex", async ({ page, context }, info) => {
  const adminId = await loginAsNewUser(context, `hidden-admin-${info.project.name}-${Date.now()}`, { admin: true });
  try {
    const res = await page.goto("/en/admin");
    expect(res?.status()).toBe(200);
    expect(res?.headers()["x-robots-tag"]).toContain("noindex");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  } finally {
    await deleteTestUser(adminId);
  }
});
