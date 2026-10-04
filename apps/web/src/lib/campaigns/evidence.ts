import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { auditLog, evidenceBundles, evidenceFiles, newId, privateFiles, type Database } from "@cherrio/db";
import { FileRejectedError, MAX_FILE_BYTES } from "@/lib/files/file-type";
import { getPrivateFile, putPrivateFile, removeStoredObject } from "@/lib/files/storage";
import { isAllowedImage, processCoverImage } from "@/lib/media/image";
import { publicMediaUrl, putPublicImage, putPublicPdf, removePublicObject } from "@/lib/media/public-store";
import { loadOwnCampaign } from "./drafts";
import { loadLifecycle, type CampaignLifecycle } from "./lifecycle";
import { isPdf } from "./media";
import { isMissingRelation } from "./publish";

// Milestone evidence (TASK-033c, ADR-047). After a milestone payment the
// beneficiary proves how the money was used before donors vote on the next one:
//   files (private: encrypted, ADR-033; public: the public bucket, ADR-037)
//   + a public note → a canonical manifest → SHA-256 = `bundleHash`
//   → `Campaign.submitEvidence(bundleHash)`, signed by the beneficiary wallet.
// The manifest lists only hashes, sizes, types and the note, so it can be
// public; anyone can re-hash it and compare it with the on-chain event.
// Private files are opened only by the organisation's admins and platform admins.

export const EVIDENCE_LIMITS = { files: 10, noteChars: 2000, fileBytes: MAX_FILE_BYTES } as const;
/** A sealed bundle can be reopened only after this long without a vote round on chain (a pending transaction gets mined first). */
export const UNSEAL_AFTER_SECONDS = 600;

export type EvidenceRefusal =
  | "evidence_not_open" // no milestone payment is waiting for evidence
  | "evidence_sealed" // sealed: reopen it first
  | "evidence_on_chain" // already submitted: final
  | "evidence_empty"
  | "evidence_unseal_wait"
  | "evidence_duplicate"
  | "too_many_files"
  | "evidence_file_not_found";

export class EvidenceRefusedError extends Error {
  constructor(public readonly code: EvidenceRefusal) {
    super(code);
    this.name = "EvidenceRefusedError";
  }
}
const refuse = (code: EvidenceRefusal): never => {
  throw new EvidenceRefusedError(code);
};

// ── Manifest (pure) ──────────────────────────────────────────────────────────

export type Visibility = "PRIVATE" | "PUBLIC";

export interface ManifestFile {
  sha256: string;
  size: number;
  type: string;
  visibility: Visibility;
}

export interface ManifestInput {
  chainId: number;
  campaign: string;
  round: number;
  note: string;
  files: ManifestFile[];
}

/**
 * The canonical manifest text: fixed key order, no whitespace, files sorted by
 * hash. Anyone holding the files and the note can rebuild it byte for byte.
 */
export function buildManifest(input: ManifestInput): string {
  const files = [...input.files]
    .sort((a, b) => (a.sha256 === b.sha256 ? a.visibility.localeCompare(b.visibility) : a.sha256 < b.sha256 ? -1 : 1))
    .map((f) => ({ sha256: f.sha256, size: f.size, type: f.type, visibility: f.visibility.toLowerCase() }));
  return JSON.stringify({
    schema: "cherrio.evidence/1",
    chainId: input.chainId,
    campaign: input.campaign.toLowerCase(),
    round: input.round,
    note: input.note,
    files,
  });
}

/** `bundleHash`: SHA-256 of the manifest's UTF-8 bytes, as bytes32 hex. */
export function manifestHash(manifest: string): `0x${string}` {
  return `0x${createHash("sha256").update(manifest, "utf8").digest("hex")}`;
}

/** The round the beneficiary can submit evidence for now, or null (PAYING after payment 1 or 2, milestones only). */
export function openRound(lc: CampaignLifecycle): number | null {
  if (lc.state !== "PAYING" || lc.payoutMode !== 1) return null;
  return lc.tranchesReleased === 1 || lc.tranchesReleased === 2 ? lc.tranchesReleased - 1 : null;
}

// ── Database ─────────────────────────────────────────────────────────────────

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Row = Record<string, unknown>;

/** The bundle hash of a round on chain (lowercase hex), or null. */
async function chainRoundHash(db: Database | Tx, campaign: string, round: number): Promise<string | null> {
  try {
    const [r] = (await db.execute(sql`
      select lower(bundle_hash) as h from chain.vote_round where lower(campaign) = ${campaign.toLowerCase()} and round = ${round}
    `)) as unknown as Row[];
    return r ? String(r.h) : null;
  } catch (e) {
    if (!isMissingRelation(e)) throw e;
    return null;
  }
}

