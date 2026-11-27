/**
 * apps/agents/src/lifecycle.ts — agents drive the public campaign life-cycle
 * panel (TASK-061g).
 *
 * Crew campaigns only (never a person's): after the deadline an agent presses
 * the panel's own buttons — finish, pay out, vote, count the votes, refund,
 * send to the Emergency Pool — exactly as a donor would. The decision
 * (`nextLifecycleAction`) is pure and tested; the Playwright driver
 * (`lifecycleStep`) only clicks the button the decision names. The signer
 * policy already allows these Campaign calls for every crew wallet.
 */
import type { CrewMember } from "./crew.js";
import { TESTNET_ORIGIN } from "./guard.js";
import { shot, signIn, type AgentSession } from "./browser.js";
import { onTestnet, type FlowContext } from "./flows.js";

/** At most this many life-cycle transactions per agent in one run. */
export const MAX_LIFECYCLE_ACTIONS_PER_RUN = 3;

/** States (public API names) in which the panel can have something to do. */
export const LIFECYCLE_STATES = ["ending", "succeeded", "voting", "failed", "rejected"] as const;

export interface LifecycleCampaign {
  /** Campaign id of the public API (needed by the rating API); optional so older fixtures stay valid. */
  id?: string;
  title: string; slug: string; url: string; contract: `0x${string}`; state: string | null; demo: boolean;
  organization: { name: string };
}

/** A crew campaign: demo flag on and an organisation named "… (testnet)". A person's campaign never matches. */
export function isCrewLifecycleCampaign(c: { demo?: boolean; organization?: { name?: string } }): boolean {
  return c.demo === true && typeof c.organization?.name === "string" && c.organization.name.endsWith(" (testnet)");
}

