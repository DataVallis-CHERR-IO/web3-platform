/**
 * apps/agents/src/staff-review.ts — the staff agent reviews the crew's organisation
 * applications in the admin UI (TASK-061e part 2, step 2a).
 *
 * Fixed Playwright steps, like a person: sign in → admin gate (authenticator code
 * from AGENT_STAFF_TOTP_SECRET) → Admin → Organisations queue → each application:
 * read the page, download its documents, decide (review.ts), then approve in the
 * dialog with the verdict as the audit note, or leave it and report a hold.
 *
 * Then the same for campaigns (step 2b): Admin → Campaigns → each campaign waiting
 * for review → read the page and its cover → decide → approve with the verdict as
 * the audit note, or hold. Then publishing (step 2c, staff-publish.ts).
 *
 * Only applications whose page says the applicant is a testnet agent (and campaigns
 * with the server-set "Crew agent" row) are opened for a decision; everything else
 * stays in David's queue untouched (the server refuses it too: `agent_scope`).
 * Screenshots only of a crew submission after the decision — never of a queue or a
 * person's page (the run's artifact is public).
 */
import type { Page } from "playwright";
import { shot, signIn } from "./browser.js";
import type { FlowContext } from "./flows.js";
import type { Attachment, Budget } from "./llm.js";
import type { Hold } from "./reports.js";
import { CAUSE_LABELS, COUNTRY } from "./fundraiser.js";
import {
  auditNote, checkCampaign, checkOrganisation, classify, goalAsSet, type CampaignSubmission, type OrgApplication, type Verdict,
} from "./review.js";
import { adminGate, passSecondFactor } from "./staff.js";
import { BudgetExceeded } from "./budget.js";
import { publishQueue } from "./staff-publish.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Decisions per run and per queue; entries opened per run and queue (a person's are skipped without a decision). */
export const MAX_REVIEWS_PER_RUN = 3;
export const MAX_OPENED_PER_RUN = 10;
/** Crew campaigns checked per run (each may cost one classifier call); approvals stay at MAX_REVIEWS_PER_RUN. */
export const MAX_CAMPAIGN_CHECKS_PER_RUN = 6;
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

const AGENT_APPLICANT = "Testnet agent of the CHERR.IO crew (not a real person).";
const FIELD_LABELS = {
  name: "Organisation name", legalName: "Legal name", country: "Country", website: "Website",
  description: "Description", causes: "Causes", payoutAddress: "Payout address",
} as const;

export interface ReviewOptions {
  secret: Buffer | null;
  crewAddresses: readonly string[];
  model: string | null;
  apiKey?: string;
  budget: Budget;
  holds: Hold[];
  fetch?: Fetch;
}

/** The "Submitted" column of the data table, by row label ("—" = empty). */
async function readApplication(page: Page, submissionId: string): Promise<OrgApplication> {
  const table = page.getByRole("region", { name: "Submitted data", exact: true });
  await table.waitFor({ timeout: 30_000 });
  const value = async (label: string) => {
    const row = table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: label, exact: true }) });
    const text = ((await row.getByRole("cell").last().innerText({ timeout: 10_000 })) ?? "").trim();
    return text === "—" ? "" : text;
  };
  const f = Object.fromEntries(
    await Promise.all(Object.entries(FIELD_LABELS).map(async ([k, label]) => [k, await value(label)] as const))
  ) as Record<keyof typeof FIELD_LABELS, string>;
  const links = page.locator('a[href^="/api/admin/files/"]');
  const documents = await Promise.all(
    (await links.all()).map(async (a) => ({
      kind: ((await a.innerText()).split(":").slice(1).join(":")).trim(),
      href: (await a.getAttribute("href")) ?? "",
    }))
  );
  return {
    submissionId, ...f,
    causes: f.causes ? f.causes.split(",").map((c) => c.trim()) : [],
    // Only inside the Applicant section: a person could type the same sentence into a field (review of this PR).
    applicantIsAgent: await page.locator("section")
      .filter({ has: page.getByRole("heading", { name: "Applicant", exact: true }) })
      .getByText(AGENT_APPLICANT, { exact: true }).isVisible(),
    documents,
  };
}

