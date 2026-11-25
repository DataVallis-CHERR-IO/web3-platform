/**
 * apps/agents/src/flows.ts — what each persona does on the testnet (TASK-061d).
 *
 * Every task is fixed Playwright code; a model is used only afterwards, to
 * write soft observations about the page (observe.ts). A task records its own
 * steps; anything that throws is recorded by the runner as a failed task.
 * Chain checks read the agents' own RPC; checks against the indexer are
 * queued and run at the end (two 120 s cycles), not per task.
 */
import type { Locator } from "playwright";
import { erc20Abi, formatUnits, parseUnits } from "viem";
import { CampaignAbi } from "@cherrio/contracts/abis";
import type { CrewMember } from "./crew.js";
import { TESTNET_ORIGIN } from "./guard.js";
import type { Chain } from "./chain.js";
import { shot, signIn, type AgentSession, type RecordStep } from "./browser.js";

export interface ApiCampaign { title: string; slug: string; url: string; contract: `0x${string}`; state: string | null; deadline: string; raisedUsdc: string | null }

export interface IndexCheck { agent: string; slug: string; contract: `0x${string}` }

export interface FlowContext {
  session: AgentSession;
  member: CrewMember;
  chain: Chain;
  out: string;
  record: RecordStep;
  say: (line: string) => void;
  /** Queued for the end of the run. */
  indexChecks: IndexCheck[];
  random?: () => number;
}

/** Typed into the amount field: in the goal's currency (EUR or USD, ADR-060), so the USDC sent can differ. */
export const DONATION_INPUT = "1";

/** The public API reports states in lower case ("live", "ending", …; `PublicState` in apps/web). */
export async function liveCampaigns(): Promise<ApiCampaign[]> {
  const res = await fetch(`${TESTNET_ORIGIN}/api/v1/campaigns?sort=ending`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`/api/v1/campaigns answered ${res.status}`);
  const body = (await res.json()) as { data: ApiCampaign[] };
  const soon = Date.now() + 2 * 3_600_000;
  return body.data.filter((c) => c.state === "live" && c.contract && onTestnet(c.url) && Date.parse(c.deadline) > soon);
}

/** Every URL the runner opens comes from the testnet's own API; it must stay on the testnet. */
export function onTestnet(url: string): boolean {
  try { return new URL(url).origin === TESTNET_ORIGIN; } catch { return false; }
}

const visible = (l: Locator, timeout = 5_000) =>
  l.waitFor({ state: "visible", timeout }).then(() => true, () => false);

export function pick<T>(items: readonly T[], random: () => number = Math.random): T | null {
  return items.length === 0 ? null : items[Math.floor(random() * items.length)]!;
}

async function donatedBy(chain: Chain, c: ApiCampaign, m: CrewMember) {
  return chain.client.readContract({ address: c.contract, abi: CampaignAbi, functionName: "donated", args: [m.address] }) as Promise<bigint>;
}

/** Reads "You send exactly 1.0963 USDC." — what must leave the wallet. */
async function shownUsdc(ctx: FlowContext): Promise<bigint> {
  const text = await ctx.session.page.getByText(/You send exactly [\d.,]+ USDC/).first().textContent({ timeout: 15_000 });
  const shown = /You send exactly ([\d.,]+) USDC/.exec(text ?? "")?.[1]?.replace(/,/g, "");
  if (!shown) throw new Error("the donate box does not show the USDC amount");
  return parseUnits(shown, 6);
}

