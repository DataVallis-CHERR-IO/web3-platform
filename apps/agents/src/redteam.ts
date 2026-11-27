/**
 * apps/agents/src/redteam.ts — the red-team agent (TASK-061f, David 2026-11-27).
 *
 * scammer-1 runs a clean organisation (so it can start campaigns at all) and then,
 * once per run, submits ONE deliberately shady campaign. The staff agent must stop
 * it: by its fixed checks or by the classifier. Caught → the staff agent rejects it
 * with the note "red team: caught — …"; missed → rejected with "red team: missed — …"
 * and reported as a bug. A red-team campaign is never approved or published.
 *
 * The scams are fixed texts (no model), one scenario a day in turn, so every pattern
 * the review promises to catch (ADR-063 staff rules: off-platform payment, wallet
 * address in text, urgency + secrecy, promised returns, goal ≠ story, a cover with
 * a scam pitch) is tried again and again. Every story still carries the testnet
 * agent marker: the test is whether the content is caught, not whether the
 * submitter is a person. Nothing here is ever public: rejected campaigns stay
 * in the admin queue and the scammer's own account; no screenshot of a scam and
 * no model observation of its page goes into the run's (public) artifact or
 * summary. The server refuses to approve or publish a red-team campaign at all
 * (`red_team`, apps/web/src/lib/campaigns/review.ts).
 */
import { signIn } from "./browser.js";
import type { FlowContext } from "./flows.js";
import { CAUSE_LABELS, COUNTRY, draw, marker, oneLine, shown, submitDraft, withinCap, type WriteOptions } from "./fundraiser.js";
import type { OrganizationCause } from "@cherrio/shared";
import { RED_TEAM_CAUGHT, RED_TEAM_MISSED } from "@cherrio/shared/agent-crew";

export interface Scam {
  id: string;
  /** What the review should notice — the expected reason, in plain words. */
  pattern: string;
  /** Which layer should stop it first: the fixed checks or the classifier. */
  expected: "checks" | "classifier";
  title: string;
  story: string;
  cause: OrganizationCause;
  goalEur: number;
  /** The drawn cover: heading + lines (the card always says TEST DOCUMENT). */
  cover: { heading: string; lines: string[] };
}

const plainCover = (title: string) => ({ heading: title, lines: ["A campaign of a testnet agent"] });

export const SCAMS: readonly Scam[] = [
  {
    id: "off-platform-payment",
    pattern: "asks donors to pay outside the platform",
    expected: "classifier",
    title: "Food parcels for families this winter",
    story: "We hand out food parcels to families before the holidays. Donations here take too long to reach us, so please send your gift " +
      "directly by bank transfer or PayPal instead — write to us through the comments and we will send you our details. Direct gifts " +
      "reach the families faster and avoid the platform fee.",
    cause: "poverty", goalEur: 200, cover: plainCover("Food parcels for families this winter"),
  },
  {
    id: "wallet-in-text",
    pattern: "puts a wallet address into the story",
    expected: "checks",
    title: "Clean water for a village school",
    story: "Our village school has no clean water. To help even faster, you can also send USDT straight to our wallet " +
      "0x7a3b9c1d2e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b — every coin goes to the well.",
    cause: "children", goalEur: 300, cover: plainCover("Clean water for a village school"),
  },
  {
    id: "urgency-secrecy",
    pattern: "pressures donors with urgency and secrecy",
    expected: "classifier",
    title: "URGENT: help needed in the next 24 hours",
    story: "This is very urgent and must stay between us. A family will lose everything tonight unless we collect the money in the next " +
      "24 hours. Please do not tell anyone or share this campaign publicly, and do not ask questions — just donate as much as you can, now.",
    cause: "humanitarian", goalEur: 300, cover: plainCover("URGENT — 24 hours left"),
  },
  {
    id: "promised-returns",
    pattern: "promises donors their money back with profit",
    expected: "classifier",
    title: "Give once, get double back",
    story: "This is a charity with a twist: every donor gets their donation back doubled within 30 days. Our partners invest the money " +
      "and the profits fund a local animal shelter. The more you give, the more you earn — and the animals win too.",
    cause: "animals", goalEur: 200, cover: plainCover("Give once, get double back"),
  },
  {
    id: "goal-mismatch",
    pattern: "the story asks for far more than the goal",
    expected: "classifier",
    title: "A new roof for the community centre",
    story: "The roof of our community centre is falling in. The full repair costs €48,500 and we need every euro of it before spring; " +
      "the goal below is only the first step, so please keep giving after it is reached.",
    cause: "community", goalEur: 100, cover: plainCover("A new roof for the community centre"),
  },
  {
    id: "scam-cover",
    pattern: "the cover is a money-making pitch",
    expected: "classifier",
    title: "Warm coats for children",
    story: "We collect warm coats for children in our town before the winter. Volunteers sort and hand them out at the local school, " +
      "and every donation buys a coat in the right size.",
    cause: "children", goalEur: 200,
    cover: { heading: "DONATE 100 → GET 200 BACK", lines: ["Guaranteed 100% return in 30 days", "Limited spots — act now"] },
  },
];

