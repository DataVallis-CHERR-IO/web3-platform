/**
 * apps/web/e2e/admin-view-nav.spec.ts
 * Admin list views (TASK-051): on a phone the view tabs of Admin → Campaigns and
 * Admin → Organisations are one full-width row each, with the count at the right
 * edge; on a desktop they stay in one row.
 */
import { test, expect, type Page } from "@playwright/test";
import { deleteTestUser, loginAsNewUser } from "./helpers/session";

async function navBoxes(page: Page, navName: string) {
  const nav = page.getByRole("navigation", { name: navName });
  const navBox = (await nav.boundingBox())!;
  const links = nav.getByRole("link");
  const boxes = [];
  for (let i = 0; i < (await links.count()); i++)
    boxes.push((await links.nth(i).boundingBox())!);
  return { navBox, boxes };
}

const PAGES = [
  { path: "/en/admin/campaigns", nav: "Campaign stages", tabs: 6 },
  {
    path: "/en/admin/organizations",
    nav: "Filter by verification status",
    tabs: 5,
  },
];

test("admin view tabs: one row per view on a phone, one line on a desktop", async ({
  page,
  context,
}, info) => {
  const adminId = await loginAsNewUser(
    context,
    `view-nav-${info.project.name}-${Date.now()}`,
    { admin: true },
  );
  try {
    for (const { path, nav, tabs } of PAGES) {
      await page.goto(path);
      const { navBox, boxes } = await navBoxes(page, nav);
      expect(boxes, path).toHaveLength(tabs);
      if (info.project.name === "chromium-390") {
        for (const [i, box] of boxes.entries()) {
          // Full width inside the 3px frame, stacked top to bottom.
          expect(
            Math.abs(box.width - (navBox.width - 6)),
            `${path} tab ${i} width`,
          ).toBeLessThanOrEqual(1);
          if (i > 0)
            expect(
              box.y,
              `${path} tab ${i} below the previous one`,
            ).toBeGreaterThanOrEqual(
              boxes[i - 1]!.y + boxes[i - 1]!.height - 1,
            );
        }
      } else {
        const top = boxes[0]!.y + boxes[0]!.height / 2;
        for (const [i, box] of boxes.entries()) {
          expect(
            Math.abs(box.y + box.height / 2 - top),
            `${path} tab ${i} on one line`,
          ).toBeLessThanOrEqual(2);
        }
      }
    }
  } finally {
    await deleteTestUser(adminId);
  }
});
