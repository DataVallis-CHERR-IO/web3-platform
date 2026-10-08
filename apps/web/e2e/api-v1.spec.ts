/**
 * apps/web/e2e/api-v1.spec.ts
 * TASK-018b: the public API answers through the running server (middleware,
 * CORS) and its reference page lists every endpoint from the OpenAPI document.
 */
import { test, expect } from "@playwright/test";

test("public API: JSON with CORS, OpenAPI document and reference page", async ({ page, request }) => {
  const res = await request.get("/api/v1/organizations?limit=2");
  expect(res.status()).toBe(200);
  expect(res.headers()["access-control-allow-origin"]).toBe("*");
  const body = await res.json();
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.data.length).toBeLessThanOrEqual(2);

  const doc = await (await request.get("/api/v1/openapi.json")).json();
  expect(doc.openapi).toBe("3.1.0");

  await page.goto("/en/docs/api");
  await expect(page.getByRole("heading", { level: 1, name: "Public API" })).toBeVisible();
  for (const path of Object.keys(doc.paths)) {
    await expect(page.getByRole("heading", { level: 2, name: `GET ${path}`, exact: true })).toBeVisible();
  }
});
