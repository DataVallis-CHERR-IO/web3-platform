/**
 * apps/agents/src/fundraiser.ts — the fundraiser persona (TASK-061e, part 1).
 *
 *   start-organisation: register an organisation with KYB files, see it waiting for review
 *   start-campaign:     with a verified organisation, save a draft, add a cover, submit it
 *
 * Fixed Playwright steps. The task's model (explore tier) only writes the
 * texts, as data: the answer is parsed into a fixed shape and checked
 * (`checkText`); anything off — no key, budget, bad JSON, a link, an address,
 * a number that looks like an account or phone — uses the fixed text instead.
 * Every text says it was made by a testnet agent; the organisation and its
 * campaigns are marked demo by the app (TASK-061c), so they never look real.
 *
 * Load limits (ADR-063 budget): one application or one campaign in flight
 * per fundraiser — nothing new while one is waiting for review or is a draft —
 * plus the run's caps (organisations 1, campaigns 3). The KYB files and the
 * cover are drawn by the browser itself (page.pdf / screenshot): no new
 * dependency, and each file says "TEST DOCUMENT".
 */
import type { Page } from "playwright";
import { ORGANIZATION_CAUSES, type OrganizationCause } from "@cherrio/shared";
import { shot, signIn } from "./browser.js";
import type { FlowContext } from "./flows.js";
import { ask, firstJson, type Budget } from "./llm.js";
import { BudgetExceeded } from "./budget.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** English labels of the causes on both forms (`organizations.form.causeNames`). */
export const CAUSE_LABELS: Record<OrganizationCause, string> = {
  humanitarian: "Humanitarian aid",
  medical: "Health and medical care",
  disasters: "Disaster relief",
  animals: "Animals",
  climate: "Climate and nature",
  children: "Children and youth",
  education: "Education",
  poverty: "Poverty and hunger",
  community: "Local community",
};

export const COUNTRY = { search: "Sloven", option: "Slovenia" } as const;

export interface OrgText { name: string; description: string; cause: OrganizationCause }
export interface CampaignText { title: string; story: string; cause: OrganizationCause }

/** Links, e-mail, wallet or long numbers (account, phone) never go into a submission. */
const FORBIDDEN = /https?:\/\/|www\.|\S+@\S+\.\S+|0x[0-9a-f]{6,}|\d[\d\s-]{6,}\d/i;

export const marker = (agent: string, what: "organisation" | "campaign") =>
  `Created by the CHERR.IO testnet agent ${agent}. This is not a real ${what}.`;

/** Checks one model text against its length range; null when it does not fit. */
export function checkText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\r\n/g, "\n").replace(/[^\S\n]+/g, " ").trim();
  if (text.length < min || text.length > max) return null;
  if (FORBIDDEN.test(text)) return null;
  return text;
}

const isCause = (v: unknown): v is OrganizationCause => typeof v === "string" && (ORGANIZATION_CAUSES as readonly string[]).includes(v);

/** The agent's suffix and the marker are added here, so the model cannot leave them out. */
export function orgText(raw: unknown, agent: string): OrgText | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const name = checkText(r.name, 4, 60);
  const description = checkText(r.description, 40, 500);
  if (!name || !description || !isCause(r.cause)) return null;
  return { name: `${name} (testnet)`, description: `${description}\n\n${marker(agent, "organisation")}`, cause: r.cause };
}

export function campaignText(raw: unknown, agent: string): CampaignText | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const title = checkText(r.title, 10, 90);
  const story = checkText(r.story, 120, 1500);
  if (!title || !story || !isCause(r.cause)) return null;
  return { title, story: `${story}\n\n${marker(agent, "campaign")}`, cause: r.cause };
}

export const fallbackOrg = (agent: string): OrgText => ({
  name: `Riverside Animal Shelter ${agent} (testnet)`,
  description: `A small volunteer shelter that takes in abandoned dogs and cats, treats them and finds them a home.\n\n${marker(agent, "organisation")}`,
  cause: "animals",
});

