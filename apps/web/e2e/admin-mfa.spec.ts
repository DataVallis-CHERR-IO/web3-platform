/**
 * apps/web/e2e/admin-mfa.spec.ts
 * TASK-049 / ADR-056: an admin without a second factor sees the enrolment
 * screen on every admin page; after the code and the recovery codes the page
 * opens. Without the 12-hour cookie the code screen comes back, and a
 * recovery code opens the page once.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { base32Decode, hotp, timeStep } from "../src/lib/auth/totp";
import { deleteTestUser, loginAsNewUser } from "./helpers/session";

test("enrol with the QR key, keep the recovery codes, then use one when the cookie is gone", async ({ page, context }, info) => {
  const adminId = await loginAsNewUser(context, `mfa-${info.project.name}-${Date.now()}`, { admin: true, mfa: false });
  try {
    // Every admin page shows the enrolment screen instead of the page; the API stays 404.
    for (const url of ["/en/admin", "/en/admin/contracts"]) {
      const res = await page.goto(url);
      expect(res?.status(), url).toBe(200);
      await expect(page.getByRole("heading", { name: "Set up your authenticator" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Admin Portal" })).toHaveCount(0);
    }
    expect((await page.request.get("/api/admin/contracts/changes")).status()).toBe(404);

    await page.getByRole("button", { name: "Show the QR code" }).click();
    await expect(page.getByRole("img", { name: "QR code for your authenticator app" })).toBeVisible();
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(axe.violations.map((v) => v.id)).toEqual([]);

    const key = base32Decode(await page.getByTestId("mfa-secret").innerText());
    await page.getByLabel("6-digit code from the app").fill(hotp(key, timeStep(Date.now()) + 5)); // outside ±1 step
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "That code is not right" })).toBeVisible();

    await page.getByLabel("6-digit code from the app").fill(hotp(key, timeStep(Date.now())));
    await page.getByRole("button", { name: "Confirm" }).click();
    const codes = page.getByRole("list", { name: "Recovery codes" }).getByRole("listitem");
    await expect(codes).toHaveCount(10);
    const recovery = (await codes.first().innerText()).trim();
    expect(recovery).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);

    await page.getByRole("button", { name: "I saved them — continue" }).click();
    await expect(page.getByRole("heading", { name: "Contracts", level: 1 })).toBeVisible(); // the page it was asked for
    expect((await page.request.get("/api/admin/contracts/changes")).status()).toBe(200);

    // The 12-hour proof is gone (e.g. expired): the code screen, API 404 again.
    await context.clearCookies({ name: "cherrio_admin_mfa" });
    await page.goto("/en/admin/contracts");
    await expect(page.getByRole("heading", { name: "Confirm it is you" })).toBeVisible();
    expect((await page.request.get("/api/admin/contracts/changes")).status()).toBe(404);

    await page.getByLabel("6-digit code or a recovery code").fill(recovery.toLowerCase());
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Contracts", level: 1 })).toBeVisible();
    expect((await page.request.get("/api/admin/contracts/changes")).status()).toBe(200);

    // A recovery code works once.
    await context.clearCookies({ name: "cherrio_admin_mfa" });
    await page.goto("/en/admin");
    await page.getByLabel("6-digit code or a recovery code").fill(recovery);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "That code is not right" })).toBeVisible();
  } finally {
    await deleteTestUser(adminId);
  }
});
