/**
 * apps/agents/src/staff-publish.ts — the staff agent publishes the crew's approved
 * campaigns on Polygon (TASK-061e part 2, step 2c).
 *
 * Like a person in Admin → Campaigns → "Approved — waiting to be published": open
 * the campaign, read the server-set "Crew agent" row first (a person's campaign is
 * not touched), press "Publish on Polygon" in the campaign's Publish panel — the
 * page prepares the call, picks the wallet with OPERATOR_ROLE (the staff wallet,
 * through the bridge, where the signer policy lets createCampaign pay only a crew
 * wallet) and sends it — then press "Check status" until the indexer has linked
 * the contract (a cycle every 120 s on dev; the page waits only a minute).
 *
 * A campaign whose transaction was already sent ("Sent transaction") is only
 * checked, never sent again. The server refuses a person's campaign too
 * (`agent_scope`). No screenshots of the queue (it lists real fundraisers).
 */
import type { Locator, Page } from "playwright";
import { shot } from "./browser.js";
import type { FlowContext } from "./flows.js";
import { cellText, section, startedByAgent } from "./staff-review.js";

/** Publishes per run (each costs gas from the staff wallet); queue entries opened per run. */
export const MAX_PUBLISHES_PER_RUN = 2;
export const MAX_PUBLISH_OPENED_PER_RUN = 20;
/** How long the agent waits for the indexer to link what it sent (two indexer cycles and some). */
export const LINK_WAIT_MS = 5 * 60_000;
/** The page's own flow: prepare, sign, mine (≤ 3 min), link (≤ 1 min). */
const FLOW_WAIT_MS = 6 * 60_000;

const PANEL = "Publish on Polygon";
const ON_CHAIN = "On Polygon";
const SENT = "Sent transaction";
const IDLE_BUTTONS = /^(Publish on Polygon|Send again)$/;
/** The only status line after a send that means "fine, the indexer just has not seen it yet" (onChain.not_found). */
const NOT_INDEXED_YET = "The campaign is not on Polygon yet";

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

interface Published { campaignId: string; title: string; path: string; earlier: boolean }

const panel = (page: Page) => section(page, PANEL);
const onChain = (page: Page) => section(page, ON_CHAIN);

/** The panel's own messages (scoped: Next.js keeps a route announcer with role=alert on every page). */
async function panelText(p: Locator, role: "alert" | "status"): Promise<string> {
  const el = p.locator(`p[role="${role}"]`);
  return (await el.count()) > 0 ? ((await el.first().innerText()) ?? "").trim() : "";
}

/** The contract address from the "On Polygon" table, once linked. */
async function linkedAddress(page: Page): Promise<string | null> {
  if ((await onChain(page).count()) === 0) return null;
  const row = onChain(page).getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Campaign contract", exact: true }) });
  const text = ((await row.getByRole("cell").last().innerText({ timeout: 10_000 }).catch(() => "")) ?? "").trim();
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? text : "";
}

/**
 * Presses Publish and waits until the page's flow ends: linked, an error in the panel,
 * or the button idle again with a status line. Re-clicks only while nothing started
 * (a click before hydration does nothing) — never after a transaction was sent.
 */
async function pressPublish(page: Page, sleep: Sleep): Promise<{ ok: boolean; detail: string }> {
  const button = panel(page).getByRole("button", { name: "Publish on Polygon", exact: true });
  const unavailable = panel(page).getByText("Wallet sign-in is not configured in this environment", { exact: false });
  await button.or(unavailable).first().waitFor({ state: "visible", timeout: 30_000 });
  if (await unavailable.isVisible()) return { ok: false, detail: "the page says wallet sign-in is not configured here" };
  const noWallet = panel(page).getByText("Connect the operator wallet", { exact: false });
  for (let attempt = 1; ; attempt++) {
    if (await noWallet.isVisible()) return { ok: false, detail: "the page sees no connected wallet to sign with" };
    if (await button.isEnabled()) await button.click({ timeout: 15_000 });
    await sleep(3_000);
    const first = ((await panel(page).getByRole("button").first().innerText().catch(() => "")) ?? "").trim();
    const started = (await button.count()) === 0 || !IDLE_BUTTONS.test(first);
    if (started || (await panelText(panel(page), "alert")) || (await panelText(panel(page), "status"))) break;
    if (attempt === 3) return { ok: false, detail: "Publish on Polygon did not start after three clicks" };
  }
  const until = Date.now() + FLOW_WAIT_MS;
  while (Date.now() < until) {
    if (await linkedAddress(page)) return { ok: true, detail: "linked by the page" };
    if ((await panel(page).count()) === 0) await page.reload({ waitUntil: "domcontentloaded" });
    const alert = await panelText(panel(page), "alert");
    if (alert) return { ok: false, detail: alert.slice(0, 300) };
    const first = ((await panel(page).getByRole("button").first().innerText().catch(() => "")) ?? "").trim();
    const status = await panelText(panel(page), "status");
    // Review of this PR: "mismatch", "indexer not available" or "Something went wrong" are failures, not a send.
    if (IDLE_BUTTONS.test(first) && status) return { ok: status.startsWith(NOT_INDEXED_YET), detail: status.slice(0, 200) };
    await sleep(5_000);
  }
  return { ok: false, detail: "the publish flow did not finish within six minutes" };
}