/** Donor: sign in, give 1 (goal currency) to a live campaign through the page, check the chain. */
export async function donate(ctx: FlowContext, campaign: ApiCampaign): Promise<void> {
  const { page } = ctx.session;
  if (!(await signIn(ctx.session, ctx.member, ctx.out, ctx.record, ctx.say))) return;
  const before = await donatedBy(ctx.chain, campaign, ctx.member);
  await page.goto(campaign.url, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Amount", { exact: true }).fill(DONATION_INPUT, { timeout: 30_000 });
  const expected = await shownUsdc(ctx);
  await shot(page, ctx.out, `${ctx.member.name}-03-donate-form`);
  const signedBefore = ctx.session.signed.length;
  await page.getByRole("button", { name: "Donate", exact: true }).click();
  await page.getByText(/Thank you! Your donation is recorded/).waitFor({ timeout: 240_000 });
  await shot(page, ctx.out, `${ctx.member.name}-04-donated`);
  const after = await donatedBy(ctx.chain, campaign, ctx.member);
  const hashes = ctx.session.signed.slice(signedBefore).map((e) => e.hash!).filter(Boolean);
  ctx.record("donate on chain", after - before === expected,
    `${campaign.title}: page said ${formatUnits(expected, 6)} USDC; donated(${ctx.member.name}) ${formatUnits(before, 6)} → ${formatUnits(after, 6)} USDC`,
    { path: new URL(campaign.url).pathname, txHashes: hashes });
  ctx.indexChecks.push({ agent: ctx.member.name, slug: campaign.slug, contract: campaign.contract });
}

/** Pool: give 1 USDC to the first sub-pool on the Emergency Pool page; the pool's USDC must grow by it. */
export async function poolGive(ctx: FlowContext): Promise<void> {
  const { page } = ctx.session;
  if (!(await signIn(ctx.session, ctx.member, ctx.out, ctx.record, ctx.say))) return;
  await page.goto("/en/emergency-pool", { waitUntil: "domcontentloaded" });
  const panel = page.locator("details").filter({ hasText: "Give to this pool" }).first();
  if ((await panel.count()) === 0) {
    ctx.record("pool give", false, "no sub-pool on /en/emergency-pool can take gifts (none created on chain?)", { path: "/en/emergency-pool", report: false });
    return;
  }
  const balance = () => ctx.chain.client.readContract({ address: ctx.chain.usdc, abi: erc20Abi, functionName: "balanceOf", args: [ctx.chain.pool] });
  const before = await balance();
  await panel.locator("summary").click();
  await panel.getByLabel("Amount", { exact: true }).fill("1", { timeout: 15_000 });
  const signedBefore = ctx.session.signed.length;
  await panel.getByRole("button", { name: /^Give to / }).click();
  await panel.getByText(/Thank you — /).waitFor({ timeout: 240_000 });
  await shot(page, ctx.out, `${ctx.member.name}-03-pool-given`);
  const after = await balance();
  const hashes = ctx.session.signed.slice(signedBefore).map((e) => e.hash!).filter(Boolean);
  // Other gifts can land in the same block; the pool must have grown by at least ours.
  ctx.record("pool give on chain", after - before >= 1_000_000n,
    `EmergencyPool USDC ${formatUnits(before, 6)} → ${formatUnits(after, 6)}`, { path: "/en/emergency-pool", txHashes: hashes });
}

const meta = (html: string, prop: string) =>
  new RegExp(`<meta[^>]+(?:property|name)="${prop}"[^>]+content="([^"]*)"`, "i").exec(html)?.[1] ??
  new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${prop}"`, "i").exec(html)?.[1] ?? null;

/** Share box check without posting anywhere (ADR-063 §4): the link and its preview work. */
export async function shareCheck(ctx: Pick<FlowContext, "record">, campaign: ApiCampaign): Promise<void> {
  const path = new URL(campaign.url).pathname;
  const page = await fetch(`${campaign.url}?ref=agentchk`, { signal: AbortSignal.timeout(20_000) });
  const html = await page.text();
  const title = meta(html, "og:title");
  const image = meta(html, "og:image");
  const card = meta(html, "twitter:card");
  const missing = [!title && "og:title", !image && "og:image", !card && "twitter:card"].filter(Boolean);
  ctx.record("share link", page.status === 200 && missing.length === 0,
    `GET ${path}?ref=… → ${page.status}${missing.length ? `; missing ${missing.join(", ")}` : `; og:title "${title!.slice(0, 60)}"`}`, { path });
  if (!image) return;
  const imageUrl = new URL(image, TESTNET_ORIGIN);
  if (imageUrl.origin !== TESTNET_ORIGIN) {
    // Not fetched: the runner only opens testnet URLs.
    ctx.record("link preview image", imageUrl.protocol === "https:", `og:image on ${imageUrl.host} (not fetched)`, { path });
    return;
  }
  const img = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
  const type = img.headers.get("content-type") ?? "";
  ctx.record("link preview image", img.status === 200 && type.startsWith("image/"), `og:image → ${img.status} ${type}`, { path });
}

/** Awkward user on a phone: wrong amounts, double click, back and forward, page width. */
export async function awkwardUse(ctx: FlowContext, campaign: ApiCampaign): Promise<void> {
  const { page } = ctx.session;
  const path = new URL(campaign.url).pathname;
  await page.goto(campaign.url, { waitUntil: "domcontentloaded" });
  const width = await page.locator("html").evaluate((el) => (el as unknown as { scrollWidth: number }).scrollWidth);
  ctx.record("phone width", width <= 391, `campaign page is ${width}px wide on a 390px screen`, { path });
  const loggedIn = await signIn(ctx.session, ctx.member, ctx.out, ctx.record, ctx.say, async (p) => {
    const button = p.getByRole("button", { name: "Log in to donate", exact: true }).first();
    await button.scrollIntoViewIfNeeded({ timeout: 30_000 });
    await button.click({ timeout: 30_000 });
  });
  if (!loggedIn) return;
  const amount = page.getByLabel("Amount", { exact: true });
  const donateButton = page.getByRole("button", { name: "Donate", exact: true });

  await amount.fill("abc", { timeout: 30_000 });
  const invalidShown = await visible(page.locator("#donate-amount-error").filter({ hasText: "Enter an amount, for example 25." }));
  ctx.record("letters as amount", invalidShown && (await donateButton.isDisabled()), `typed "abc": error ${invalidShown ? "shown" : "missing"}, Donate ${(await donateButton.isDisabled()) ? "disabled" : "enabled"}`, { path });

  await amount.fill("0");
  // The field error, not the "Details" line that is always in the (closed) details box.
  const minimumShown = await visible(page.locator("#donate-amount-error").filter({ hasText: /The minimum donation is/ }));
  ctx.record("zero as amount", minimumShown && (await donateButton.isDisabled()), `typed "0": minimum ${minimumShown ? "shown" : "missing"}, Donate ${(await donateButton.isDisabled()) ? "disabled" : "enabled"}`, { path });

  await amount.fill(DONATION_INPUT);
  await shot(page, ctx.out, `${ctx.member.name}-03-phone-form`);
  const before = ctx.session.signed.length;
  await donateButton.dblclick();
  await page.getByText(/Thank you! Your donation is recorded/).waitFor({ timeout: 240_000 });
  const donates = ctx.session.signed.slice(before).filter((e) => e.what === "Campaign.donate");
  ctx.record("double click on Donate", donates.length === 1, `${donates.length} donate transaction(s) after a double click`,
    { path, txHashes: donates.map((e) => e.hash!).filter(Boolean) });
  ctx.indexChecks.push({ agent: ctx.member.name, slug: campaign.slug, contract: campaign.contract });

  await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
  await page.goForward({ waitUntil: "domcontentloaded" });
  const back = await visible(page.getByRole("heading", { level: 1 }).first(), 15_000);
  ctx.record("back and forward", back, back ? "campaign page shows again" : "no page heading after back + forward", { path });
}

/**
 * UI ≠ chain only counts after two indexer cycles (120 s each on dev): one
 * wait for all queued checks, then each campaign's API figure must equal the
 * chain's totalRaised.
 */
export async function runIndexChecks(checks: readonly IndexCheck[], chain: Chain, record: (agent: string, step: string, ok: boolean, detail: string, path: string) => void, waitMs = 5 * 60_000) {
  const unique = [...new Map(checks.map((c) => [c.slug, c])).values()];
  const pending = new Map(unique.map((c) => [c.slug, c]));
  const deadline = Date.now() + waitMs;
  const seen = new Map<string, string>();
  while (pending.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 30_000));
    for (const c of [...pending.values()]) {
      const raised = await chain.client.readContract({ address: c.contract, abi: CampaignAbi, functionName: "totalRaised" }) as bigint;
      const res = await fetch(`${TESTNET_ORIGIN}/api/v1/campaigns/${encodeURIComponent(c.slug)}`, { signal: AbortSignal.timeout(20_000) });
      const api = res.ok ? ((await res.json()) as { data: ApiCampaign }).data.raisedUsdc : `HTTP ${res.status}`;
      seen.set(c.slug, `chain ${formatUnits(raised, 6)} USDC, API ${api}`);
      if (api === raised.toString()) {
        record(c.agent, "indexed", true, seen.get(c.slug)!, `/en/campaigns/${c.slug}`);
        pending.delete(c.slug);
      }
    }
  }
  for (const c of pending.values()) record(c.agent, "indexed", false, `after two indexer cycles: ${seen.get(c.slug) ?? "no answer"}`, `/en/campaigns/${c.slug}`);
}
