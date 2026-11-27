/**
 * apps/agents/src/evidence.ts — a fundraiser submits milestone evidence (TASK-061g, part A).
 *
 * A campaign in MILESTONES mode that has released payment 1 or 2 (PAYING) waits for
 * the fundraiser's proof of use before donors vote on the next payment. The page is
 * /en/account/campaigns/<id>#evidence (EvidenceManager). Fixed Playwright steps, no
 * model: a fixed note, one drawn "TEST DOCUMENT" receipt, "Seal and submit to the
 * blockchain" (the beneficiary wallet — the fundraiser's own — signs
 * `submitEvidence(hash)`; policy.ts already allows it), then the page's confirmation
 * text and GET /api/lifecycle/:address must show the campaign in VOTING.
 *
 * Load limit: at most one submission per run. The pure helpers need no browser.
 */
import type { Page } from "playwright";
import { shot, signIn } from "./browser.js";
import type { FlowContext } from "./flows.js";
import { draw, oneLine, shown } from "./fundraiser.js";

const STEP = "evidence";

/** Shape of GET /api/campaigns/:id/evidence that matters here (`listOwnEvidence`). */
export interface EvidenceData {
  openRound: number | null;
  bundles: { round: number; note?: string; bundleHash: string | null; sealedAt?: string | null; onChain: boolean }[];
}

export interface EvidenceTarget { id: string; round: number; /** "payment {n} of 3" */ payment: number; sealed: boolean }

/** The fixed note: public on the campaign page, so it says plainly that nothing was spent. */
export const evidenceNote = (payment: number, agent: string) =>
  `Testnet: proof of use for payment ${payment} — test documents, not real spending. Created by the CHERR.IO testnet agent ${agent}.`;

/** The round to submit now, or null: the panel is open and that round is not on chain yet. */
export function openEvidence(id: string, data: EvidenceData): EvidenceTarget | null {
  const round = data.openRound;
  if (round === null || !Number.isInteger(round) || round < 0 || round > 1) return null;
  const mine = data.bundles.find((b) => b.round === round);
  if (mine?.onChain) return null;
  // The UI counts payments from 2 for round 0 (`round + 2`).
  return { id, round, payment: round + 2, sealed: Boolean(mine?.bundleHash) };
}

/** First campaign with an open panel (at most one per run). */
export function pickEvidenceTarget(items: readonly { id: string; data: EvidenceData }[]): EvidenceTarget | null {
  for (const item of items) {
    const target = openEvidence(item.id, item.data);
    if (target) return target;
  }
  return null;
}

/** Campaign page links of the account list: /en/account/campaigns/<uuid>, in order, without duplicates. */
export function campaignIds(hrefs: readonly string[]): string[] {
  const ids = hrefs.flatMap((h) => /\/account\/campaigns\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i.exec(h)?.[1] ?? []);
  return [...new Set(ids.map((i) => i.toLowerCase()))];
}

/** The contract address the page hands to EvidenceManager (`"campaign":"0x…"` in the page data). */
export function campaignAddressIn(html: string): `0x${string}` | null {
  const m = /\\?"campaign\\?":\s*\\?"(0x[0-9a-fA-F]{40})\\?"/.exec(html);
  return m ? (m[1]!.toLowerCase() as `0x${string}`) : null;
}

/** GET /api/lifecycle/:address → the state, or null. */
export const lifecycleState = (body: unknown): string | null => {
  const s = (body as { lifecycle?: { state?: unknown } } | null)?.lifecycle?.state;
  return typeof s === "string" ? s : null;
};

const CONFIRMED = /Confirmed\. The vote starts as soon as CHERR\.IO sees it/;

async function json(page: Page, path: string): Promise<unknown> {
  const res = await page.request.get(path, { timeout: 30_000 });
  return res.ok() ? res.json() : null;
}

