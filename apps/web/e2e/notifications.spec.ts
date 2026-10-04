/**
 * apps/web/e2e/notifications.spec.ts
 * Email notifications (TASK-033e part 3, ADR-048): a wallet-only user leaves
 * an address, confirms it with the emailed link, and stops the emails with the
 * link from an email. The worker is not running here: the confirmation link is
 * read from the queued EMAIL_CONFIRM row.
 */
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { and, eq } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { deleteTestUser, loginAsNewUser } from "./helpers/session";

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("E2E needs DATABASE_URL");
  return schema.createDb(url, { max: 1 });
}

async function expectNoA11yViolations(page: Page, label: string) {
  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations, `a11y violations on ${label}`).toEqual([]);
}

test.describe("email notifications", () => {
  const userIds: string[] = [];

  test.afterEach(async () => {
    const client = db();
    try {
      for (const id of userIds) {
        await client.delete(schema.notifications).where(eq(schema.notifications.userId, id));
        await client.delete(schema.notificationPreferences).where(eq(schema.notificationPreferences.userId, id));
      }
    } finally {
      await client.$client.end();
    }
    for (const id of userIds.splice(0)) await deleteTestUser(id);
  });

  test("a wallet-only user confirms an address, then stops the emails from the link", async ({ page, context }, info) => {
    const run = `nt-${info.project.name}-${Date.now()}`;
    const userId = await loginAsNewUser(context, `notify-${run}`);
    userIds.push(userId);
    const client = db();
    try {
      await client.update(schema.users).set({ email: null }).where(eq(schema.users.id, userId));
    } finally {
      await client.$client.end();
    }
    const address = `${run}@example.com`.toLowerCase();

    // My donations points to the settings when there is no address.
    await page.goto("/en/account/donations");
    await page.getByRole("link", { name: "Set up email notifications" }).click();
    await expect(page.getByRole("heading", { name: "Email notifications", level: 1 })).toBeVisible();
    await expect(page.getByText("We have no email address for you, so you get no emails.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Leave an email" })).toBeVisible();
    await expect(page.getByText(/0 status points · 0 reward points · no votes yet/)).toBeVisible();
    await expectNoA11yViolations(page, "notification settings");

    await page.locator("section[aria-labelledby='contact-title']").getByLabel("Email address").fill(address);
    await page.getByRole("button", { name: "Send the confirmation link" }).click();
    await expect(page.getByText(`We sent a confirmation link to ${address}. Open it within 24 hours.`)).toBeVisible();

    // The worker would email this link; here it is read from the queue.
    const c2 = db();
    let token: string;
    let unsubscribeToken: string;
    try {
      const [row] = await c2.select().from(schema.notifications)
        .where(and(eq(schema.notifications.userId, userId), eq(schema.notifications.kind, "EMAIL_CONFIRM")));
      expect(row!.data).toMatchObject({ email: address });
      token = (row!.data as { token: string }).token;
      const [prefs] = await c2.select().from(schema.notificationPreferences).where(eq(schema.notificationPreferences.userId, userId));
      unsubscribeToken = prefs!.unsubscribeToken;
    } finally {
      await c2.$client.end();
    }

    await page.goto(`/api/notifications/confirm?token=${token}`);
    await expect(page).toHaveURL(/\/en\/notifications\/confirmed\?ok=1$/);
    await expect(page.getByRole("heading", { name: "Email confirmed" })).toBeVisible();
    await page.getByRole("link", { name: "Email settings" }).click();
    await expect(page.getByText(`Emails go to ${address}.`)).toBeVisible();
    await expect(page.getByText(`Confirmed address: ${address}`)).toBeVisible();
    // With a confirmed address the section is about changing it; the same address again is refused (TASK-033f polish).
    await expect(page.getByRole("heading", { name: "Change address" })).toBeVisible();
    await page.locator("section[aria-labelledby='contact-title']").getByLabel("New email address").fill(address.toUpperCase());
    await page.getByRole("button", { name: "Send the confirmation link" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "This is already your confirmed address — nothing to confirm." })).toBeVisible();

    // Opening the unsubscribe link changes nothing; the button does.
    await page.goto(`/en/notifications/unsubscribe?token=${unsubscribeToken}`);
    await expect(page.getByRole("heading", { name: "Stop emails from CHERR.IO" })).toBeVisible();
    await expectNoA11yViolations(page, "unsubscribe");
    const c3 = db();
    try {
      const [before] = await c3.select().from(schema.notificationPreferences).where(eq(schema.notificationPreferences.userId, userId));
      expect(before!.emailEnabled).toBe(true);
      await page.getByRole("button", { name: "Stop these emails" }).click();
      await expect(page.getByText("Done. You will not get these emails any more.")).toBeVisible();
      const [after] = await c3.select().from(schema.notificationPreferences).where(eq(schema.notificationPreferences.userId, userId));
      expect(after!.emailEnabled).toBe(false);
    } finally {
      await c3.$client.end();
    }
    await page.goto("/en/account/notifications");
    await expect(page.getByText("Emails are switched off.")).toBeVisible();
    await expect(page.getByLabel(/Send me these emails/)).not.toBeChecked();
  });
});
