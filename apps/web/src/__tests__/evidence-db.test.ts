import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import * as schema from "@cherrio/db";
import messages from "../../messages/en.json";
import { getDb } from "@/lib/db";
import { GET as listRoute, PUT as noteRoute } from "@/app/api/campaigns/[id]/evidence/route";
import { POST as uploadRoute } from "@/app/api/campaigns/[id]/evidence/files/route";
import { DELETE as removeRoute, GET as downloadRoute } from "@/app/api/campaigns/[id]/evidence/files/[fileId]/route";
import { DELETE as unsealRoute, POST as sealRoute } from "@/app/api/campaigns/[id]/evidence/seal/route";
import { GET as manifestRoute } from "@/app/api/evidence/[bundleId]/manifest/route";
import { DELETE as kybDeleteRoute } from "@/app/api/files/kyb/[id]/route";
import { CAMPAIGN_ERROR_CODES } from "@/lib/campaigns/errors";
import { listPublicEvidence, manifestHash, unsealEvidence } from "@/lib/campaigns/evidence";
import { defaultDeps } from "@/lib/files/storage";
import { sweepPrivateFiles } from "@/lib/files/sweep";
import { mediaRateLimiter } from "@/lib/security/rate-limit";
import { cleanUp, createOrganization, createUser, ORIGIN, PAYOUT_ADDRESS, type TestUser } from "./helpers/organizations";
import { deleteFakeChainRows, ensureFakeChain } from "./helpers/fake-chain";

// TASK-033c / ADR-047: milestone evidence against Postgres, the local S3 and the
// fake chain views — upload (private encrypted / public), note, seal → bundleHash,
// what the chain decides, who may open what, and that KYB housekeeping leaves
// evidence alone.

const { campaigns, evidenceBundles, evidenceFiles, privateFiles, auditLog } = schema;
const RUN = Date.now().toString(36);
const now = () => Math.floor(Date.now() / 1000);
const hex = (n: number) => `0x${randomBytes(n).toString("hex")}`;
const PDF = Buffer.from(`%PDF-1.4\n% invoice ${RUN}\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`);
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

type Result = { status: number; json: Record<string, unknown> | null };
async function read(res: Response): Promise<Result> {
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}
const p = <T,>(v: T) => ({ params: Promise.resolve(v) });
const headers = (u: TestUser) => ({ Origin: ORIGIN, cookie: u.cookie });

async function upload(u: TestUser, id: string, bytes: Buffer, visibility: string) {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], "x.bin"));
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  return read(
    await uploadRoute(
      new Request(`${ORIGIN}/api/campaigns/${id}/evidence/files?visibility=${visibility}`, {
        method: "POST",
        headers: { ...headers(u), "Content-Type": encoded.headers.get("content-type")!, "Content-Length": String(body.length) },
        body,
      }),
      p({ id })
    )
  );
}
const list = async (u: TestUser, id: string) =>
  read(await listRoute(new Request(`${ORIGIN}/api/campaigns/${id}/evidence`, { headers: { cookie: u.cookie } }), p({ id })));
const note = async (u: TestUser, id: string, text: string) =>
  read(await noteRoute(new Request(`${ORIGIN}/x`, { method: "PUT", headers: { ...headers(u), "Content-Type": "application/json" }, body: JSON.stringify({ note: text }) }), p({ id })));
const seal = async (u: TestUser, id: string) => read(await sealRoute(new Request(`${ORIGIN}/x`, { method: "POST", headers: headers(u) }), p({ id })));
const unseal = async (u: TestUser, id: string) => read(await unsealRoute(new Request(`${ORIGIN}/x`, { method: "DELETE", headers: headers(u) }), p({ id })));
const remove = async (u: TestUser, id: string, fileId: string) =>
  read(await removeRoute(new Request(`${ORIGIN}/x`, { method: "DELETE", headers: headers(u) }), p({ id, fileId })));
const download = (u: TestUser, id: string, fileId: string) =>
  downloadRoute(new Request(`${ORIGIN}/x`, { headers: { cookie: u.cookie } }), p({ id, fileId }));
const manifest = (bundleId: string) => manifestRoute(new Request(`${ORIGIN}/x`), p({ bundleId }));

let owner: TestUser;
let stranger: TestUser;
let orgId: string;
const addresses: string[] = [];
let n = 0;