/** The fundraiser's campaign with its contract state; refused unless deployed and indexed. */
async function ownDeployed(db: Database, userId: string, campaignId: string) {
  const campaign = await loadOwnCampaign(db, userId, campaignId);
  if (campaign.status !== "DEPLOYED" || !campaign.onchainAddress) return refuse("evidence_not_open");
  const lc = await loadLifecycle(db, campaign.onchainAddress);
  if (!lc) return refuse("evidence_not_open");
  return { campaign, lc, address: campaign.onchainAddress.toLowerCase() };
}

/**
 * The draft bundle of the open round, created on first use, locked for this
 * transaction. Refused when no round is open, or the round is already on chain.
 */
async function openBundle(tx: Tx, campaignId: string, address: string, round: number | null, userId: string, allowSealed = false) {
  if (round === null) return refuse("evidence_not_open");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`evidence:${campaignId}`}))`);
  if (await chainRoundHash(tx, address, round)) refuse("evidence_on_chain");
  await tx.insert(evidenceBundles).values({ campaignId, round, createdBy: userId }).onConflictDoNothing();
  const [bundle] = await tx
    .select()
    .from(evidenceBundles)
    .where(and(eq(evidenceBundles.campaignId, campaignId), eq(evidenceBundles.round, round)));
  if (bundle!.manifest !== null && !allowSealed) refuse("evidence_sealed");
  return bundle!;
}

async function audit(db: Database | Tx, userId: string, campaignId: string, action: string, data: Record<string, unknown>, ip?: string) {
  await db.insert(auditLog).values({ actorUserId: userId, action, entityType: "campaign", entityId: campaignId, data, ip });
}

/** Stores the file (encrypted or public) and returns what the row needs; the object is removed again on refusal. */
async function storeFile(campaignId: string, bytes: Buffer, visibility: Visibility) {
  if (visibility === "PRIVATE") {
    const fileId = newId();
    const storageKey = `evidence/${campaignId}/${fileId}`;
    const stored = await putPrivateFile({ storageKey, bytes });
    return {
      sha256: stored.sha256, size: stored.sizeBytes, type: stored.mimeType,
      privateFile: { id: fileId, storageKey, keyVersion: stored.keyVersion },
      undo: () => removeStoredObject(storageKey),
    };
  }
  if (bytes.length === 0) throw new FileRejectedError("file_empty");
  if (bytes.length > EVIDENCE_LIMITS.fileBytes) throw new FileRejectedError("file_too_large");
  let body: Buffer;
  let type: string;
  let key: string;
  if (isPdf(bytes)) {
    body = bytes; // stored unchanged, like campaign PDFs (ADR-039)
    type = "application/pdf";
    key = `campaigns/${campaignId}/e-${randomBytes(12).toString("hex")}.pdf`;
    await putPublicPdf(key, body);
  } else if (isAllowedImage(bytes)) {
    body = await processCoverImage(bytes); // re-encoded without metadata (ADR-037)
    type = "image/webp";
    key = `campaigns/${campaignId}/e-${randomBytes(12).toString("hex")}.webp`;
    await putPublicImage(key, body);
  } else {
    throw new FileRejectedError("file_type_not_allowed");
  }
  return {
    sha256: createHash("sha256").update(body).digest("hex"), size: body.length, type, publicKey: key,
    undo: () => removePublicObject(key),
  };
}

/** Adds one file to the open round's draft bundle. */
export async function addEvidenceFile(
  db: Database, userId: string, campaignId: string, bytes: Buffer, visibility: Visibility, ip?: string
) {
  const { lc, address } = await ownDeployed(db, userId, campaignId);
  const round = openRound(lc);
  if (round === null) refuse("evidence_not_open");
  const stored = await storeFile(campaignId, bytes, visibility);
  try {
    return await db.transaction(async (tx) => {
      const bundle = await openBundle(tx, campaignId, address, round, userId);
      const files = await tx.select({ sha256: evidenceFiles.sha256 }).from(evidenceFiles).where(eq(evidenceFiles.bundleId, bundle.id));
      if (files.length >= EVIDENCE_LIMITS.files) refuse("too_many_files");
      if (files.some((f) => f.sha256 === stored.sha256)) refuse("evidence_duplicate");
      if (stored.privateFile) {
        await tx.insert(privateFiles).values({
          id: stored.privateFile.id, storageKey: stored.privateFile.storageKey, kind: "EVIDENCE", mimeType: stored.type,
          sizeBytes: stored.size, sha256: stored.sha256, keyVersion: stored.privateFile.keyVersion, uploadedBy: userId,
        });
      }
      const [row] = await tx
        .insert(evidenceFiles)
        .values({
          bundleId: bundle.id, visibility,
          privateFileId: stored.privateFile?.id ?? null,
          publicKey: stored.publicKey ?? null,
          mimeType: stored.type, sizeBytes: stored.size, sha256: stored.sha256, createdBy: userId,
        })
        .returning({ id: evidenceFiles.id });
      await audit(tx, userId, campaignId, "campaign.evidence_add", { round, fileId: row!.id, visibility }, ip);
      return { id: row!.id, round, visibility, sha256: stored.sha256, sizeBytes: stored.size, mimeType: stored.type };
    });
  } catch (error) {
    await stored.undo(); // no row refers to it
    throw error;
  }
}

/** Removes one file of the open, unsealed draft. */
export async function removeEvidenceFile(db: Database, userId: string, campaignId: string, fileId: string, ip?: string) {
  const { lc, address } = await ownDeployed(db, userId, campaignId);
  const removed = await db.transaction(async (tx) => {
    const bundle = await openBundle(tx, campaignId, address, openRound(lc), userId);
    const [row] = await tx
      .delete(evidenceFiles)
      .where(and(eq(evidenceFiles.id, fileId), eq(evidenceFiles.bundleId, bundle.id)))
      .returning({ privateFileId: evidenceFiles.privateFileId, publicKey: evidenceFiles.publicKey, visibility: evidenceFiles.visibility });
    if (!row) return refuse("evidence_file_not_found");
    let storageKey: string | null = null;
    if (row.privateFileId) {
      const [pf] = await tx
        .update(privateFiles)
        .set({ deletedAt: new Date() })
        .where(and(eq(privateFiles.id, row.privateFileId), isNull(privateFiles.deletedAt)))
        .returning({ storageKey: privateFiles.storageKey });
      storageKey = pf?.storageKey ?? null;
    }
    await audit(tx, userId, campaignId, "campaign.evidence_remove", { round: bundle.round, fileId, visibility: row.visibility }, ip);
    return { storageKey, publicKey: row.publicKey };
  });
  if (removed.storageKey) await removeStoredObject(removed.storageKey);
  if (removed.publicKey) await removePublicObject(removed.publicKey);
}

/** Sets the public note of the open, unsealed draft. */
export async function setEvidenceNote(db: Database, userId: string, campaignId: string, note: string, ip?: string) {
  const { lc, address } = await ownDeployed(db, userId, campaignId);
  await db.transaction(async (tx) => {
    const bundle = await openBundle(tx, campaignId, address, openRound(lc), userId);
    await tx.update(evidenceBundles).set({ note }).where(eq(evidenceBundles.id, bundle.id));
    await audit(tx, userId, campaignId, "campaign.evidence_note", { round: bundle.round }, ip);
  });
}

/**
 * Freezes the draft into its manifest and returns the hash to submit on chain.
 * Calling it again returns the same seal.
 */
export async function sealEvidence(db: Database, userId: string, campaignId: string, chainId: number, ip?: string) {
  const { lc, address } = await ownDeployed(db, userId, campaignId);
  return db.transaction(async (tx) => {
    const bundle = await openBundle(tx, campaignId, address, openRound(lc), userId, true);
    if (bundle.manifest !== null) {
      return { round: bundle.round, bundleHash: `0x${bundle.bundleHash!.toString("hex")}` as `0x${string}`, manifest: bundle.manifest };
    }
    const files = await tx
      .select({ sha256: evidenceFiles.sha256, size: evidenceFiles.sizeBytes, type: evidenceFiles.mimeType, visibility: evidenceFiles.visibility })
      .from(evidenceFiles)
      .where(eq(evidenceFiles.bundleId, bundle.id));
    if (files.length === 0) refuse("evidence_empty");
    const manifest = buildManifest({ chainId, campaign: address, round: bundle.round, note: bundle.note, files });
    const bundleHash = manifestHash(manifest);
    await tx
      .update(evidenceBundles)
      .set({ manifest, bundleHash: Buffer.from(bundleHash.slice(2), "hex"), sealedAt: new Date() })
      .where(eq(evidenceBundles.id, bundle.id));
    await audit(tx, userId, campaignId, "campaign.evidence_seal", { round: bundle.round, bundleHash }, ip);
    return { round: bundle.round, bundleHash, manifest };
  });
}

/** Reopens a sealed draft for changes — only when nothing reached the chain for a while. */
export async function unsealEvidence(db: Database, userId: string, campaignId: string, ip?: string, now = new Date()) {
  const { lc, address } = await ownDeployed(db, userId, campaignId);
  await db.transaction(async (tx) => {
    const bundle = await openBundle(tx, campaignId, address, openRound(lc), userId, true);
    if (bundle.sealedAt === null) return;
    if (now.getTime() - bundle.sealedAt.getTime() < UNSEAL_AFTER_SECONDS * 1000) refuse("evidence_unseal_wait");
    await tx.update(evidenceBundles).set({ manifest: null, bundleHash: null, sealedAt: null }).where(eq(evidenceBundles.id, bundle.id));
    await audit(tx, userId, campaignId, "campaign.evidence_unseal", { round: bundle.round }, ip);
  });
}

export interface EvidenceFileView {
  id: string;
  visibility: Visibility;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  /** Public files only. */
  url: string | null;
}

export interface EvidenceBundleView {
  id: string;
  round: number;
  note: string;
  bundleHash: string | null;
  sealedAt: string | null;
  /** The chain has a vote round for this bundle's round with exactly this hash. */
  onChain: boolean;
  files: EvidenceFileView[];
}

async function bundlesOf(db: Database, campaignId: string, address: string | null): Promise<EvidenceBundleView[]> {
  const bundles = await db.select().from(evidenceBundles).where(eq(evidenceBundles.campaignId, campaignId)).orderBy(asc(evidenceBundles.round));
  const out: EvidenceBundleView[] = [];
  for (const b of bundles) {
    const files = await db
      .select()
      .from(evidenceFiles)
      .where(eq(evidenceFiles.bundleId, b.id))
      .orderBy(asc(evidenceFiles.createdAt), asc(evidenceFiles.id));
    const hash = b.bundleHash ? `0x${b.bundleHash.toString("hex")}` : null;
    const chainHash = address ? await chainRoundHash(db, address, b.round) : null;
    out.push({
      id: b.id,
      round: b.round,
      note: b.note,
      bundleHash: hash,
      sealedAt: b.sealedAt?.toISOString() ?? null,
      onChain: hash !== null && chainHash === hash,
      files: files.map((f) => ({
        id: f.id, visibility: f.visibility, mimeType: f.mimeType, sizeBytes: f.sizeBytes, sha256: f.sha256,
        url: f.publicKey ? publicMediaUrl(f.publicKey) : null,
      })),
    });
  }
  return out;
}

/** Everything the fundraiser's dashboard shows: every bundle (drafts too) and the round open now. */
export async function listOwnEvidence(db: Database, userId: string, campaignId: string) {
  const campaign = await loadOwnCampaign(db, userId, campaignId);
  const address = campaign.onchainAddress?.toLowerCase() ?? null;
  const lc = address ? await loadLifecycle(db, address) : null;
  const round = lc ? openRound(lc) : null;
  return {
    openRound: round !== null && !(address && (await chainRoundHash(db, address, round))) ? round : null,
    bundles: await bundlesOf(db, campaignId, address),
    unsealAfterSeconds: UNSEAL_AFTER_SECONDS,
  };
}

/** The public view: only bundles whose hash is on chain (drafts and their notes stay private). */
export async function listPublicEvidence(db: Database, campaignId: string, address: string) {
  return (await bundlesOf(db, campaignId, address.toLowerCase())).filter((b) => b.onChain);
}

/** The manifest text of a bundle that is on chain, else null. */
export async function publicManifest(db: Database, bundleId: string): Promise<string | null> {
  const [row] = (await db.execute(sql`
    select b.manifest, b.round, c.onchain_address from app.evidence_bundles b join app.campaigns c on c.id = b.campaign_id
    where b.id = ${bundleId} and b.manifest is not null
  `)) as unknown as Row[];
  if (!row || !row.onchain_address) return null;
  const manifest = String(row.manifest);
  return (await chainRoundHash(db, String(row.onchain_address), Number(row.round))) === manifestHash(manifest) ? manifest : null;
}

/** A private evidence file for the organisation's admin (decrypted), audited. null when not theirs or gone. */
export async function openPrivateEvidenceFile(db: Database, userId: string, campaignId: string, fileId: string, ip?: string) {
  await loadOwnCampaign(db, userId, campaignId);
  const [row] = await db
    .select({ storageKey: privateFiles.storageKey, mimeType: privateFiles.mimeType })
    .from(evidenceFiles)
    .innerJoin(evidenceBundles, eq(evidenceBundles.id, evidenceFiles.bundleId))
    .innerJoin(privateFiles, eq(privateFiles.id, evidenceFiles.privateFileId))
    .where(and(eq(evidenceFiles.id, fileId), eq(evidenceBundles.campaignId, campaignId), isNull(privateFiles.deletedAt)));
  if (!row) return null;
  const bytes = await getPrivateFile(row.storageKey);
  if (!bytes) return null;
  await db.insert(auditLog).values({
    actorUserId: userId, action: "private_file.download", entityType: "evidence_file", entityId: fileId, data: { kind: "EVIDENCE" }, ip,
  });
  return { bytes, mimeType: row.mimeType };
}