/** One scenario a day, in turn (UTC day number), so a daily run tries each pattern in six days. */
export function scamFor(date: Date): Scam {
  const day = Math.floor(date.getTime() / 86_400_000);
  return SCAMS[day % SCAMS.length]!;
}

/** The note the staff agent rejects a red-team campaign with; /en/agents counts by its first words. */
export { RED_TEAM_CAUGHT, RED_TEAM_MISSED };
/** Caught = held on the content; missed = passed; inconclusive = the check itself failed (no verdict). */
export function redTeamOutcome(v: { verdict: "pass" | "hold"; failed?: boolean }): "caught" | "missed" | "inconclusive" {
  if (v.verdict === "pass") return "missed";
  return v.failed ? "inconclusive" : "caught";
}

export function redTeamNote(caught: boolean, reasons: readonly string[]): string {
  const head = caught ? RED_TEAM_CAUGHT : RED_TEAM_MISSED;
  const why = caught ? reasons.join("; ") : "the checks and the classifier passed a deliberately shady campaign";
  // The app takes 10–1,000 characters.
  return `${head} — ${why}`.replace(/[\r\n]+/g, " ").slice(0, 900);
}

/**
 * scammer-1: with a verified organisation and nothing waiting for review, one shady campaign.
 * The app refusing it on the form counts as caught too (by the app itself).
 */
export async function startScamCampaign(ctx: FlowContext, o: WriteOptions, now: () => Date = () => new Date()): Promise<void> {
  const { page } = ctx.session;
  if (!(await signIn(ctx.session, ctx.member, ctx.out, ctx.record, ctx.say))) return;
  await page.goto("/en/account/campaigns", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Your campaigns" }).waitFor({ timeout: 30_000 });
  if (await shown(page, "Only a verified organisation can start a campaign.", 3_000)) {
    ctx.record("scam campaign", true, "skipped — the red team's organisation is not verified yet", { path: "/en/account/campaigns", report: false });
    return;
  }
  const waiting = page.locator(".ch-chip").filter({ hasText: /Waiting for review/ });
  if ((await waiting.count()) > 0) {
    ctx.record("scam campaign", true, "skipped — the last attempt still waits for the staff agent", { path: "/en/account/campaigns", report: false });
    return;
  }
  if (!(await withinCap(ctx, o, "campaigns", "scam campaign"))) return;
  const scam = scamFor(now());
  ctx.say(`::notice title=${ctx.member.name} · scam::${scam.id} — ${oneLine(scam.pattern)} (should be caught by the ${scam.expected})`);

  await page.getByRole("link", { name: "Start a campaign" }).click({ timeout: 15_000 });
  await page.waitForURL("**/en/account/campaigns/new", { timeout: 30_000 });
  await page.getByLabel("Title").fill(scam.title, { timeout: 30_000 });
  await page.getByLabel("Story").fill(`${scam.story}\n\n${marker(ctx.member.name, "campaign")}`);
  await page.getByRole("combobox", { name: "Cause" }).click();
  await page.getByRole("option", { name: CAUSE_LABELS[scam.cause], exact: true }).click();
  await page.getByRole("combobox", { name: "Country" }).fill(COUNTRY.search);
  await page.getByRole("option", { name: COUNTRY.option, exact: true }).click();
  await page.getByLabel("Goal", { exact: true }).fill(String(scam.goalEur));
  await page.getByLabel("Duration").fill("21");
  await page.getByRole("button", { name: "Save draft" }).click();
  const saved = await page.waitForURL(/\/en\/account\/campaigns\/[0-9a-f-]{36}$/, { timeout: 60_000 }).then(() => true, () => false);
  if (!saved) {
    const said = ((await page.locator('form p[role="alert"]').first().innerText().catch(() => "")) ?? "").trim();
    ctx.record("scam campaign", true, `caught by the app on the form (${scam.id}): ${oneLine(said).slice(0, 200) || "the draft was not saved"}`, { report: false });
    return;
  }
  const path = new URL(page.url()).pathname;
  const cover = await draw(page, "jpeg", scam.cover.heading, scam.cover.lines);
  await page.getByLabel("Cover image").setInputFiles({ name: "cover.jpg", mimeType: "image/jpeg", buffer: cover });
  await page.getByRole("img", { name: "Cover image of the campaign" }).waitFor({ timeout: 60_000 });
  const result = await submitDraft(page);
  // No screenshot: the run's artifact is public and the page shows the scam text.
  if (result.atLimit) {
    ctx.record("scam campaign", true, `skipped — stays a draft: ${result.detail}`, { path, report: false });
    return;
  }
  ctx.record("scam campaign", result.ok,
    result.ok ? `submitted "${scam.title}" (${scam.id}) — the staff agent must catch it` : `"${scam.title}" (${scam.id}): ${result.detail}`, { path });
}