/** A deployed campaign whose contract is in `chain` (default: milestones, payment 1 out). */
async function deployed(chain: Record<string, string | number> = {}) {
  const address = hex(20);
  const [row] = await getDb()
    .insert(campaigns)
    .values({
      orgId, starterUserId: owner.id, beneficiaryType: "ORGANIZATION", title: `Evidence ${RUN} ${++n}`, slug: `evidence-${RUN}-${n}`,
      story: { format: "plain", text: "Story. ".repeat(20) }, cause: "animals", country: "SI", goalAmountMinor: "100000",
      durationDays: 30, status: "DEPLOYED", beneficiaryAddress: PAYOUT_ADDRESS.toLowerCase(), onchainAddress: address,
    })
    .returning({ id: campaigns.id });
  addresses.push(address);
  const cols: Record<string, string | number> = { state: "PAYING", payout_mode: 1, tranches_released: 1, total_raised: "1000000000", ...chain };
  const names = Object.keys(cols);
  await getDb().execute(sql`
    insert into chain.campaign (address, offchain_id, beneficiary, beneficiary_type, target, deadline, tx_hash, log_index, block_number, block_time,
      ${sql.raw(names.join(", "))})
    values (${address}, ${hex(32)}, ${PAYOUT_ADDRESS.toLowerCase()}, 0, 1000000000, ${now() - 10}, ${hex(32)}, 0, 1, ${now()},
      ${sql.join(names.map((k) => sql`${cols[k]}`), sql`, `)})
  `);
  return { id: row!.id, address };
}

async function onChain(address: string, round: number, bundleHash: string) {
  await getDb().execute(sql`
    insert into chain.vote_round (campaign, round, bundle_hash, vote_end, yes_votes, no_votes, tx_hash, log_index, block_number, block_time)
    values (${address}, ${round}, ${bundleHash}, ${now() + 3600}, 0, 0, ${hex(32)}, 0, 5, ${now()})
  `);
}
const setState = (address: string, state: string) => getDb().execute(sql`update chain.campaign set state = ${state} where address = ${address}`);