/** Each document as the classifier gets it; an unreadable one throws (→ hold). */
async function downloadDocuments(page: Page, app: OrgApplication): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const d of app.documents) {
    if (!/^\/api\/admin\/files\/[0-9a-f-]{36}$/.test(d.href)) throw new Error(`unexpected document link for ${d.kind}`);
    const res = await page.request.get(d.href, { timeout: 30_000 });
    if (!res.ok()) throw new Error(`${d.kind}: download answered ${res.status()}`);
    const type = (res.headers()["content-type"] ?? "").split(";")[0]!.trim();
    if (type !== "image/png" && type !== "image/jpeg" && type !== "application/pdf") throw new Error(`${d.kind}: type ${type || "unknown"} is not checked`);
    const data = await res.body();
    if (data.length > MAX_DOCUMENT_BYTES) throw new Error(`${d.kind}: larger than 5 MB`);
    out.push({ mediaType: type, data });
  }
  return out;
}

/** Deterministic checks first; the classifier only when they pass. */
export async function decide(app: OrgApplication, documents: () => Promise<Attachment[]>, o: ReviewOptions): Promise<Verdict> {
  const failed = checkOrganisation(app, o.crewAddresses);
  if (failed.length > 0) return { verdict: "hold", reasons: failed };
  let files: Attachment[];
  try {
    files = await documents();
  } catch (error) {
    return { verdict: "hold", reasons: [`documents could not be read (${error instanceof Error ? error.message.slice(0, 120) : "failed"})`] };
  }
  const { submissionId: _id, documents: docs, applicantIsAgent: _agent, ...fields } = app;
  return classify({ type: "organisation application", ...fields, documents: docs.map((d) => d.kind) }, files, o);
}

/** Opens the dialog (re-clicks if the page was not hydrated yet), types the tail and the note, confirms. */
async function approve(page: Page, app: OrgApplication, note: string): Promise<boolean> {
  const tail = page.getByLabel("Last 6 characters of the payout address");
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.getByRole("button", { name: "Approve", exact: true }).click({ timeout: 15_000 });
    if (await tail.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false)) break;
    if (attempt === 3) throw new Error("the approve dialog did not open after three clicks");
  }
  await tail.fill(app.payoutAddress.slice(-6));
  await page.getByLabel("Note for the audit log (optional)").fill(note);
  await page.getByRole("button", { name: "Approve and verify", exact: true }).click();
  // Saved = after a fresh load (what the server has, not what the client shows) the Decision section
  // says "reviewed" AND the status chip says Approved. Scoped to sections: a page-wide match could be a
  // sentence inside the application. Not "no role=alert": Next.js keeps its route announcer
  // (role="alert") on every page — run 45665462416 approved two applications and reported both as unsaved.
  await page.getByText("This application has been reviewed.", { exact: true }).waitFor({ timeout: 30_000 }).catch(() => undefined);
  await page.reload({ waitUntil: "domcontentloaded" });
  const decision = page.locator("section").filter({ has: page.getByRole("heading", { name: "Decision", exact: true }) });
  const saved = await decision.getByText("This application has been reviewed.", { exact: true })
    .waitFor({ timeout: 30_000 }).then(() => true, () => false);
  if (!saved) return false;
  return page.locator(".ch-chip").filter({ hasText: /Approved$/ }).first().isVisible();
}

