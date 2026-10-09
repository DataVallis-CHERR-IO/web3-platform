import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@cherrio/db";
import { getDb } from "@/lib/db";
import { defaultDeps } from "@/lib/files/storage";
import { ORPHAN_PREFIXES, sweepPrivateFiles } from "@/lib/files/sweep";
import { publicObjectStore } from "@/lib/media/public-store";
import { PUBLIC_PREFIX, sweepPublicMedia } from "@/lib/media/sweep";
import { cleanUp, createOrganization, createUser, type TestUser } from "./helpers/organizations";

// TASK-052: `files:sweep` also removes evidence objects without a live row
// (private bucket) and public campaign objects that no row refers to. Both
// buckets are shared with test files running in parallel, so every sweep here
// is limited to this run's own campaign prefix.

const { campaigns, campaignMedia, evidenceBundles, evidenceFiles, privateFiles } = schema;
const RUN = Date.now().toString(36);
const inTwoHours = () => new Date(Date.now() + 2 * 60 * 60 * 1000);
const SHA = "cd".repeat(32);

let owner: TestUser;
let campaignId = "";
let bundleId = "";

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("media sweep tests need DATABASE_URL");
  process.env.APP_ENV = "local";
  process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.PRIVATE_FILES_KEY = "Y2hlcnJpby1sb2NhbC1kZXYta2V5LW5vdC1zZWNyZXQ="; // the public fake key from .env.example
  owner = await createUser();
  const org = await createOrganization(owner);
  const [row] = await getDb()
    .insert(campaigns)
    .values({
      orgId: org.id, starterUserId: owner.id, beneficiaryType: "ORGANIZATION", title: `Sweep ${RUN}`, slug: `sweep-${RUN}`,
      story: { format: "plain", text: "Story. ".repeat(20) }, cause: "animals", country: "SI", goalAmountMinor: "100000",
      durationDays: 30, status: "DRAFT",
    })
    .returning({ id: campaigns.id });
  campaignId = row!.id;
  const [bundle] = await getDb()
    .insert(evidenceBundles)
    .values({ campaignId, round: 0, createdBy: owner.id })
    .returning({ id: evidenceBundles.id });
  bundleId = bundle!.id;
});

afterAll(async () => {
  await cleanUp();
});

describe("files:sweep — public campaign media and evidence objects (Postgres + s3mock)", () => {
  it("public: deletes only objects no row names, older than 1 h; cover, evidence file and sealed key stay", async () => {
    const db = getDb();
    const store = publicObjectStore();
    const prefix = `campaigns/${campaignId}/`;
    const cover = `${prefix}${RUN}-cover.webp`;
    const evidence = `${prefix}e-${RUN}.pdf`;
    const sealed = `${prefix}e-${RUN}-sealed.webp`;
    const orphan = `${prefix}${RUN}-replaced.webp`;
    await db.insert(campaignMedia).values({ campaignId, kind: "COVER", storage: "HETZNER_PUBLIC", cid: cover });
    await db.insert(evidenceFiles).values({
      bundleId, visibility: "PUBLIC", publicKey: evidence, mimeType: "application/pdf", sizeBytes: 40, sha256: SHA, createdBy: owner.id,
    });
    await db.update(evidenceBundles).set({ publicCids: [sealed] }).where(eq(evidenceBundles.id, bundleId));
    for (const key of [cover, evidence, sealed, orphan]) await store.put(key, randomBytes(40));
    const keys = async () => (await store.list(prefix)).map((o) => o.key).sort();

    // Fresh objects are never orphans (an upload stores the object before its row).
    expect((await sweepPublicMedia({ db, store, dryRun: true, prefix })).orphanObjects).toEqual([]);

    const dry = await sweepPublicMedia({ db, store, dryRun: true, prefix, now: inTwoHours() });
    expect(dry.orphanObjects).toEqual([orphan]);
    expect(await keys()).toEqual([cover, evidence, sealed, orphan].sort());

    const real = await sweepPublicMedia({ db, store, dryRun: false, prefix, now: inTwoHours() });
    expect(real).toEqual({ dryRun: false, orphanObjects: [orphan], failedDeletes: 0 });
    expect(await keys()).toEqual([cover, evidence, sealed].sort());

    // Idempotent.
    expect((await sweepPublicMedia({ db, store, dryRun: false, prefix, now: inTwoHours() })).orphanObjects).toEqual([]);

    // A removed cover row makes its object an orphan on the next run.
    await db.delete(campaignMedia).where(eq(campaignMedia.cid, cover));
    expect((await sweepPublicMedia({ db, store, dryRun: false, prefix, now: inTwoHours() })).orphanObjects).toEqual([cover]);
    expect(await keys()).toEqual([evidence, sealed].sort());
    for (const key of [evidence, sealed]) await store.delete(key);
  });

  it("the CLI defaults cover kyb/ and evidence/ (private) and campaigns/ (public)", () => {
    expect([...ORPHAN_PREFIXES].sort()).toEqual(["evidence/", "kyb/"]);
    expect(PUBLIC_PREFIX).toBe("campaigns/");
  });

  it("public: refuses a prefix outside campaigns/", async () => {
    await expect(
      sweepPublicMedia({ db: getDb(), store: publicObjectStore(), dryRun: true, prefix: "" })
    ).rejects.toThrow("sweep prefix must start with campaigns/");
  });

  it("private: an evidence object without a live row is deleted; one with a live row stays", async () => {
    const db = getDb();
    const deps = defaultDeps();
    const prefix = `evidence/${campaignId}/`;
    const liveId = schema.newId();
    const live = `${prefix}${liveId}`;
    const markedDeletedId = schema.newId();
    const markedDeleted = `${prefix}${markedDeletedId}`;
    const noRow = `${prefix}${schema.newId()}`;
    await db.insert(privateFiles).values([
      { id: liveId, storageKey: live, kind: "EVIDENCE", mimeType: "application/pdf", sizeBytes: 40, sha256: SHA, uploadedBy: owner.id },
      {
        id: markedDeletedId, storageKey: markedDeleted, kind: "EVIDENCE", mimeType: "application/pdf", sizeBytes: 40, sha256: SHA,
        uploadedBy: owner.id, deletedAt: new Date(),
      },
    ]);
    for (const key of [live, markedDeleted, noRow]) await deps.store.put(key, randomBytes(40));
    const keys = async () => (await deps.store.list(prefix)).map((o) => o.key).sort();

    const dry = await sweepPrivateFiles({ db, deps, dryRun: true, now: inTwoHours(), orphanPrefixes: [prefix] });
    expect([...dry.orphanObjects].sort()).toEqual([markedDeleted, noRow].sort());
    expect(await keys()).toEqual([live, markedDeleted, noRow].sort());

    const real = await sweepPrivateFiles({ db, deps, dryRun: false, now: inTwoHours(), orphanPrefixes: [prefix] });
    expect(real.failedDeletes).toBe(0);
    expect([...real.orphanObjects].sort()).toEqual([markedDeleted, noRow].sort());
    expect(await keys()).toEqual([live]);
    expect((await db.select().from(privateFiles).where(eq(privateFiles.id, liveId)))[0]!.deletedAt).toBeNull();
    await deps.store.delete(live);
  });
});