/** Crew campaigns past "live" that may have something due, from the public API (paged, ending first). */
export async function crewCampaignsForLifecycle(
  fetchImpl: typeof fetch = fetch, maxPages = 10, states: readonly string[] = LIFECYCLE_STATES
): Promise<LifecycleCampaign[]> {
  const found: LifecycleCampaign[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchImpl(`${TESTNET_ORIGIN}/api/v1/campaigns?sort=ending&page=${page}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`/api/v1/campaigns answered ${res.status}`);
    const body = (await res.json()) as { data: LifecycleCampaign[]; pageCount?: number };
    for (const c of body.data) {
      if (isCrewLifecycleCampaign(c) && c.contract && onTestnet(c.url) && states.includes(c.state ?? "")) found.push(c);
    }
    if (page >= (body.pageCount ?? 1)) break;
  }
  return found;
}

/** The parts of GET /api/lifecycle/:campaign this module reads (bigints are decimal strings). */
export interface LifecycleJson {
  lifecycle: {
    state: string;
    round: { round: number } | null;
    due: { finalize: boolean; closeVote: boolean; release: boolean };
  };
  positions: Array<{
    address: string;
    donated: string;
    preference: string;
    settled: boolean;
    vote: { approve: boolean; weight: string } | null;
    action: { kind: string; amount?: string };
  }> | null;
}

export type LifecycleActionKind = "finalize" | "release" | "close-vote" | "vote-approve" | "refund" | "settle-to-pool" | "none";
export interface LifecycleAction { kind: LifecycleActionKind; reason: string }

/** Accessible name of the panel button for each action (messages/en.json, lifecycle.*). */
export const BUTTON_NAME: Record<Exclude<LifecycleActionKind, "none">, RegExp> = {
  finalize: /^Finish the campaign$/,
  release: /^Pay out$/,
  "close-vote": /^Count the votes$/,
  "vote-approve": /^Approve payment \d+$/,
  refund: /^Get your money back \(/,
  "settle-to-pool": /^Send .+ USDC to the Emergency Pool$/,
};

/**
 * What this member should press next. Own position first (vote — always
 * approve, the evidence is crew-made — refund, or pool when the preference
 * says pool), then the buttons anyone may press.
 */
export function nextLifecycleAction(json: LifecycleJson, member: Pick<CrewMember, "address">): LifecycleAction {
  const { lifecycle: lc } = json;
  const own = (json.positions ?? []).find((p) => p.address.toLowerCase() === member.address.toLowerCase());
  if (own && BigInt(own.donated) > 0n && !own.settled) {
    if (lc.state === "VOTING" && own.vote === null && own.action.kind === "vote") {
      return { kind: "vote-approve", reason: "donor with an open vote this round" };
    }
    if ((lc.state === "FAILED" || lc.state === "REJECTED") && own.action.kind === "pool") {
      return { kind: "settle-to-pool", reason: `preference ${own.preference}: ${own.action.amount ?? "?"} to the pool` };
    }
    if ((lc.state === "FAILED" || lc.state === "REJECTED") && own.action.kind === "refund") {
      return { kind: "refund", reason: `preference ${own.preference}: ${own.action.amount ?? "?"} back` };
    }
  }
  if (lc.due.finalize) return { kind: "finalize", reason: "deadline passed, still LIVE" };
  if (lc.due.closeVote) return { kind: "close-vote", reason: "vote end passed" };
  if (lc.due.release) return { kind: "release", reason: "payout is due" };
  return { kind: "none", reason: `nothing due in state ${lc.state}` };
}

const used = new Map<string, number>();
/** Actions this agent has sent so far in this process (one run). */
export const lifecycleActionsUsed = (member: Pick<CrewMember, "name">) => used.get(member.name) ?? 0;
export const resetLifecycleCounts = () => used.clear();

const signedIn = new WeakSet<AgentSession>();

/** Signs the member in once per browser session (shared with the rating step); false when it failed. */
export async function ensureSignedIn(ctx: FlowContext): Promise<boolean> {
  if (signedIn.has(ctx.session)) return true;
  if (!(await signIn(ctx.session, ctx.member, ctx.out, ctx.record, ctx.say))) return false;
  signedIn.add(ctx.session);
  return true;
}

/**
 * "Anyone" actions already pressed this run (contract:kind): finish, pay out and count the votes need
 * one press, not one per agent — when the indexer lags, the next agent would press it again (review).
 */
const attempted = new Set<string>();
const ANYONE: ReadonlySet<LifecycleActionKind> = new Set(["finalize", "release", "close-vote"]);
export const resetLifecycleAttempts = () => attempted.clear();
/** The panel's answer when the action was done meanwhile (en.json lifecycle.errors.already_done). */
const ALREADY_DONE = /Someone already did this/;

async function fetchLifecycle(ctx: FlowContext, campaign: LifecycleCampaign): Promise<LifecycleJson> {
  const res = await ctx.session.context.request.get(`${TESTNET_ORIGIN}/api/lifecycle/${campaign.contract}`, { timeout: 20_000 });
  if (!res.ok()) throw new Error(`/api/lifecycle answered ${res.status()}`);
  return (await res.json()) as LifecycleJson;
}

const fingerprint = (j: LifecycleJson) => JSON.stringify([j.lifecycle.state, j.lifecycle.round, j.positions]);

/**
 * One life-cycle action on a crew campaign, through the page's panel. Returns
 * the action that was sent ("none" when nothing was due or the cap is used).
 */
export async function lifecycleStep(ctx: FlowContext, campaign: LifecycleCampaign): Promise<LifecycleAction> {
  const path = new URL(campaign.url).pathname;
  if (!isCrewLifecycleCampaign(campaign)) {
    ctx.record("lifecycle", false, `"${campaign.title}" is not a crew campaign: not touched`, { path });
    return { kind: "none", reason: "not a crew campaign" };
  }
  if (lifecycleActionsUsed(ctx.member) >= MAX_LIFECYCLE_ACTIONS_PER_RUN) {
    return { kind: "none", reason: `cap of ${MAX_LIFECYCLE_ACTIONS_PER_RUN} actions per run reached` };
  }
  const { page } = ctx.session;
  if (!(await ensureSignedIn(ctx))) return { kind: "none", reason: "sign in failed" };
  const before = await fetchLifecycle(ctx, campaign);
  const action = nextLifecycleAction(before, ctx.member);
  if (action.kind === "none") return action;
  const key = `${campaign.contract.toLowerCase()}:${action.kind}`;
  if (ANYONE.has(action.kind)) {
    if (attempted.has(key)) return { kind: "none", reason: `${action.kind} already pressed this run` };
    attempted.add(key);
  }

  await page.goto(campaign.url, { waitUntil: "domcontentloaded" });
  const panel = page.locator("#lifecycle");
  await panel.scrollIntoViewIfNeeded({ timeout: 30_000 });
  const button = panel.getByRole("button", { name: BUTTON_NAME[action.kind] }).first();
  await button.waitFor({ state: "visible", timeout: 30_000 });
  await shot(page, ctx.out, `${ctx.member.name}-05-lifecycle-${action.kind}`);
  const signedBefore = ctx.session.signed.length;
  used.set(ctx.member.name, lifecycleActionsUsed(ctx.member) + 1);
  await button.click();
  try {
    await panel.getByText(/Sent\. Waiting for the network to confirm it/).waitFor({ timeout: 180_000 });
    await panel.getByText(/Confirmed\. This panel updates within about a minute/).waitFor({ timeout: 180_000 });
  } catch (error) {
    const alert = await panel.getByRole("alert").first().textContent({ timeout: 2_000 }).catch(() => null);
    if (alert && ALREADY_DONE.test(alert)) {
      // Done meanwhile (another agent, a person, or indexer lag): nothing to report.
      ctx.record("lifecycle", true, `${action.kind} "${campaign.title}": already done`, { path, report: false });
      return { kind: "none", reason: "already done" };
    }
    ctx.record("lifecycle", false, `${action.kind} "${campaign.title}": not confirmed${alert ? ` (panel says: ${alert.trim().slice(0, 120)})` : ""}`, { path });
    if (!alert) throw error;
    return action;
  }
  await shot(page, ctx.out, `${ctx.member.name}-06-lifecycle-confirmed`);
  const hashes = ctx.session.signed.slice(signedBefore).map((e) => e.hash!).filter(Boolean);
  ctx.record("lifecycle", true, `${action.kind} "${campaign.title}": confirmed`, { path, txHashes: hashes });

  // The indexer sees it within about a minute: the state, round or positions must move.
  const until = Date.now() + 3 * 60_000;
  let moved = false;
  while (!moved && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 15_000));
    moved = fingerprint(await fetchLifecycle(ctx, campaign)) !== fingerprint(before);
  }
  ctx.record("lifecycle indexed", moved, moved ? `${action.kind} "${campaign.title}": API state moved from ${before.lifecycle.state}` : `${action.kind} "${campaign.title}": API still shows ${before.lifecycle.state} after 3 min`, { path });
  return action;
}