/** "Check status" until the indexer has linked the contract, or the wait is over. */
export async function waitForLink(page: Page, path: string, waitMs: number, sleep: Sleep = realSleep): Promise<string | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    await page.goto(path, { waitUntil: "domcontentloaded" });
    const address = await linkedAddress(page);
    if (address) return address;
    const check = panel(page).getByRole("button", { name: "Check status", exact: true });
    if ((await check.count()) === 1) {
      await check.click({ timeout: 15_000 }).catch(() => undefined);
      await sleep(5_000);
      const after = await linkedAddress(page);
      if (after) return after;
    }
    if (Date.now() >= until) return null;
    await sleep(25_000);
  }
}

/** After the gate: Admin → Campaigns → approved, waiting to be published; the crew's only. */
export async function publishQueue(
  ctx: Pick<FlowContext, "session" | "member" | "out" | "record">,
  opts: { sleep?: Sleep; linkWaitMs?: number } = {}
): Promise<void> {
  const { page } = ctx.session;
  const sleep = opts.sleep ?? realSleep;
  await page.goto("/en/admin/campaigns?view=publish", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Approved — waiting to be published", exact: true }).waitFor({ timeout: 30_000 });
  const hrefs = [...new Set(await page.locator('a[href*="/admin/campaigns/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? "")))]
    .filter((h) => /\/admin\/campaigns\/[0-9a-f-]{36}$/.test(h)).slice(0, MAX_PUBLISH_OPENED_PER_RUN);
  let tried = 0; // the per-run cap counts every attempt (each may cost gas)
  let sent = 0;
  let others = 0;
  const toLink: Published[] = [];
  for (const href of hrefs) {
    const campaignId = href.split("/").pop()!;
    const path = `/en/admin/campaigns/${campaignId}`;
    try {
      await page.goto(href, { waitUntil: "domcontentloaded" });
      if (!(await startedByAgent(page))) {
        others++; // a person's campaign: David publishes it
        continue;
      }
      const title = await cellText(page, "Title");
      if ((await panel(page).getByText(SENT, { exact: false }).count()) > 0) {
        toLink.push({ campaignId, title, path, earlier: true }); // sent in an earlier run: check only, never send twice
        continue;
      }
      if (tried >= MAX_PUBLISHES_PER_RUN) continue;
      tried++;
      const result = await pressPublish(page, sleep);
      if (result.ok) sent++;
      ctx.record("publish campaign", result.ok, result.ok ? `sent "${title}" (${result.detail})` : `"${title}": ${result.detail}`, { path });
      if (result.ok) toLink.push({ campaignId, title, path, earlier: false });
    } catch (error) {
      // First line only: Playwright's call log follows, with terminal colour codes.
      ctx.record("publish campaign", false, error instanceof Error ? (error.message.split("\n")[0] ?? "").slice(0, 200) : "failed", { path });
    }
  }
  // One wait for all: the indexer links them in the same cycles.
  const until = Date.now() + (opts.linkWaitMs ?? LINK_WAIT_MS);
  for (const c of toLink) {
    const address = await waitForLink(page, c.path, Math.max(0, until - Date.now()), sleep);
    if (address) await shot(page, ctx.out, `${ctx.member.name}-06-published-${c.campaignId.slice(0, 8)}`);
    if (address) ctx.record("campaign on Polygon", true, `"${c.title}" live at ${address}`, { path: c.path });
    // Sent in this run: the indexer may simply not have reached it yet — the next run checks again.
    // Sent in an earlier run and still not linked: something is wrong (indexer, mismatch).
    else if (!c.earlier) ctx.record("campaign on Polygon", true, `"${c.title}": sent, not linked yet (the next run checks again)`, { path: c.path });
    else ctx.record("campaign on Polygon", false, `"${c.title}": sent in an earlier run and still not linked (reverted, dropped or a mismatch — a person checks the transaction on the admin page)`, { path: c.path });
  }
  const earlier = toLink.filter((c) => c.earlier).length;
  ctx.record("publish queue", true, `${hrefs.length} approved; ${tried} tried, ${sent} sent by the agent, ${earlier} checked from an earlier run, ${others} left for a person`, { path: "/en/admin/campaigns?view=publish" });
}
