import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import middleware from "@/middleware";
import { ADMIN_HEADERS, isAdminPath } from "@/lib/security/admin-area";
import { AI_CRAWLERS, robotsBody } from "@/lib/security/robots";

// TASK-035 (David 2026-10-04): the admin area must look like it does not exist
// to everyone but platform admins — people, search engines and AI crawlers.

const APP = path.resolve(__dirname, "../app");
const files = (dir: string, name: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? files(p, name) : f === name ? [p] : [];
  });

afterEach(() => vi.unstubAllEnvs());

describe("admin paths", () => {
  it("matches the admin area only", () => {
    for (const p of ["/en/admin", "/en/admin/contracts", "/admin", "/admin/kyb/1", "/api/admin/contracts/changes", "/api/admin"])
      expect(isAdminPath(p), p).toBe(true);
    for (const p of ["/en/administrator", "/en/campaigns/admin-help", "/api/administer", "/en", "/api/rpc", "/en/account"])
      expect(isAdminPath(p), p).toBe(false);
  });
});

describe("middleware headers", () => {
  const run = (url: string) => middleware(new NextRequest(new URL(url, "https://app.cherr.io")));

  it("prod: every admin page and API response says noindex and no-store", () => {
    vi.stubEnv("APP_ENV", "prod");
    for (const url of ["/en/admin/contracts", "/en/admin", "/api/admin/contracts/changes"]) {
      const res = run(url);
      for (const [name, value] of Object.entries(ADMIN_HEADERS)) expect(res.headers.get(name), `${url} ${name}`).toBe(value);
    }
  });

  it("prod: public pages stay indexable (search engines and AI crawlers welcome)", () => {
    vi.stubEnv("APP_ENV", "prod");
    expect(run("/en/campaigns").headers.get("X-Robots-Tag")).toBeNull();
    expect(run("/api/rpc").headers.get("X-Robots-Tag")).toBeNull();
  });

  it("dev: public pages noindex as before, admin pages the stronger admin header", () => {
    vi.stubEnv("APP_ENV", "dev");
    expect(run("/en/campaigns").headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(run("/en/admin").headers.get("X-Robots-Tag")).toBe(ADMIN_HEADERS["X-Robots-Tag"]);
  });
});

describe("robots.txt", () => {
  it("prod allows every crawler and does not mention the admin area", () => {
    expect(robotsBody("prod")).toBe("User-agent: *\nAllow: /\n");
    expect(robotsBody("prod")).not.toContain("admin");
  });

  it("other environments block every crawler, AI crawlers also by name", () => {
    for (const env of ["dev", "uat", "local", undefined]) {
      const body = robotsBody(env);
      expect(body.startsWith("User-agent: *\nDisallow: /\n")).toBe(true);
      for (const ua of AI_CRAWLERS) expect(body).toContain(`User-agent: ${ua}\nDisallow: /\n`);
      expect(body).not.toContain("admin");
    }
  });
});

describe("every admin page and route is guarded", () => {
  it("the admin layout answers 404 to non-admins and asks robots not to index", () => {
    const layout = readFileSync(path.join(APP, "[locale]/admin/layout.tsx"), "utf8");
    expect(layout).toMatch(/requireRole\("PLATFORM_ADMIN"\)[\s\S]*notFound\(\)/);
    expect(layout).toMatch(/robots:\s*\{\s*index:\s*false/);
  });

  it("every admin page checks the role itself too", () => {
    const pages = files(path.join(APP, "[locale]/admin"), "page.tsx");
    expect(pages.length).toBeGreaterThanOrEqual(8);
    for (const p of pages) {
      const src = readFileSync(p, "utf8");
      expect(src, path.relative(APP, p)).toMatch(/requireRole\("PLATFORM_ADMIN"\)[\s\S]*notFound\(\)/);
    }
  });

  it("every admin API handler answers 404 to an anonymous request", async () => {
    const routes = files(path.join(APP, "api/admin"), "route.ts");
    expect(routes.length).toBeGreaterThanOrEqual(12);
    let calls = 0;
    for (const file of routes) {
      const mod = (await import(file)) as Record<string, unknown>;
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const handler = mod[method];
        if (typeof handler !== "function") continue;
        const req = new Request("https://app.cherr.io/api/admin/x", {
          method,
          headers: { Origin: "https://app.cherr.io", "Content-Type": "application/json" },
          ...(method === "GET" ? {} : { body: "{}" }),
        });
        const params = Promise.resolve({ id: "01890000-0000-7000-8000-000000000000", submissionId: "01890000-0000-7000-8000-000000000000", mediaId: "01890000-0000-7000-8000-000000000000" });
        const res = (await (handler as (r: Request, c: unknown) => Promise<Response>)(req, { params })) as Response;
        expect(res.status, `${method} ${path.relative(APP, file)}`).toBe(404);
        calls++;
      }
    }
    expect(calls).toBeGreaterThanOrEqual(12);
  });
});
