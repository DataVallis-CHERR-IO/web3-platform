import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { getDb } from "@/lib/db";
import { decodeCursor, encodeCursor, PAGE_SIZE, type Cursor } from "@/lib/admin/listing";
import { listOrganizations } from "@/lib/admin/organizations";
import { campaignCounts, listCampaigns } from "@/lib/admin/campaigns";
import { cleanUp, createUser, type TestUser } from "./helpers/organizations";

// Admin overview lists (TASK-029 §3) on Postgres: filters, search, and keyset
// pagination that never skips or repeats a row — also when many rows share
// the same timestamp.

const { organizations, campaigns } = schema;
const RUN = `ovw${Date.now().toString(36)}`;
const orgIds: string[] = [];
const roundTrip = (cursor: Cursor | null) => (cursor ? decodeCursor({ after: encodeCursor(cursor) }) : null);

describe("admin overview lists (Postgres)", () => {
  let owner: TestUser;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("admin overview tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    await getDb().execute(sql`select 1`);
    owner = await createUser();
    // 60 organisations in ONE insert: they all share created_at, so only the id orders them.
    const rows = Array.from({ length: 60 }, (_, i) => ({
      source: i % 3 === 0 ? ("IMPORTED" as const) : ("REGISTERED" as const),
      name: `${RUN} Shelter ${String(i).padStart(2, "0")}`,
      legalName: i === 7 ? `${RUN} 100%_legal` : i === 8 ? `${RUN} Društvo Čebelarjev Žalec` : null,
      country: i % 2 === 0 ? "SI" : "HR",
      registry: "NONE" as const,
      causes: ["animals"],
      kybStatus: i < 10 ? ("APPROVED" as const) : ("NONE" as const),
    }));
    const inserted = await getDb().insert(organizations).values(rows).returning({ id: organizations.id });
    orgIds.push(...inserted.map((r) => r.id));
  });
  afterAll(async () => {
    await getDb().delete(campaigns).where(inArray(campaigns.orgId, orgIds));
    await getDb().delete(organizations).where(inArray(organizations.id, orgIds));
    await cleanUp();
  });

  it("organisations: two pages of 50 + 10 with identical timestamps — every row exactly once, in a stable order", async () => {
    const filters = { q: RUN, kyb: "all" as const, source: "all" as const, country: "" };
    const first = await listOrganizations(getDb(), filters, null);
    expect(first.rows).toHaveLength(PAGE_SIZE);
    expect(first.next).not.toBeNull();
    expect(first.next!.key).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    const second = await listOrganizations(getDb(), filters, roundTrip(first.next));
    expect(second.rows).toHaveLength(10);
    expect(second.next).toBeNull();
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(60);
    expect([...ids].sort()).toEqual([...orgIds].sort());
    // Same query again: same first page (stable order).
    expect((await listOrganizations(getDb(), filters, null)).rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));
  });

  it("organisations: filters by KYB status, source and country; search is literal (% and _ are not wildcards)", async () => {
    const base = { q: RUN, kyb: "all" as const, source: "all" as const, country: "" };
    expect((await listOrganizations(getDb(), { ...base, kyb: "APPROVED" }, null)).rows).toHaveLength(10);
    expect((await listOrganizations(getDb(), { ...base, source: "IMPORTED" }, null)).rows).toHaveLength(20);
    expect((await listOrganizations(getDb(), { ...base, country: "HR" }, null)).rows).toHaveLength(30);
    expect((await listOrganizations(getDb(), { ...base, q: `${RUN} 100%_legal` }, null)).rows.map((r) => r.name)).toEqual([
      `${RUN} Shelter 07`,
    ]);
    expect((await listOrganizations(getDb(), { ...base, q: `${RUN} 1__%` }, null)).rows).toEqual([]);
    expect((await listOrganizations(getDb(), { ...base, q: `${RUN} shelter 4` }, null)).rows).toHaveLength(10); // case-insensitive
    // Accent-insensitive both ways (TASK-054): plain letters find the accented name, accents in the query are ignored.
    expect((await listOrganizations(getDb(), { ...base, q: `${RUN} drustvo cebelarjev zalec` }, null)).rows.map((r) => r.name)).toEqual([
      `${RUN} Shelter 08`,
    ]);
    expect((await listOrganizations(getDb(), { ...base, q: `${RUN} Shélter 08` }, null)).rows.map((r) => r.name)).toEqual([`${RUN} Shelter 08`]);
  });

  it("campaigns: each view shows its status in its order; search by title or organisation; counts per view", async () => {
    const day = (n: number) => new Date(Date.UTC(2026, 8, n, 12));
    const make = (
      n: number,
      status: "DRAFT" | "PENDING_REVIEW" | "APPROVED" | "DEPLOYED" | "REJECTED",
      extra: Record<string, unknown> = {}
    ) => ({
      orgId: orgIds[n % 10]!, starterUserId: owner.id, beneficiaryType: "ORGANIZATION" as const,
      title: `${RUN} campaign ${n}`, slug: `${RUN}-c-${n}`, story: { format: "plain", text: "x".repeat(60) },
      cause: "animals", country: n % 2 ? "SI" : "AT", goalAmountMinor: "100000", durationDays: 30, status,
      beneficiaryAddress: status === "APPROVED" || status === "DEPLOYED" ? "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed" : null,
      ...extra,
    });
    const before = await campaignCounts(getDb());
    await getDb().insert(campaigns).values([
      make(1, "PENDING_REVIEW", { submittedAt: day(3) }),
      make(2, "PENDING_REVIEW", { submittedAt: day(1) }),
      make(3, "PENDING_REVIEW", { submittedAt: day(2) }),
      make(4, "APPROVED", { reviewedAt: day(5) }),
      make(5, "DEPLOYED", { deployedAt: day(9), onchainAddress: `0x${"f3".repeat(20)}` }),
      make(6, "REJECTED", { reviewedAt: day(4) }),
      make(7, "DRAFT"),
    ]);
    const list = async (view: Parameters<typeof listCampaigns>[1]["view"], q = RUN, country = "") =>
      (await listCampaigns(getDb(), { view, q, country }, null)).rows.map((r) => r.title.replace(`${RUN} campaign `, ""));

    expect(await list("review")).toEqual(["2", "3", "1"]); // oldest submission first
    expect(await list("publish")).toEqual(["4"]);
    expect(await list("live")).toEqual(["5"]);
    expect(await list("rejected")).toEqual(["6"]);
    expect(await list("drafts")).toEqual(["7"]);
    expect((await list("all")).sort()).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(await list("review", RUN, "SI")).toEqual(["3", "1"]);
    // Search by the organisation's name finds its campaigns.
    expect(await list("all", `${RUN} Shelter 05`)).toEqual(["5"]);
    expect(await list("all", `${RUN} Šhelter 05`)).toEqual(["5"]); // accents ignored (TASK-054)

    const after = await campaignCounts(getDb());
    expect(after.review - before.review).toBe(3);
    expect(after.all - before.all).toBe(7);
  });

  it("campaigns: a campaign for an individual (org_id null) is listed without an organisation", async () => {
    const [row] = await getDb()
      .insert(campaigns)
      .values({
        orgId: null, starterUserId: owner.id, beneficiaryType: "INDIVIDUAL", title: `${RUN} individual`,
        slug: `${RUN}-individual`, story: { format: "plain", text: "x".repeat(60) }, cause: "health", country: "SI",
        goalAmountMinor: "100000", durationDays: 30, status: "PENDING_REVIEW", submittedAt: new Date(),
      })
      .returning({ id: campaigns.id });
    try {
      for (const view of ["review", "all"] as const) {
        const { rows } = await listCampaigns(getDb(), { view, q: `${RUN} individual`, country: "" }, null);
        expect(rows.map((r) => [r.id, r.organization, r.organizationId])).toEqual([[row!.id, null, null]]);
      }
    } finally {
      await getDb().delete(campaigns).where(inArray(campaigns.id, [row!.id]));
    }
  });

  it("campaigns: paging the review queue (ascending) neither skips nor repeats", async () => {
    const rows = Array.from({ length: 55 }, (_, i) => ({
      orgId: orgIds[20]!, starterUserId: owner.id, beneficiaryType: "ORGANIZATION" as const,
      title: `${RUN} bulk ${i}`, slug: `${RUN}-bulk-${i}`, story: { format: "plain", text: "x".repeat(60) },
      cause: "animals", country: "SI", goalAmountMinor: "100000", durationDays: 30, status: "PENDING_REVIEW" as const,
      submittedAt: new Date(Date.UTC(2026, 8, 1 + (i % 3))), // many share a timestamp
    }));
    await getDb().insert(campaigns).values(rows);
    const filters = { view: "review" as const, q: `${RUN} bulk`, country: "" };
    const first = await listCampaigns(getDb(), filters, null);
    const second = await listCampaigns(getDb(), filters, roundTrip(first.next));
    expect(first.rows).toHaveLength(50);
    expect(second.rows).toHaveLength(5);
    const all = [...first.rows, ...second.rows];
    expect(new Set(all.map((r) => r.id)).size).toBe(55);
    const dates = all.map((r) => r.date.getTime());
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });

  it("a broken cursor in the URL means the first page", () => {
    expect(decodeCursor({ after: "not-base64-json" })).toBeNull();
    expect(decodeCursor({ after: Buffer.from(JSON.stringify(["2026-10-03", "x"])).toString("base64url") })).toBeNull();
    expect(
      decodeCursor({
        after: Buffer.from(JSON.stringify(["'; drop table x; --", "01890000-0000-7000-8000-000000000000"])).toString("base64url"),
      })
    ).toBeNull();
  });
});