/** Staff: review the crew's organisation applications, then their campaigns waiting for review, then publish approved ones. */
export async function reviewOrganisations(ctx: FlowContext, o: ReviewOptions): Promise<void> {
  const { page } = ctx.session;
  if (!o.secret) {
    ctx.record("admin sign-in", false, "AGENT_STAFF_TOTP_SECRET is not set for this run", { report: false });
    return;
  }
  if (!(await signIn(ctx.session, ctx.member, ctx.out, ctx.record, ctx.say))) return;
  const gate = await adminGate(page);
  if (gate === "not-admin" || gate === "enrol") {
    ctx.record("admin sign-in", false, gate === "not-admin" ? "/en/admin answers 404: the staff wallet has no PLATFORM_ADMIN role" : "the authenticator is not set up (run enrol-staff)", { path: "/en/admin", report: false });
    return;
  }
  if (gate === "verify") await passSecondFactor(page, o.secret);
  ctx.record("admin sign-in", true, "role + authenticator code accepted", { path: "/en/admin" });
  await reviewQueue(ctx, o);
  await reviewCampaignQueue(ctx, o);
  await publishQueue(ctx);
}

/** After the gate: the queue, one decision per crew application (exported for a local check against `next build`). */
export async function reviewQueue(ctx: Pick<FlowContext, "session" | "member" | "out" | "record">, o: ReviewOptions): Promise<void> {
  const { page } = ctx.session;
  await page.goto("/en/admin/kyb", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Applications waiting for review" }).waitFor({ timeout: 30_000 });
  const hrefs = [...new Set(await page.locator('a[href*="/admin/kyb/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? "")))]
    .filter((h) => /\/admin\/kyb\/[0-9a-f-]{36}$/.test(h)).slice(0, MAX_OPENED_PER_RUN);
  // No screenshot of the queue: it lists real applicants, and the run's artifact is public.
  let decided = 0;
  let others = 0;
  for (const href of hrefs) {
    if (decided >= MAX_REVIEWS_PER_RUN) break;
    await page.goto(href, { waitUntil: "domcontentloaded" });
    const submissionId = href.split("/").pop()!;
    const app = await readApplication(page, submissionId);
    if (!app.applicantIsAgent) {
      others++; // a person's application: David's queue, never touched
      continue;
    }
    decided++;
    const path = `/en/admin/kyb/${submissionId}`;
    const verdict = await decide(app, () => downloadDocuments(page, app), o);
    if (verdict.verdict === "hold") {
      o.holds.push({ kind: "organisation", id: submissionId, name: app.name, path, reasons: verdict.reasons });
      ctx.record("review organisation", true, `held "${app.name}": ${verdict.reasons.join("; ")}`, { path });
      continue;
    }
    const ok = await approve(page, app, auditNote(o.model!, verdict));
    await shot(page, ctx.out, `${ctx.member.name}-04-kyb-decided-${decided}`);
    ctx.record("review organisation", ok, ok ? `approved "${app.name}" (checks + ${o.model}: pass)` : `"${app.name}": approval not shown as saved`, { path });
  }
  ctx.record("organisation queue", true, `${hrefs.length} waiting; ${decided} decided by the agent, ${others} left for a person`, { path: "/en/admin/kyb" });
}

// ── Campaigns (step 2b) ──

const CAMPAIGN_FIELDS = {
  title: "Title", cause: "Cause", country: "Country", goal: "Goal", duration: "Duration",
  payoutAddress: "Payout address (verified organisation)",
} as const;
const CREW_AGENT_ROW = "Crew agent";
const STARTER_AGENT = "Testnet agent of the CHERR.IO crew (not a real person).";
const NO_EXTRA_MEDIA = "No gallery images, videos or documents.";

export const section = (page: Page, heading: string) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: heading, exact: true }) });

const dataTable = (page: Page) => page.getByRole("region", { name: "Campaign data", exact: true });
const tableRow = (page: Page, label: string) =>
  dataTable(page).getByRole("row").filter({ has: page.getByRole("rowheader", { name: label, exact: true }) });
export const cellText = async (page: Page, label: string) =>
  ((await tableRow(page, label).getByRole("cell").last().innerText({ timeout: 10_000 })) ?? "").trim();

