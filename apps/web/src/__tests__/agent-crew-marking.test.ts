import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { PrivyClient } from "@privy-io/server-auth";
import * as schema from "@cherrio/db";
import { AGENT_CREW } from "@cherrio/shared/agent-crew";
import { getDb } from "@/lib/db";
import { setPrivyClientForTesting } from "@/lib/auth/privy";
import { authRateLimiter } from "@/lib/security/rate-limit";
import { POST as sessionPost } from "@/app/api/auth/session/route";
import { createDraft } from "@/lib/campaigns/drafts";
import { ORIGIN, cleanUp, createImportedOrg, createOrganization, createUser, submit, type TestUser } from "./helpers/organizations";

// TASK-061c (ADR-063): testnet agents are marked at login, their organisations and
// campaigns are demo data, and an agent never claims a real (imported) organisation.
// Real handlers, real Postgres. Only this file uses crew addresses.

const { users, userAddresses, auditLog, campaigns, organizations } = schema;
const RUN = Date.now().toString(36);
const DONOR = AGENT_CREW.find((m) => m.name === "donor-2")!;
const loginUserIds: string[] = [];
const draftIds: string[] = [];

const login = (did: string, addresses: string[]) => {
  setPrivyClientForTesting({
    verifyAuthToken: async () => ({ userId: did }),
    getUser: async () => ({
      id: did,
      linkedAccounts: addresses.map((address) => ({ type: "wallet", address, walletClientType: "metamask" })),
    }),
  } as unknown as PrivyClient);
  authRateLimiter.reset();
  return sessionPost(
    new Request(`${ORIGIN}/api/auth/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ accessToken: "fake-token" }),
    })
  );
};

const userByDid = async (did: string) => {
  const [row] = await getDb().select().from(users).where(eq(users.privyDid, did));
  if (row && !loginUserIds.includes(row.id)) loginUserIds.push(row.id);
  return row;
};

const draft = {
  title: `Agent test kennel ${RUN}`,
  story: "A made-up story for an agent test. ".repeat(5),
  cause: "animals",
  country: "SI",
  goalCurrency: "EUR",
  goal: 150,
  durationDays: 30,
} as const;

async function agentUser(): Promise<TestUser> {
  const u = await createUser();
  await getDb().update(users).set({ isAgent: true }).where(eq(users.id, u.id));
  return u;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("agent crew tests need DATABASE_URL");
  process.env.APP_ENV = "local";
  process.env.SESSION_SECRET ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  // A crew address can only belong to one user: free it from an earlier run of this file.
  await getDb().delete(userAddresses).where(eq(userAddresses.address, DONOR.address));
});

afterAll(async () => {
  const db = getDb();
  if (draftIds.length > 0) await db.delete(campaigns).where(inArray(campaigns.id, draftIds));
  if (loginUserIds.length > 0) {
    await db.delete(userAddresses).where(inArray(userAddresses.userId, loginUserIds));
    await db.delete(auditLog).where(inArray(auditLog.actorUserId, loginUserIds));
    await db.delete(users).where(inArray(users.id, loginUserIds));
  }
  setPrivyClientForTesting(null);
  await cleanUp();
});

describe("login marks the crew (TASK-061c)", () => {
  it("a new user with a crew wallet becomes an agent named after the crew member", async () => {
    const did = `did:privy:agent-${RUN}`;
    expect((await login(did, [DONOR.address.toUpperCase().replace("0X", "0x")])).status).toBe(200);
    const row = await userByDid(did);
    expect(row!.isAgent).toBe(true);
    expect(row!.displayName).toBe("Agent donor-2");
  });

  it("a stranger's wallet is not marked", async () => {
    const did = `did:privy:stranger-${RUN}`;
    expect((await login(did, [`0x${randomBytes(20).toString("hex")}`])).status).toBe(200);
    expect((await userByDid(did))!.isAgent).toBe(false);
  });

  it("an existing user who later links a crew wallet is marked at the next login", async () => {
    const did = `did:privy:later-${RUN}`;
    expect((await login(did, [])).status).toBe(200);
    expect((await userByDid(did))!.isAgent).toBe(false);
    const staff = AGENT_CREW.find((m) => m.name === "awkward-1")!;
    await getDb().delete(userAddresses).where(eq(userAddresses.address, staff.address));
    expect((await login(did, [staff.address])).status).toBe(200);
    const row = await userByDid(did);
    expect(row!.isAgent).toBe(true);
    // The pseudonym chosen at registration stays; only new agent users get "Agent …".
    expect(row!.displayName).not.toBe("Agent awkward-1");
  });

  it("nobody is marked where the crew does not exist (uat/prod)", async () => {
    const { crewMemberFor } = await import("@cherrio/shared/agent-crew");
    expect(crewMemberFor([DONOR.address], "prod")).toBeNull();
    expect(crewMemberFor([DONOR.address], "uat")).toBeNull();
  });
});

describe("agent content is demo data (TASK-061c)", () => {
  it("an agent's new organisation is is_demo; a person's is not", async () => {
    const agent = await agentUser();
    const applied = await submit(agent);
    expect(applied.status).toBe(201);
    const [agentOrg] = await getDb().select().from(organizations).where(eq(organizations.id, applied.organizationId!));
    expect(agentOrg!.isDemo).toBe(true);

    const person = await createUser();
    const real = await submit(person);
    expect(real.status).toBe(201);
    const [realOrg] = await getDb().select().from(organizations).where(eq(organizations.id, real.organizationId!));
    expect(realOrg!.isDemo).toBe(false);
  });

  it("an agent never claims an imported organisation", async () => {
    const agent = await agentUser();
    const imported = await createImportedOrg();
    const res = await submit(agent, { registry: imported.registry, registryId: imported.registryId, country: imported.country });
    expect(res.status).toBe(409);
    expect(res.error).toBe("organization_exists");
    const [after] = await getDb().select().from(organizations).where(eq(organizations.id, imported.id));
    expect([after!.kybStatus, after!.claimedByUserId]).toEqual(["NONE", null]);
  });

  it("a campaign started by an agent is is_demo; a person's campaign is not", async () => {
    const agent = await agentUser();
    const agentOrg = await createOrganization(agent);
    const a = await createDraft(getDb(), agent.id, agentOrg.id, draft);
    draftIds.push(a.id);
    const [agentCampaign] = await getDb().select().from(campaigns).where(eq(campaigns.id, a.id));
    expect(agentCampaign!.isDemo).toBe(true);

    const person = await createUser();
    const personOrg = await createOrganization(person);
    const p = await createDraft(getDb(), person.id, personOrg.id, { ...draft, title: `Person kennel ${RUN}` });
    draftIds.push(p.id);
    const [personCampaign] = await getDb().select().from(campaigns).where(eq(campaigns.id, p.id));
    expect(personCampaign!.isDemo).toBe(false);
  });
});
