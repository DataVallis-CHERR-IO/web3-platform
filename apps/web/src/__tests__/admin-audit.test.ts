import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like, sql } from "drizzle-orm";
import { auditLog } from "@cherrio/db";
import { getDb } from "@/lib/db";
import { decodeCursor, encodeCursor, PAGE_SIZE, type Cursor } from "@/lib/admin/listing";
import {
  auditDataText,
  auditEntityHref,
  auditEntityTypes,
  auditFilters,
  listAuditLog,
  type AuditFilters,
} from "@/lib/admin/audit";
import { cleanUp, createUser, type TestUser } from "./helpers/organizations";

// Admin → Audit log (TASK-021) on Postgres: keyset pages that never skip or
// repeat a row (also with identical timestamps), and every filter.

const RUN = `t021${Date.now().toString(36)}`;
const TYPE = `${RUN}_thing`;
const ENTITY = "0b6f3c1e-5d0a-4c3b-9a51-2f7e8d1c0a01";
const roundTrip = (cursor: Cursor | null) => (cursor ? decodeCursor({ after: encodeCursor(cursor) }) : null);
const all = (over: Partial<AuditFilters> = {}): AuditFilters => ({ q: "", type: TYPE, actor: "", entity: "", ...over });

describe("admin audit log (Postgres)", () => {
  let actor: TestUser;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("admin audit tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    actor = await createUser();
    // 60 rows in ONE insert: they share created_at, so only the id orders them.
    await getDb().insert(auditLog).values(
      Array.from({ length: 60 }, (_, i) => ({
        actorUserId: i < 20 ? actor.id : null,
        action: i === 5 ? `${RUN}.100%_done` : i % 2 === 0 ? `${RUN}.kyb.approve` : `${RUN}.campaign.publish_sent`,
        entityType: TYPE,
        entityId: i === 7 ? ENTITY : null,
        data: i === 0 ? { txHash: "0xabc" } : {},
      }))
    );
  });
  afterAll(async () => {
    await getDb().delete(auditLog).where(eq(auditLog.entityType, TYPE));
    await cleanUp();
  });

  it("two pages of 50 + 10 with identical timestamps — every row exactly once, stable order", async () => {
    const first = await listAuditLog(getDb(), all(), null);
    expect(first.rows).toHaveLength(PAGE_SIZE);
    expect(first.next).not.toBeNull();
    const second = await listAuditLog(getDb(), all(), roundTrip(first.next));
    expect(second.rows).toHaveLength(10);
    expect(second.next).toBeNull();
    const ids = [...first.rows, ...second.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(60);
    expect((await listAuditLog(getDb(), all(), null)).rows.map((r) => r.id)).toEqual(first.rows.map((r) => r.id));
  });

  it("newest first across different times", async () => {
    await getDb().insert(auditLog).values({ action: `${RUN}.later`, entityType: TYPE, createdAt: sql`now() + interval '1 minute'` });
    const { rows } = await listAuditLog(getDb(), all(), null);
    expect(rows[0]!.action).toBe(`${RUN}.later`);
    await getDb().delete(auditLog).where(like(auditLog.action, `${RUN}.later`));
  });

  it("filters by part of the action (% and _ literal), person, system and entity", async () => {
    const kyb = await listAuditLog(getDb(), all({ q: "kyb.app" }), null);
    expect(kyb.rows).toHaveLength(30);
    expect(kyb.rows.every((r) => r.action.endsWith(".kyb.approve"))).toBe(true);

    const literal = await listAuditLog(getDb(), all({ q: "100%_" }), null);
    expect(literal.rows.map((r) => r.action)).toEqual([`${RUN}.100%_done`]);

    const person = await listAuditLog(getDb(), all({ actor: actor.id }), null);
    expect(person.rows).toHaveLength(20);
    expect(person.rows.every((r) => r.actorUserId === actor.id && r.actorName === "Org test user")).toBe(true);

    const system = await listAuditLog(getDb(), all({ actor: "system" }), null);
    expect(system.rows.length + (system.next ? 1 : 0)).toBeGreaterThan(0);
    expect(system.rows.every((r) => r.actorUserId === null && r.actorName === null)).toBe(true);

    const entity = await listAuditLog(getDb(), all({ entity: ENTITY }), null);
    expect(entity.rows).toHaveLength(1);
    expect(entity.rows[0]!.entityId).toBe(ENTITY);
  });

  it("entity types come from the data; URL filters drop unknown or malformed values", async () => {
    const types = await auditEntityTypes(getDb());
    expect(types).toContain(TYPE);
    expect(auditFilters({ type: TYPE, actor: "system", entity: ENTITY.toUpperCase(), q: " mfa " }, types)).toEqual({
      q: "mfa",
      type: TYPE,
      actor: "system",
      entity: ENTITY,
    });
    expect(auditFilters({ type: "nope", actor: "1; drop table", entity: "x" }, types)).toEqual({ q: "", type: "", actor: "", entity: "" });
    expect(auditFilters({ q: "a".repeat(300) }, types).q).toHaveLength(100);
  });

  it("links admin pages only for entities that have one; empty data shows nothing", () => {
    expect(auditEntityHref("campaign", ENTITY)).toBe(`/admin/campaigns/${ENTITY}`);
    expect(auditEntityHref("organization", ENTITY)).toBe(`/admin/organizations/${ENTITY}`);
    expect(auditEntityHref("kyb_submission", ENTITY)).toBe(`/admin/kyb/${ENTITY}`);
    expect(auditEntityHref("user", ENTITY)).toBeNull();
    expect(auditEntityHref("campaign", null)).toBeNull();
    expect(auditDataText({})).toBeNull();
    expect(auditDataText(null)).toBeNull();
    expect(auditDataText({ txHash: "0xabc" })).toBe('{"txHash":"0xabc"}');
  });
});