/** The server-set "Crew agent" row, read before anything else: a person's campaign is not read at all. */
export async function startedByAgent(page: Page): Promise<boolean> {
  await dataTable(page).waitFor({ timeout: 30_000 });
  return (await tableRow(page, CREW_AGENT_ROW).count()) === 1 && (await cellText(page, CREW_AGENT_ROW)) === STARTER_AGENT;
}

/** The "Campaign data" table, the story, the cover and the media section of one crew campaign. */
async function readCampaign(page: Page, campaignId: string): Promise<CampaignSubmission> {
  const value = (label: string) => cellText(page, label);
  const f = Object.fromEntries(
    await Promise.all(Object.entries(CAMPAIGN_FIELDS).map(async ([k, label]) => [k, await value(label)] as const))
  ) as Record<keyof typeof CAMPAIGN_FIELDS, string>;
  // The row exists only for a crew starter (server-set); read again here for the deterministic checks.
  const starterIsAgent = await startedByAgent(page);
  const cover = section(page, "Cover image").getByRole("img", { name: "Cover image", exact: true });
  const coverUrl = (await cover.count()) === 1 ? ((await cover.getAttribute("src")) ?? "") : "";
  return {
    campaignId, ...f,
    payoutAddress: f.payoutAddress === "—" ? "" : f.payoutAddress,
    story: ((await section(page, "Story").locator("p").first().innerText({ timeout: 10_000 })) ?? "").trim(),
    starterIsAgent,
    coverUrl,
    noExtraMedia: await section(page, "Photos, videos and documents").getByText(NO_EXTRA_MEDIA, { exact: true }).isVisible(),
  };
}

/** The cover as the classifier gets it; an unreadable one throws (→ hold). */
async function downloadCover(page: Page, campaignId: string, url: string): Promise<Attachment[]> {
  // The server names covers campaigns/<this campaign>/<random hex>.webp (api/campaigns/[id]/cover).
  const path = new RegExp(`^https?://[^/]+/(.+/)?campaigns/${campaignId}/[0-9a-z-]+\\.webp$`);
  if (!/^[0-9a-f-]{36}$/.test(campaignId) || !path.test(url)) throw new Error("unexpected cover link");
  const res = await page.request.get(url, { timeout: 30_000, maxRedirects: 0 });
  if (!res.ok()) throw new Error(`cover: download answered ${res.status()}`);
  const type = (res.headers()["content-type"] ?? "").split(";")[0]!.trim();
  if (type !== "image/webp" && type !== "image/png" && type !== "image/jpeg") throw new Error(`cover: type ${type || "unknown"} is not checked`);
  const data = await res.body();
  if (data.length > MAX_DOCUMENT_BYTES) throw new Error("cover: larger than 5 MB");
  return [{ mediaType: type, data }];
}

/** Deterministic checks first; the classifier (texts + cover) only when they pass. */
export async function decideCampaign(c: CampaignSubmission, cover: () => Promise<Attachment[]>, o: ReviewOptions): Promise<Verdict> {
  const failed = checkCampaign(c, o.crewAddresses, { causeLabels: Object.values(CAUSE_LABELS), country: COUNTRY.option });
  if (failed.length > 0) return { verdict: "hold", reasons: failed };
  let files: Attachment[];
  try {
    files = await cover();
  } catch (error) {
    return { verdict: "hold", reasons: [`cover could not be read (${error instanceof Error ? error.message.slice(0, 120) : "failed"})`] };
  }
  return classify(
    // The goal as set ("€100"), not the display conversion ("≈ $109.35 (€100)"), which the model read as a
    // second amount in run 45683594846.
    { type: "campaign", title: c.title, cause: c.cause, country: c.country, goal: goalAsSet(c.goal), duration: c.duration, story: c.story, attachments: "cover image" },
    files, o
  );
}

