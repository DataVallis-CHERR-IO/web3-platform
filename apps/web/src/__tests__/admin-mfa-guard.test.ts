import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanUp, createUser } from "./helpers/organizations";

// TASK-049b / ADR-056: no admin page or route works without the second factor.

const SRC = path.resolve(__dirname, "..");
const APP = path.join(SRC, "app");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
  });

afterAll(cleanUp);

describe("the second factor is part of the admin gate", () => {
  it("the role-only check is used only by the MFA routes and the admin layout", () => {
    const users = walk(SRC)
      .filter((p) => !p.includes("__tests__"))
      .filter((p) => /requirePlatformAdminRole\(/.test(readFileSync(p, "utf8")))
      .map((p) => path.relative(SRC, p))
      .sort();
    expect(users).toEqual([
      "app/[locale]/admin/layout.tsx",
      "lib/auth/mfa-route.ts",
      "lib/auth/session.ts",
    ]);
  });

  it("every admin API handler except /api/admin/mfa/* answers 404 to an admin without the factor", async () => {
    const noFactor = await createUser({ admin: true, mfa: false });
    const routes = walk(path.join(APP, "api/admin")).filter(
      (p) => p.endsWith("route.ts") && !p.includes(`${path.sep}mfa${path.sep}`)
    );
    expect(routes.length).toBeGreaterThanOrEqual(12);
    let calls = 0;
    for (const file of routes) {
      const mod = (await import(file)) as Record<string, unknown>;
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        const handler = mod[method];
        if (typeof handler !== "function") continue;
        const req = new Request("http://localhost:3000/api/admin/x", {
          method,
          headers: { Origin: "http://localhost:3000", "Content-Type": "application/json", Cookie: noFactor.cookie },
          ...(method === "GET" ? {} : { body: "{}" }),
        });
        const id = "01890000-0000-7000-8000-000000000000";
        const params = Promise.resolve({ id, submissionId: id, mediaId: id });
        const res = await (handler as (r: Request, c: unknown) => Promise<Response>)(req, { params });
        expect(res.status, `${method} ${path.relative(APP, file)}`).toBe(404);
        calls++;
      }
    }
    expect(calls).toBeGreaterThanOrEqual(12);
  });
});