describe("milestone evidence (Postgres + S3 + fake chain)", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("evidence tests need DATABASE_URL");
    process.env.APP_ENV = "local";
    process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    process.env.PRIVATE_FILES_KEY = "Y2hlcnJpby1sb2NhbC1kZXYta2V5LW5vdC1zZWNyZXQ="; // the public fake key from .env.example
    await defaultDeps().store.check(); // S3 must be there — never skip
    await ensureFakeChain(getDb());
    owner = await createUser();
    stranger = await createUser();
    orgId = (await createOrganization(owner)).id;
  }, 60_000);

  beforeEach(() => mediaRateLimiter.reset());

  afterAll(async () => {
    const db = getDb();
    for (const a of addresses) await deleteFakeChainRows(db, a);
    await cleanUp();
  });

  it("every error code has a message", () => {
    const errors = (messages as { campaigns: { errors: Record<string, string> } }).campaigns.errors;
    for (const code of CAMPAIGN_ERROR_CODES) expect(errors[code], code).toBeTruthy();
  });

  it("the full draft → seal → chain flow, with private and public files", async () => {
    const c = await deployed();

    // Somebody else's campaign does not exist for them.
    expect((await list(stranger, c.id)).status).toBe(404);
    expect(await upload(stranger, c.id, PDF, "private")).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect((await upload(owner, c.id, PDF, "secret")).status).toBe(400);

    // A private PDF: encrypted in storage, plaintext only through the owner's download.
    const priv = await upload(owner, c.id, PDF, "private");
    expect(priv).toMatchObject({ status: 201, json: { round: 0, visibility: "PRIVATE", sha256: sha(PDF), mimeType: "application/pdf" } });
    const [pf] = await getDb()
      .select()
      .from(privateFiles)
      .innerJoin(evidenceFiles, eq(evidenceFiles.privateFileId, privateFiles.id))
      .where(eq(evidenceFiles.id, String(priv.json!.id)));
    expect(pf!.private_files).toMatchObject({ kind: "EVIDENCE", sha256: sha(PDF), uploadedBy: owner.id });
    expect(pf!.private_files.storageKey).toBe(`evidence/${c.id}/${pf!.private_files.id}`);
    const raw = await defaultDeps().store.get(pf!.private_files.storageKey);
    expect(raw!.includes(PDF.subarray(0, 12))).toBe(false); // not stored in the clear

    const res = await download(owner, c.id, String(priv.json!.id));
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(PDF)).toBe(true);
    expect((await download(stranger, c.id, String(priv.json!.id))).status).toBe(404);
    const audits = await getDb().select().from(auditLog).where(and(eq(auditLog.entityId, String(priv.json!.id)), eq(auditLog.action, "private_file.download")));
    expect(audits).toHaveLength(1);
    // The KYB delete route cannot touch an evidence file, even for its uploader.
    const kyb = await kybDeleteRoute(new Request(`${ORIGIN}/x`, { method: "DELETE", headers: headers(owner) }), p({ id: pf!.private_files.id }));
    expect(kyb.status).toBe(404);

    // A public image: re-encoded to WebP (no metadata); the hash is of the stored bytes.
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#aa3366" } }).withMetadata().jpeg().toBuffer();
    const pub = await upload(owner, c.id, jpeg, "public");
    expect(pub).toMatchObject({ status: 201, json: { visibility: "PUBLIC", mimeType: "image/webp" } });
    const view = await list(owner, c.id);
    expect(view.json).toMatchObject({ openRound: 0, unsealAfterSeconds: 600 });
    const bundle = (view.json!.bundles as { id: string; files: { url: string | null; sha256: string; visibility: string }[] }[])[0]!;
    expect(bundle.files.map((f) => f.visibility)).toEqual(["PRIVATE", "PUBLIC"]);
    expect(bundle.files[0]!.url).toBeNull();
    const stored = Buffer.from(await (await fetch(bundle.files[1]!.url!)).arrayBuffer());
    expect(sha(stored)).toBe(bundle.files[1]!.sha256);
    expect(stored.subarray(8, 12).toString()).toBe("WEBP");

    expect(await upload(owner, c.id, PDF, "private")).toMatchObject({ status: 409, json: { error: "evidence_duplicate" } });

    // Note, then seal: the hash is the manifest's SHA-256, and sealing again changes nothing.
    expect((await note(owner, c.id, "x".repeat(2001))).status).toBe(400);
    expect((await note(owner, c.id, "  Vet bills for March.  ")).status).toBe(204);
    const sealed = await seal(owner, c.id);
    expect(sealed.status).toBe(200);
    const m = String(sealed.json!.manifest);
    expect(sealed.json!.bundleHash).toBe(manifestHash(m));
    expect(JSON.parse(m)).toMatchObject({ schema: "cherrio.evidence/1", chainId: 31337, campaign: c.address, round: 0, note: "Vet bills for March." });
    expect(JSON.parse(m).files).toHaveLength(2);
    expect((await seal(owner, c.id)).json).toEqual(sealed.json);

    // Sealed: no changes; reopening waits 10 minutes (a transaction may be pending).
    expect(await upload(owner, c.id, Buffer.from(`%PDF-1.4 other ${RUN}`), "private")).toMatchObject({ status: 409, json: { error: "evidence_sealed" } });
    expect(await remove(owner, c.id, String(pub.json!.id))).toMatchObject({ status: 409, json: { error: "evidence_sealed" } });
    expect(await unseal(owner, c.id)).toMatchObject({ status: 409, json: { error: "evidence_unseal_wait" } });
    await unsealEvidence(getDb(), owner.id, c.id, undefined, new Date(Date.now() + 601_000));
    expect((await remove(owner, c.id, String(pub.json!.id))).status).toBe(204);
    expect(await remove(owner, c.id, String(pub.json!.id))).toMatchObject({ status: 404, json: { error: "evidence_file_not_found" } });
    const resealed = await seal(owner, c.id);
    expect(resealed.json!.bundleHash).not.toBe(sealed.json!.bundleHash);

    // Before the chain has it, nothing is public.
    const bundleId = bundle.id;
    expect((await manifest(bundleId)).status).toBe(404);
    expect(await listPublicEvidence(getDb(), c.id, c.address)).toEqual([]);

    // The beneficiary submitted it: the chain round carries exactly this hash.
    await onChain(c.address, 0, String(resealed.json!.bundleHash));
    const mres = await manifest(bundleId);
    expect(mres.status).toBe(200);
    const text = await mres.text();
    expect(text).toBe(resealed.json!.manifest);
    expect(manifestHash(text)).toBe(resealed.json!.bundleHash);
    const pubView = await listPublicEvidence(getDb(), c.id, c.address.toUpperCase().replace("0X", "0x"));
    expect(pubView).toHaveLength(1);
    expect(pubView[0]).toMatchObject({ round: 0, note: "Vet bills for March.", onChain: true });
    expect(pubView[0]!.files).toHaveLength(1);

    // On chain is final, even while the indexer still says PAYING.
    expect(await note(owner, c.id, "changed")).toMatchObject({ status: 409, json: { error: "evidence_on_chain" } });
    expect(await unseal(owner, c.id)).toMatchObject({ status: 409, json: { error: "evidence_on_chain" } });
    expect((await list(owner, c.id)).json!.openRound).toBeNull();
    await setState(c.address, "VOTING");
    expect(await note(owner, c.id, "changed")).toMatchObject({ status: 409, json: { error: "evidence_not_open" } });
  });

  it("a different hash on chain: the stored bundle is not shown as the evidence", async () => {
    const c = await deployed({ tranches_released: 2 });
    expect((await upload(owner, c.id, PDF, "private")).json).toMatchObject({ round: 1 });
    const s = await seal(owner, c.id);
    await onChain(c.address, 1, hex(32));
    expect(await listPublicEvidence(getDb(), c.id, c.address)).toEqual([]);
    const own = (await list(owner, c.id)).json!.bundles as { onChain: boolean; bundleHash: string }[];
    expect(own[0]).toMatchObject({ bundleHash: s.json!.bundleHash, onChain: false });
  });

  it("nothing to prove: single payout, no payment yet, or all payments made", async () => {
    const cases: Record<string, string | number>[] = [{ payout_mode: 0 }, { state: "SUCCEEDED", tranches_released: 0 }, { state: "COMPLETED", tranches_released: 3 }];
    for (const chain of cases) {
      const c = await deployed(chain);
      expect(await upload(owner, c.id, PDF, "private"), JSON.stringify(chain)).toMatchObject({ status: 409, json: { error: "evidence_not_open" } });
      expect(await seal(owner, c.id)).toMatchObject({ status: 409, json: { error: "evidence_not_open" } });
    }
    // A refused upload leaves no object behind.
    const left = await getDb().select().from(privateFiles).where(eq(privateFiles.uploadedBy, owner.id));
    expect(left.every((f) => f.kind === "EVIDENCE")).toBe(true);
  });

  it("an empty draft cannot be sealed, and the file limit holds", async () => {
    const c = await deployed();
    expect((await note(owner, c.id, "only words")).status).toBe(204);
    expect(await seal(owner, c.id)).toMatchObject({ status: 409, json: { error: "evidence_empty" } });
    for (let i = 0; i < 10; i++) expect((await upload(owner, c.id, Buffer.from(`%PDF-1.4 ${RUN} ${i}`), "private")).status).toBe(201);
    expect(await upload(owner, c.id, Buffer.from(`%PDF-1.4 ${RUN} 11`), "private")).toMatchObject({ status: 409, json: { error: "too_many_files" } });
    const [b] = await getDb().select().from(evidenceBundles).where(eq(evidenceBundles.campaignId, c.id));
    expect(await getDb().select().from(evidenceFiles).where(eq(evidenceFiles.bundleId, b!.id))).toHaveLength(10);
  });

  it("KYB housekeeping leaves evidence files alone (sweep of unattached files)", async () => {
    await getDb()
      .update(privateFiles)
      .set({ createdAt: new Date(Date.now() - 3 * 24 * 3600 * 1000) })
      .where(and(eq(privateFiles.uploadedBy, owner.id), eq(privateFiles.kind, "EVIDENCE")));
    const result = await sweepPrivateFiles({ db: getDb(), deps: defaultDeps(), dryRun: true });
    const own = await getDb().select({ k: privateFiles.storageKey }).from(privateFiles).where(eq(privateFiles.uploadedBy, owner.id));
    expect(own.length).toBeGreaterThan(0);
    for (const { k } of own) expect(result.staleFiles).not.toContain(k);
  });
});
