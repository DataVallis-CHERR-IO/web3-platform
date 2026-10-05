/**
 * apps/web/e2e/legal.spec.ts
 * Terms of Service and Privacy Policy (TASK-044, ADR-054): linked from the
 * footer, marked as a draft under legal review, the sanctions and card-partner
 * rules present, and axe-clean.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

for (const doc of [
  { link: "Terms", path: "terms", title: "Terms of Service", must: [/under EU, US or UN sanctions/, /CHERR\.IO is not a party to it/, /1 % platform fee/] },
  { link: "Privacy", path: "privacy", title: "Privacy Policy", must: [/The blockchain is public/, /Informacijski pooblaščenec/] },
] as const) {
  test(`footer → ${doc.title}: draft notice, key rules, accessible`, async ({ page }) => {
    await page.goto("/en");
    await page.getByRole("contentinfo").getByRole("link", { name: doc.link, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/en/${doc.path}$`));
    await expect(page.getByRole("heading", { level: 1, name: doc.title })).toBeVisible();
    await expect(page.getByText(/^Draft 0\.1 — published for transparency while it is reviewed by a lawyer\./)).toBeVisible();
    for (const text of doc.must) await expect(page.getByText(text).first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations).toEqual([]);
  });
}