/** Fundraiser: for the first own campaign waiting for evidence, note → one test receipt → seal → submit → voting. */
export async function submitEvidence(ctx: FlowContext): Promise<void> {
  const { page } = ctx.session;
  if (!(await signIn(ctx.session, ctx.member, ctx.out, ctx.record, ctx.say))) return;
  await page.goto("/en/account/campaigns", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Your campaigns" }).waitFor({ timeout: 30_000 });
  const hrefs = await page.locator('a[href*="/account/campaigns/"]').evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
  const items: { id: string; data: EvidenceData }[] = [];
  for (const id of campaignIds(hrefs)) {
    const data = (await json(page, `/api/campaigns/${id}/evidence`)) as EvidenceData | null;
    if (data) items.push({ id, data });
  }
  const target = pickEvidenceTarget(items);
  if (!target) {
    ctx.record(STEP, true, "skipped — no campaign is waiting for evidence", { path: "/en/account/campaigns", report: false });
    return;
  }
  const path = `/en/account/campaigns/${target.id}`;
  await page.goto(`${path}#evidence`, { waitUntil: "domcontentloaded" });
  const panel = page.locator("#evidence");
  await panel.getByRole("heading", { name: `Evidence before payment ${target.payment} of 3` }).waitFor({ timeout: 30_000 });
  const address = campaignAddressIn(await page.content());

  const signedBefore = ctx.session.signed.length;
  if (target.sealed) {
    // An earlier run sealed it but the transaction did not go through: submit what is sealed.
    await panel.getByRole("button", { name: "Submit to the blockchain" }).click({ timeout: 15_000 });
  } else {
    await panel.getByLabel("Note to donors").fill(evidenceNote(target.payment, ctx.member.name), { timeout: 15_000 });
    await panel.getByRole("button", { name: "Save the note" }).click();
    await shown(page, "Note saved.", 15_000);
    const receipt = await draw(page, "pdf", "Receipt (test)", [
      `Proof of use for payment ${target.payment} of 3`, `Agent: ${ctx.member.name}`, "Not real spending.",
    ]);
    await panel.getByLabel("Add a file").setInputFiles({ name: "receipt.pdf", mimeType: "application/pdf", buffer: receipt });
    await panel.getByText(/^(Private|Public)$/).first().waitFor({ timeout: 60_000 });
    await shot(page, ctx.out, `${ctx.member.name}-05-evidence-draft`);
    await panel.getByRole("button", { name: "Seal and submit to the blockchain" }).click({ timeout: 15_000 });
  }
  const confirmed = await shown(page, CONFIRMED, 240_000);
  await shot(page, ctx.out, `${ctx.member.name}-06-evidence-submitted`);
  const hashes = ctx.session.signed.slice(signedBefore).map((e) => e.hash!).filter(Boolean);
  if (!confirmed) {
    const said = await page.locator('#evidence [role="alert"]').first().innerText().catch(() => "");
    ctx.record(STEP, false, `payment ${target.payment}: no confirmation${said ? `; the page says "${oneLine(said).slice(0, 160)}"` : ""}`, { path, txHashes: hashes });
    return;
  }
  // The indexer needs about a minute to see the vote start.
  let state: string | null = null;
  for (let i = 0; i < 24 && state !== "VOTING"; i++) {
    if (i > 0) await page.waitForTimeout(5_000);
    if (address) state = lifecycleState(await json(page, `/api/lifecycle/${address}`));
    else {
      const data = (await json(page, `/api/campaigns/${target.id}/evidence`)) as EvidenceData | null;
      state = data?.bundles.some((b) => b.round === target.round && b.onChain) ? "VOTING" : null;
    }
  }
  ctx.record(STEP, state === "VOTING",
    state === "VOTING" ? `evidence for payment ${target.payment} submitted; the campaign is in VOTING${address ? "" : " (checked by the evidence API: no address on the page)"}`
      : `evidence for payment ${target.payment} confirmed on chain, but the campaign is ${state ?? "not found"}, not VOTING`,
    { path, txHashes: hashes });
}