/** Opens the dialog (re-clicks if not hydrated yet), types the note, confirms; saved = after a reload. */
async function approveCampaign(page: Page, note: string): Promise<boolean> {
  const field = page.getByLabel("Note for the audit log (optional)");
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.getByRole("button", { name: "Approve", exact: true }).click({ timeout: 15_000 });
    if (await field.waitFor({ state: "visible", timeout: 10_000 }).then(() => true, () => false)) break;
    if (attempt === 3) throw new Error("the approve dialog did not open after three clicks");
  }
  await field.fill(note);
  await page.getByRole("button", { name: "Approve with the ECB rate", exact: true }).click();
  await page.getByText("This campaign has been reviewed.", { exact: true }).waitFor({ timeout: 30_000 }).catch(() => undefined);
  await page.reload({ waitUntil: "domcontentloaded" });
  const saved = await section(page, "Decision").getByText("This campaign has been reviewed.", { exact: true })
    .waitFor({ timeout: 30_000 }).then(() => true, () => false);
  if (!saved) return false;
  return page.locator(".ch-chip").filter({ hasText: /Approved$/ }).first().isVisible();
}

/** After the gate: Admin → Campaigns (waiting for review), one decision per crew campaign. */
export async function reviewCampaignQueue(ctx: Pick<FlowContext, "session" | "member" | "out" | "record">, o: ReviewOptions): Promise<void> {
  const { page } = ctx.session;
  await page.goto("/en/admin/campaigns", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Campaigns", exact: true }).waitFor({ timeout: 30_000 });
  const hrefs = [...new Set(await page.locator('a[href*="/admin/campaigns/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? "")))]
    .filter((h) => /\/admin\/campaigns\/[0-9a-f-]{36}$/.test(h)).slice(0, MAX_OPENED_PER_RUN);
  // No screenshot of the queue: it lists real fundraisers, and the run's artifact is public.
  // Approvals and crew campaigns checked are capped apart: held campaigns stay in the queue (oldest first)
  // until David decides them, and must not use up every slot of later runs (review of this PR).
  let approved = 0;
  let checked = 0;
  let held = 0;
  let others = 0;
  for (const href of hrefs) {
    if (approved >= MAX_REVIEWS_PER_RUN || checked >= MAX_CAMPAIGN_CHECKS_PER_RUN) break;
    const campaignId = href.split("/").pop()!;
    const path = `/en/admin/campaigns/${campaignId}`;
    try {
      await page.goto(href, { waitUntil: "domcontentloaded" });
      if (!(await startedByAgent(page))) {
        others++; // a person's campaign: David's queue, never read further
        continue;
      }
      checked++;
      const c = await readCampaign(page, campaignId);
      const verdict = await decideCampaign(c, () => downloadCover(page, campaignId, c.coverUrl), o);
      if (verdict.verdict === "hold") {
        held++;
        o.holds.push({ kind: "campaign", id: campaignId, name: c.title, path, reasons: verdict.reasons });
        ctx.record("review campaign", true, `held "${c.title}": ${verdict.reasons.join("; ")}`, { path });
        continue;
      }
      if ((await page.getByRole("button", { name: "Approve", exact: true }).count()) !== 1) {
        ctx.record("review campaign", false, `"${c.title}": no Approve button (decided meanwhile?)`, { path });
        continue;
      }
      const ok = await approveCampaign(page, auditNote(o.model!, verdict));
      if (ok) approved++;
      await shot(page, ctx.out, `${ctx.member.name}-05-campaign-decided-${checked}`);
      ctx.record("review campaign", ok, ok ? `approved "${c.title}" (checks + ${o.model}: pass)` : `"${c.title}": approval not shown as saved`, { path });
    } catch (error) {
      if (error instanceof BudgetExceeded) throw error;
      // One campaign failing does not end the queue. No screenshot: the page may be a person's.
      ctx.record("review campaign", false, error instanceof Error ? error.message.slice(0, 200) : "failed", { path });
    }
  }
  ctx.record("campaign queue", true, `${hrefs.length} waiting; ${approved} approved and ${held} held by the agent, ${others} left for a person`, { path: "/en/admin/campaigns" });
}
