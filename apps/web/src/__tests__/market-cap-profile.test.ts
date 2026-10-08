import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { TRUST_SCORE_VERSION } from "@cherrio/shared/trust";
import { getDb } from "@/lib/db";
import { getClaimableOrganization, getMarketCapProfile } from "@/lib/market-cap/profile";

// TASK-017c: an organisation's Charity Market Cap profile and the claim prefill.

if (!process.env.DATABASE_URL) throw new Error("profile tests need DATABASE_URL");
const db = getDb();
const { organizations, trustScores, registryRecords, users } = schema;
const RUN = `Prof${Date.now().toString(36)}`;
const orgIds: string[] = [];
let userId = "";

async function org(values: Partial<typeof organizations.$inferInsert>, score?: { listed?: boolean; registered?: boolean }) {
  const [o] = await db
    .insert(organizations)
    .values({ source: "IMPORTED", name: `${RUN} ${orgIds.length}`, country: "GB", registry: "NONE", causes: ["animals"], kybStatus: "NONE", ...values })
    .returning({ id: organizations.id });
  orgIds.push(o!.id);
  if (score) {
    await db.insert(trustScores).values({
      orgId: o!.id, version: TRUST_SCORE_VERSION, score: "36.00", components: { kind: "imported", active: true, website: false },
      listed: score.listed ?? true, registered: score.registered ?? false, country: "GB", causes: ["animals"], raised: "0",
    });
  }
  return o!.id;
}

let imported: string, claimed: string, pending: string, rejected: string, unlisted: string, noScore: string, demo: string;

beforeAll(async () => {
  const [u] = await db.insert(users).values({ displayName: RUN }).returning({ id: users.id });
  userId = u!.id;
  imported = await org({ registry: "UK_CC", registryId: `${RUN}1`, website: "http://old.example", description: "We help." }, {});
  await db.insert(registryRecords).values({ registry: "UK_CC", registryId: `${RUN}1`, raw: { status: "Registered", income: 5000 } });
  claimed = await org({ claimedByUserId: userId, kybStatus: "APPROVED", source: "REGISTERED" }, { registered: true });
  pending = await org({ kybStatus: "PENDING" }, {});
  rejected = await org({ kybStatus: "REJECTED" }, {}); // the claim form only claims NONE
  unlisted = await org({}, { listed: false });
  noScore = await org({});
  demo = await org({ isDemo: true }, {});
});

afterAll(async () => {
  await db.delete(trustScores).where(inArray(trustScores.orgId, orgIds));
  await db.delete(registryRecords).where(inArray(registryRecords.registryId, [`${RUN}1`]));
  await db.delete(organizations).where(inArray(organizations.id, orgIds));
  await db.delete(users).where(inArray(users.id, [userId]));
});

describe("Charity Market Cap profile", () => {
  it("shows a listed organisation with its score parts and register record", async () => {
    const p = (await getMarketCapProfile(db, imported))!;
    expect(p).toMatchObject({ score: "36.00", registered: false, claimable: true, registry: "UK_CC", country: "GB" });
    expect(p.components).toMatchObject({ kind: "imported", active: true });
    expect(p.registryRecord).toMatchObject({ status: "Registered", income: 5000 });
  });

  it("offers the claim only for an unclaimed imported organisation", async () => {
    expect((await getMarketCapProfile(db, claimed))!.claimable).toBe(false);
    expect((await getMarketCapProfile(db, pending))!.claimable).toBe(false);
    expect((await getMarketCapProfile(db, rejected))!.claimable).toBe(false);
  });

  it("is not found when not listed, without a score, a demo, or not an id", async () => {
    expect(await getMarketCapProfile(db, unlisted)).toBeNull();
    expect(await getMarketCapProfile(db, noScore)).toBeNull();
    expect(await getMarketCapProfile(db, demo)).toBeNull();
    expect(await getMarketCapProfile(db, "not-an-id")).toBeNull();
  });

  it("prefills a claim only for a claimable organisation", async () => {
    expect(await getClaimableOrganization(db, imported)).toMatchObject({ registry: "UK_CC", registry_id: `${RUN}1`, country: "GB" });
    expect(await getClaimableOrganization(db, claimed)).toBeNull();
    expect(await getClaimableOrganization(db, pending)).toBeNull();
    expect(await getClaimableOrganization(db, "x")).toBeNull();
  });
});
