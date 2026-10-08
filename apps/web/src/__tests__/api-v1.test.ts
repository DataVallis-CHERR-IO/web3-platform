import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import Ajv2020 from "ajv/dist/2020";
import * as schema from "@cherrio/db";
import { TRUST_SCORE_VERSION } from "@cherrio/shared/trust";
import { getDb } from "@/lib/db";
import { openApiDocument } from "@/lib/api/openapi";
import { apiRateLimiter, API_RATE_LIMIT } from "@/lib/api/v1";
import { GET as listOrgs } from "@/app/api/v1/organizations/route";
import { GET as getOrg } from "@/app/api/v1/organizations/[id]/route";
import { GET as listCampaigns } from "@/app/api/v1/campaigns/route";
import { GET as getCampaign } from "@/app/api/v1/campaigns/[slug]/route";
import { GET as openapi } from "@/app/api/v1/openapi.json/route";

// TASK-018b: the public read API. Real handlers against Postgres; every 200
// response is validated against the OpenAPI document's own schema.

if (!process.env.DATABASE_URL) throw new Error("api tests need DATABASE_URL");
const db = getDb();
const { organizations, trustScores, registryRecords } = schema;
const RUN = `Api${Date.now().toString(36)}`;
const ids: string[] = [];
const doc = openApiDocument("http://localhost:3000");
const ajv = new Ajv2020({ strict: false, validateFormats: false, allowUnionTypes: true });
type Doc = { paths: Record<string, { get: { responses: Record<string, { content?: { "application/json": { schema: object } } }> } }> };
const schemaOf = (path: string) => (doc as unknown as Doc).paths[path]!.get.responses["200"]!.content!["application/json"].schema;
let ip = 0;
const req = (path: string) => new Request(`http://localhost:3000${path}`, { headers: { "x-forwarded-for": `10.9.${Math.floor(++ip / 250)}.${ip % 250}` } });

function expectValid(path: string, body: unknown) {
  const validate = ajv.compile(schemaOf(path));
  const ok = validate(body);
  expect(ok, JSON.stringify(validate.errors)).toBe(true);
}

beforeAll(async () => {
  for (const [name, score, reg] of [["Alpha", "61.00", true], ["Beta", "36.00", false]] as const) {
    const [o] = await db
      .insert(organizations)
      .values({ source: reg ? "REGISTERED" : "IMPORTED", name: `${RUN} ${name}`, country: "GB", registry: reg ? "NONE" : "UK_CC", registryId: reg ? null : `${RUN}1`, causes: ["animals"], kybStatus: reg ? "APPROVED" : "NONE" })
      .returning({ id: organizations.id });
    ids.push(o!.id);
    await db.insert(trustScores).values({ orgId: o!.id, version: TRUST_SCORE_VERSION, score, components: { kind: reg ? "registered" : "imported" }, listed: true, registered: reg, country: "GB", causes: ["animals"], raised: reg ? "2240000" : "0" });
  }
  await db.insert(registryRecords).values({ registry: "UK_CC", registryId: `${RUN}1`, raw: { status: "Registered", income: 5000, contactEmail: "never@example.org" } });
});

afterAll(async () => {
  await db.delete(trustScores).where(inArray(trustScores.orgId, ids));
  await db.delete(registryRecords).where(inArray(registryRecords.registryId, [`${RUN}1`]));
  await db.delete(organizations).where(inArray(organizations.id, ids));
});

describe("public API v1", () => {
  it("lists organisations with a cursor, as the OpenAPI schema says", async () => {
    const res = await listOrgs(req(`/api/v1/organizations?q=${RUN}&limit=1`));
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.json();
    expectValid("/organizations", body);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ name: `${RUN} Alpha`, trustScore: "61.00", onCherrio: true, raisedUsdc: "2240000", position: 1 });
    const second = await (await listOrgs(req(`/api/v1/organizations?q=${RUN}&limit=1&after=${encodeURIComponent(body.next)}`))).json();
    expect(second.data[0]).toMatchObject({ name: `${RUN} Beta`, position: 2 });
    expect(second.next).toBeNull();
  });

  it("returns one organisation with register facts, never other register fields", async () => {
    const body = await (await getOrg(req(`/api/v1/organizations/${ids[1]}`), { params: Promise.resolve({ id: ids[1]! }) })).json();
    expectValid("/organizations/{id}", body);
    expect(body.data.register).toMatchObject({ name: "UK_CC", facts: { status: "Registered", income: 5000 } });
    expect(JSON.stringify(body)).not.toContain("never@example.org");
    const missing = await getOrg(req("/api/v1/organizations/x"), { params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000000" }) });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "not_found" });
  });

  it("lists campaigns and 404s an unknown slug", async () => {
    const res = await listCampaigns(req("/api/v1/campaigns?sort=newest"));
    expect(res.status).toBe(200);
    expectValid("/campaigns", await res.json());
    expect((await getCampaign(req("/api/v1/campaigns/nope"), { params: Promise.resolve({ slug: `${RUN.toLowerCase()}-nope` }) })).status).toBe(404);
    expect((await getCampaign(req("/api/v1/campaigns/x"), { params: Promise.resolve({ slug: "../etc" }) })).status).toBe(404);
  });

  it("limits each IP to 120 requests a minute", async () => {
    apiRateLimiter.check("10.250.0.1", API_RATE_LIMIT);
    for (let i = 1; i < API_RATE_LIMIT.maxRequests; i++) apiRateLimiter.check("10.250.0.1", API_RATE_LIMIT);
    const res = await listOrgs(new Request("http://localhost:3000/api/v1/organizations", { headers: { "x-forwarded-for": "10.250.0.1" } }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("serves the OpenAPI document", async () => {
    const body = await (await openapi()).json();
    expect(body.openapi).toBe("3.1.0");
    expect(Object.keys(body.paths)).toEqual(["/organizations", "/organizations/{id}", "/campaigns", "/campaigns/{slug}"]);
  });
});