export const fallbackCampaign = (agent: string): CampaignText => ({
  title: "Warm kennels for the winter",
  story:
    "Our shelter houses about thirty dogs in outdoor kennels. Before the first frost we want to insulate the kennels " +
    "and buy straw and blankets.\n\nEvery donation goes into materials; volunteers do the work.\n\n" + marker(agent, "campaign"),
  cause: "animals",
});

const ORG_SYSTEM = `You invent a small, fictional charity for a test network of a donation platform.
Answer with ONLY a JSON object: {"name": "...", "description": "...", "cause": "..."}.
- name: 4 to 50 characters, an ordinary charity name; not a real organisation, person or brand;
- description: 60 to 400 characters of plain English about what it does;
- cause: one of ${ORGANIZATION_CAUSES.join(", ")};
- no links, e-mail addresses, phone or account numbers, wallet addresses.`;

const CAMPAIGN_SYSTEM = `You write one fundraising campaign for a small fictional charity on a test network of a donation platform.
Answer with ONLY a JSON object: {"title": "...", "story": "...", "cause": "..."}.
- title: 15 to 80 characters, says what the money is for;
- story: 200 to 1200 characters of plain English, two or three paragraphs separated by an empty line; a modest goal of a few hundred euros;
- cause: one of ${ORGANIZATION_CAUSES.join(", ")};
- no real people, brands or places that identify someone; no links, e-mail addresses, phone or account numbers, wallet addresses; no urgency or secrecy.`;

export interface WriteOptions { model: string | null; apiKey?: string; budget: Budget; fetch?: Fetch }

/** Texts from the task's model, or the fixed text with the reason. */
export async function writeOrg(agent: string, o: WriteOptions): Promise<{ text: OrgText; source: string }> {
  return write(o, ORG_SYSTEM, `Invent the charity for agent ${agent}.`, (raw) => orgText(raw, agent), () => fallbackOrg(agent));
}

export async function writeCampaign(agent: string, o: WriteOptions): Promise<{ text: CampaignText; source: string }> {
  return write(o, CAMPAIGN_SYSTEM, `Write the campaign for agent ${agent}.`, (raw) => campaignText(raw, agent), () => fallbackCampaign(agent));
}

