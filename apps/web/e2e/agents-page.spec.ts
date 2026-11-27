/**
 * apps/web/e2e/agents-page.spec.ts
 * TASK-061f: the public testnet page "What the agents do" — reachable from the
 * footer on dev/local (Playwright runs APP_ENV=local), lists the whole crew with
 * its jobs and links to the public runs; axe at both widths. Read-only.
 */
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { AGENT_CREW } from "@cherrio/shared/agent-crew";

test("the agents page lists the crew and is linked from the footer", async ({ page }, info) => {
  await page.goto("/en/campaigns");
  await page.getByRole("contentinfo").getByRole("link", { name: "Testnet agents", exact: true }).click();
  await expect(page).toHaveURL(/\/en\/agents$/);
  await expect(page.getByRole("heading", { level: 1, name: "What the agents do" })).toBeVisible();

  const crew = page.getByRole("list", { name: "Each agent, its job and its public test wallet" });
  for (const member of AGENT_CREW) {
    await expect(crew.getByRole("heading", { level: 3, name: `Agent ${member.name}`, exact: true })).toBeVisible();
  }
  await expect(crew.getByText("Reviews and publishes the crew's own charities and campaigns")).toBeVisible();
  await expect(page.getByRole("link", { name: "the agents' runs on GitHub Actions" })).toHaveAttribute(
    "href", "https://github.com/DataVallis-CHERR-IO/web3-platform/actions/workflows/agents.yml"
  );

  // Nothing wider than the screen (390 px phone too).
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontal overflow on ${info.project.name}`).toBeLessThanOrEqual(0);

  await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  expect(results.violations, "a11y violations on /en/agents").toEqual([]);
});