async function write<T>(o: WriteOptions, system: string, user: string, parse: (raw: unknown) => T | null, fallback: () => T) {
  if (!o.model || !o.apiKey) return { text: fallback(), source: "fixed text (no model)" };
  try {
    const answer = await ask({ apiKey: o.apiKey, model: o.model, system, user, maxTokens: 700, budget: o.budget, fetch: o.fetch });
    const text = parse(firstJson(answer.text));
    return text ? { text, source: o.model } : { text: fallback(), source: "fixed text (model answer refused)" };
  } catch (error) {
    // A budget stop is not swallowed: the runner stops the run.
    if (error instanceof BudgetExceeded) throw error;
    return { text: fallback(), source: `fixed text (${error instanceof Error ? error.message.slice(0, 80) : "model failed"})` };
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** A test document drawn by the browser: a PDF (register extract) or PNG/JPEG (authorisation, cover). */
export async function draw(page: Page, kind: "pdf" | "png" | "jpeg", heading: string, lines: string[]): Promise<Buffer> {
  const doc = await page.context().newPage();
  try {
    await doc.setViewportSize({ width: 1200, height: 800 });
    await doc.setContent(
      `<html><body style="margin:0;width:1200px;height:800px;display:flex;flex-direction:column;justify-content:center;` +
        `padding:0 80px;box-sizing:border-box;font-family:sans-serif;background:${kind === "jpeg" ? "#7a1b2a" : "#ffffff"};color:${kind === "jpeg" ? "#ffffff" : "#111111"}">` +
        `<p style="font-size:22px;letter-spacing:2px">TEST DOCUMENT — CHERR.IO TESTNET</p>` +
        `<h1 style="font-size:52px;margin:12px 0">${escapeHtml(heading)}</h1>` +
        lines.map((l) => `<p style="font-size:24px;margin:6px 0">${escapeHtml(l)}</p>`).join("") +
        `</body></html>`
    );
    if (kind === "pdf") return await doc.pdf({ width: "1200px", height: "800px", printBackground: true });
    return await doc.screenshot({ type: kind, ...(kind === "jpeg" ? { quality: 85 } : {}) });
  } finally {
    await doc.close().catch(() => undefined);
  }
}

/** The run's cap on new organisations / campaigns skips this task only; the other personas go on. */
async function withinCap(ctx: FlowContext, o: WriteOptions, meter: "organisations" | "campaigns", step: string): Promise<boolean> {
  try {
    o.budget.spend(meter);
    return true;
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    ctx.record(step, true, `skipped — ${error.message}`, { report: false });
    return false;
  }
}

const shown = (page: Page, text: string | RegExp, timeout = 5_000) =>
  page.getByText(text).first().waitFor({ state: "visible", timeout }).then(() => true, () => false);

/** Fundraiser: one organisation application with KYB files, unless one is already waiting or verified. */
export async function startOrganisation(ctx: FlowContext, o: WriteOptions): Promise<void> {
  const { page } = ctx.session;
  if (!(await signIn(ctx.session, ctx.member, ctx.out, ctx.record, ctx.say))) return;
  await page.goto("/en/account/organization", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Your organisations" }).waitFor({ timeout: 30_000 });
  const existing = page.locator("article").filter({ hasText: /Waiting for review|Verified/ });
  if ((await existing.count()) > 0) {
    const what = (await existing.first().innerText()).split("\n").slice(0, 2).join(" · ");
    ctx.record("start organisation", true, `skipped — already has one: ${what.slice(0, 160)}`, { path: "/en/account/organization" });
    return;
  }
  if (!(await withinCap(ctx, o, "organisations", "start organisation"))) return;
  const { text, source } = await writeOrg(ctx.member.name, o);
  ctx.say(`::notice title=${ctx.member.name} · texts::organisation "${text.name}" from ${source}`);

  await page.getByRole("link", { name: "Register an organisation" }).click({ timeout: 15_000 });
  await page.waitForURL("**/en/organizations/new", { timeout: 30_000 });
  await page.getByLabel("Organisation name").fill(text.name, { timeout: 30_000 });
  await page.getByLabel("Legal name").fill(`${text.name.replace(/ \(testnet\)$/, "")} Association (testnet)`);
  await page.getByRole("combobox", { name: "Country" }).fill(COUNTRY.search);
  await page.getByRole("option", { name: COUNTRY.option, exact: true }).click();
  await page.getByRole("combobox", { name: "Official register" }).click();
  await page.getByRole("option", { name: "Not in any of these registers" }).click();
  await page.getByLabel("Short description").fill(text.description);
  await page.getByLabel(CAUSE_LABELS[text.cause], { exact: true }).check();
  // Payouts go to the fundraiser's own wallet, which sends them back to the treasury.
  await page.getByLabel("Payout address").fill(ctx.member.address);

  const who = [`Organisation: ${text.name}`, `Applicant wallet: ${ctx.member.address}`];
  await page.getByLabel("Extract from the official register (required)")
    .setInputFiles({ name: "register-extract.pdf", mimeType: "application/pdf", buffer: await draw(page, "pdf", "Register extract", who) });
  await page.getByLabel("Proof that you may represent the organisation (required)")
    .setInputFiles({ name: "authorisation.png", mimeType: "image/png", buffer: await draw(page, "png", "Authorisation", who) });
  await page.getByText(/^Uploaded — \d+ KB$/).nth(1).waitFor({ timeout: 60_000 });
  await shot(page, ctx.out, `${ctx.member.name}-03-organisation-form`);

  await page.getByRole("button", { name: "Submit for review" }).click();
  await page.waitForURL("**/en/account/organization", { timeout: 60_000 });
  const waiting = await page.locator("article").filter({ hasText: text.name }).filter({ hasText: "Waiting for review" })
    .waitFor({ timeout: 30_000 }).then(() => true, () => false);
  await shot(page, ctx.out, `${ctx.member.name}-04-organisation-submitted`);
  ctx.record("organisation submitted", waiting, waiting ? `"${text.name}" is waiting for review` : `"${text.name}" not shown as waiting for review`,
    { path: "/en/account/organization" });
}

/** Fundraiser: with a verified organisation and nothing in flight, one campaign draft → cover → submit. */
export async function startCampaign(ctx: FlowContext, o: WriteOptions, random: () => number = Math.random): Promise<void> {
  const { page } = ctx.session;
  if (!(await signIn(ctx.session, ctx.member, ctx.out, ctx.record, ctx.say))) return;
  await page.goto("/en/account/campaigns", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Your campaigns" }).waitFor({ timeout: 30_000 });
  if (await shown(page, "Only a verified organisation can start a campaign.", 3_000)) {
    ctx.record("start campaign", true, "skipped — the organisation is not verified yet (waits for review)", { path: "/en/account/campaigns" });
    return;
  }
  const inFlight = page.locator(".ch-chip").filter({ hasText: /Waiting for review|Draft/ });
  if ((await inFlight.count()) > 0) {
    ctx.record("start campaign", true, `skipped — ${await inFlight.count()} campaign(s) still a draft or waiting for review`, { path: "/en/account/campaigns" });
    return;
  }
  if (!(await withinCap(ctx, o, "campaigns", "start campaign"))) return;
  const { text, source } = await writeCampaign(ctx.member.name, o);
  ctx.say(`::notice title=${ctx.member.name} · texts::campaign "${text.title}" from ${source}`);

  await page.getByRole("link", { name: "Start a campaign" }).click({ timeout: 15_000 });
  await page.waitForURL("**/en/account/campaigns/new", { timeout: 30_000 });
  await page.getByLabel("Title").fill(text.title, { timeout: 30_000 });
  await page.getByLabel("Story").fill(text.story);
  await page.getByRole("combobox", { name: "Cause" }).click();
  await page.getByRole("option", { name: CAUSE_LABELS[text.cause], exact: true }).click();
  await page.getByRole("combobox", { name: "Country" }).fill(COUNTRY.search);
  await page.getByRole("option", { name: COUNTRY.option, exact: true }).click();
  // EUR is preselected (ADR-060). Small goals (100–300) so the crew can reach them.
  const goal = 100 + Math.floor(random() * 3) * 100;
  await page.getByLabel("Goal", { exact: true }).fill(String(goal));
  await page.getByLabel("Duration").fill("21");
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.waitForURL(/\/en\/account\/campaigns\/[0-9a-f-]{36}$/, { timeout: 60_000 });
  const path = new URL(page.url()).pathname;

  await page.getByLabel("Cover image").setInputFiles({
    name: "cover.jpg", mimeType: "image/jpeg",
    buffer: await draw(page, "jpeg", text.title, [`A campaign of a testnet agent (${ctx.member.name})`]),
  });
  await page.getByRole("img", { name: "Cover image of the campaign" }).waitFor({ timeout: 60_000 });
  await shot(page, ctx.out, `${ctx.member.name}-03-campaign-draft`);
  await page.getByRole("button", { name: "Submit for review" }).click();
  const inReview = await shown(page, "Our team is checking your campaign. You cannot change it now.", 30_000);
  await shot(page, ctx.out, `${ctx.member.name}-04-campaign-submitted`);
  ctx.record("campaign submitted", inReview, inReview ? `"${text.title}", goal €${goal}, 21 days — waiting for review` : `"${text.title}" not shown as in review`, { path });
}
