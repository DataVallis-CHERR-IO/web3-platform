/**
 * apps/agents/src/staff-payout.ts — the staff agent sets the payout plan of the crew's
 * succeeded campaigns (TASK-061g).
 *
 * After a crew campaign SUCCEEDS on chain, CHERR.IO's operator calls `setPayoutMode`
 * (Campaign.sol: operator only, state SUCCEEDED only, once). Like a person: Admin →
 * Chain actions lists the campaign with the task "Set the payout plan"; its admin page
 * section "On the blockchain — CHERR.IO actions" shows "Suggested: …" (ADR-049), the
 * radios "One payment" / "Three milestone payments", "Note (optional)" and the button
 * "Set the payout plan". The page prepares the call, the injected staff wallet (the one
 * with OPERATOR_ROLE; signer policy: `setPayoutMode` for the staff persona only) signs it,
 * the panel says "Sent. …"; after a reload the table row "Payout plan" shows the choice.
 *
 * Only a crew campaign is touched: the server-set "Crew agent" row, a payout address that
 * is a crew wallet, never a red-team wallet, never a person's campaign. No screenshots of
 * the queue. The caller has passed `adminGate`, as for `publishQueue`.
 */
import type { Page } from "playwright";
import type { AgentSession } from "./browser.js";
import type { FlowContext } from "./flows.js";
import { cellText, isRedTeam, section, startedByAgent } from "./staff-review.js";

/** Payout plans set per run (each costs gas from the staff wallet); queue entries opened per run. */
export const MAX_PAYOUT_PLANS_PER_RUN = 2;
export const MAX_PAYOUT_OPENED_PER_RUN = 20;
/** The page's flow: wallet, send, mine; and then the indexer (a cycle every 120 s on dev). */
const FLOW_WAIT_MS = 5 * 60_000;
export const INDEX_WAIT_MS = 4 * 60_000;
const ENABLE_WAIT_MS = 60_000;

export const PAYOUT_NOTE = "Testnet staff agent: suggested plan (ADR-049)";
const QUEUE_TASK = "Set the payout plan";
const PAYOUT_ADDRESS_ROW = "Payout address (verified organisation)";
const CHAIN_SECTION = "On the blockchain — CHERR.IO actions";
const PLAN_LABEL = { single: "One payment", milestones: "Three milestone payments" } as const;
const NOT_SET = "Not set yet";

export type Plan = keyof typeof PLAN_LABEL;
type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Pure logic (unit-tested) ──

/** "Suggested: One payment — the organisation's first …" → "single"; no such line → null. */
export function parseSuggestion(text: string): Plan | null {
  const m = /^\s*Suggested:\s*(One payment|Three milestone payments)\b/i.exec(text);
  if (!m) return null;
  return m[1]!.toLowerCase() === PLAN_LABEL.single.toLowerCase() ? "single" : "milestones";
}

/** The suggested plan; without one, "One payment" (the agent only handles organisations). */
export const choosePlan = (suggestion: string): Plan => parseSuggestion(suggestion) ?? "single";

export interface CrewCheck { startedByAgent: boolean; payoutAddress: string; crewAddresses: readonly string[]; redTeamExtra?: readonly string[] }
/** Safety check read from the page: a crew campaign paying a crew wallet, never red team, never a person's. */
export function crewVerdict(c: CrewCheck): { ok: true } | { ok: false; reason: string } {
  if (!c.startedByAgent) return { ok: false, reason: "not a crew campaign (a person's campaign)" };
  if (isRedTeam(c.payoutAddress, c.redTeamExtra ?? [])) return { ok: false, reason: "a red-team wallet" };
  if (!c.crewAddresses.map((a) => a.toLowerCase()).includes(c.payoutAddress.toLowerCase())) {
    return { ok: false, reason: "the payout address is not a crew wallet" };
  }
  return { ok: true };
}

export interface QueueRow { href: string; task: string }
/** Guardian queue rows that wait for a payout plan: campaign links only, once each, capped. */
export function payoutTargets(rows: readonly QueueRow[], limit = MAX_PAYOUT_OPENED_PER_RUN): string[] {
  const hrefs = rows.filter((r) => r.task.trim() === QUEUE_TASK && /\/admin\/campaigns\/[0-9a-f-]{36}(#.*)?$/.test(r.href))
    .map((r) => r.href.replace(/#.*$/, ""));
  return [...new Set(hrefs)].slice(0, limit);
}

/** The panel's message after a send: "Sent. …", "Sent, but the result is not known yet", or a revert. */
export function classifyOutcome(text: string): "sent" | "unknown" | "reverted" | null {
  if (/^Sent, but the result is not known yet/m.test(text)) return "unknown";
  if (/^Sent\. The page updates/m.test(text)) return "sent";
  if (/^The transaction failed on the blockchain/m.test(text)) return "reverted";
  return null;
}

// ── The page ──

const panel = (page: Page) => page.locator('section[aria-labelledby="guardian-payout"]');
const messages = (page: Page) => page.locator('div.ch-panel[role="status"], div.ch-panel[role="alert"]');

/** The "Payout plan" row of the chain section: "Not set yet", "One payment" or "Three milestone payments". */
async function planRow(page: Page): Promise<string> {
  const row = section(page, CHAIN_SECTION).getByRole("row").filter({ has: page.getByRole("rowheader", { name: "Payout plan", exact: true }) });
  return ((await row.getByRole("cell").last().innerText({ timeout: 10_000 }).catch(() => "")) ?? "").trim();
}

async function messageText(page: Page): Promise<string> {
  const texts = await messages(page).allInnerTexts();
  return texts.join("\n");
}

/** Types the note, picks the plan, presses the button once the page is ready; waits for the page's own message. */
export async function pressSetPlan(session: Pick<AgentSession, "page" | "walletCalls">, plan: Plan, sleep: Sleep): Promise<{ ok: boolean; detail: string }> {
  const { page } = session;
  const p = panel(page);
  const button = p.getByRole("button", { name: QUEUE_TASK, exact: true });
  await button.waitFor({ state: "visible", timeout: 30_000 });
  const radio = p.getByRole("radio", { name: PLAN_LABEL[plan] });
  if (await radio.isDisabled()) return { ok: false, detail: `"${PLAN_LABEL[plan]}" is not possible on this campaign` };
  await radio.check({ timeout: 15_000 });
  if (!(await radio.isChecked())) return { ok: false, detail: "the plan could not be selected" };
  await p.getByLabel("Note (optional)").fill(PAYOUT_NOTE, { timeout: 15_000 });
  // Enabled = the wallets are ready and one holds OPERATOR_ROLE (the page reads the roles from chain).
  const enabledBy = Date.now() + ENABLE_WAIT_MS;
  while (!(await button.isEnabled())) {
    if ((await p.getByText("None of your connected wallets has the Operator role", { exact: false }).count()) > 0) {
      return { ok: false, detail: "no connected wallet has the Operator role" };
    }
    if (Date.now() >= enabledBy) return { ok: false, detail: "the button stayed disabled for a minute (wallets or roles not ready)" };
    await sleep(2_000);
  }
  const callsBefore = session.walletCalls.length;
  for (let attempt = 1; ; attempt++) {
    await button.click({ timeout: 15_000 });
    await sleep(3_000);
    // Started = the wallet was asked, or the page shows progress or a message; never click again after that.
    if (session.walletCalls.length > callsBefore || (await messageText(page)) || !(await button.isEnabled().catch(() => false))) break;
    if (attempt === 3) return { ok: false, detail: "the button did not start the flow after three clicks" };
  }
  const until = Date.now() + FLOW_WAIT_MS;
  while (Date.now() < until) {
    const text = await messageText(page);
    const outcome = classifyOutcome(text);
    if (outcome === "sent" || outcome === "unknown") return { ok: true, detail: text.split("\n")[0]!.slice(0, 120) };
    if (outcome === "reverted") return { ok: false, detail: "the transaction reverted on chain" };
    if (text.trim() && !/Sent/.test(text)) return { ok: false, detail: text.trim().split("\n")[0]!.slice(0, 200) };
    await sleep(5_000);
  }
  const calls = session.walletCalls.slice(callsBefore);
  return { ok: false, detail: `no confirmation message within five minutes; wallet calls (${calls.length}): ${calls.slice(-8).join(", ") || "none"}` };
}

/** After the gate: Admin → Chain actions; at most MAX_PAYOUT_PLANS_PER_RUN crew campaigns get their plan. */
export async function setPayoutPlans(
  ctx: Pick<FlowContext, "session" | "member" | "out" | "record">,
  opts: { crewAddresses: readonly string[]; redTeamExtra?: readonly string[]; sleep?: Sleep; indexWaitMs?: number }
): Promise<void> {
  const { page } = ctx.session;
  const sleep = opts.sleep ?? realSleep;
  await page.goto("/en/admin/guardian", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Chain actions", level: 1, exact: true }).waitFor({ timeout: 30_000 });
  const rows = await page.getByRole("region", { name: "Chain actions", exact: true }).locator("tbody tr").evaluateAll((trs) =>
    trs.map((tr) => ({ href: tr.querySelector("a")?.getAttribute("href") ?? "", task: tr.querySelectorAll("td")[3]?.textContent ?? "" }))
  );
  const hrefs = payoutTargets(rows);
  let tried = 0;
  let done = 0;
  let others = 0;
  for (const href of hrefs) {
    const path = href;
    try {
      await page.goto(href, { waitUntil: "domcontentloaded" });
      const verdict = crewVerdict({
        startedByAgent: await startedByAgent(page),
        payoutAddress: await cellText(page, PAYOUT_ADDRESS_ROW),
        crewAddresses: opts.crewAddresses,
        ...(opts.redTeamExtra ? { redTeamExtra: opts.redTeamExtra } : {}),
      });
      if (!verdict.ok) {
        others++; // a person's, or a red-team campaign: not touched (a red-team row waiting here is worth a line)
        if (verdict.reason.startsWith("a red-team")) ctx.record("payout plan", false, "a red-team campaign waits for a payout plan — not touched", { path });
        continue;
      }
      if ((await planRow(page)) !== NOT_SET) continue; // set already (by a person or an earlier run)
      if (tried >= MAX_PAYOUT_PLANS_PER_RUN) continue;
      tried++;
      const title = await cellText(page, "Title");
      const suggestion = (await panel(page).getByText(/^Suggested:/).first().innerText({ timeout: 5_000 }).catch(() => "")).trim();
      const plan = choosePlan(suggestion);
      const result = await pressSetPlan(ctx.session, plan, sleep);
      if (!result.ok) {
        ctx.record("payout plan", false, `"${title}": ${result.detail}`, { path });
        continue;
      }
      // Reload until the indexer shows the plan (a cycle every 120 s on dev).
      const until = Date.now() + (opts.indexWaitMs ?? INDEX_WAIT_MS);
      let shown = "";
      for (;;) {
        await page.goto(href, { waitUntil: "domcontentloaded" });
        shown = await planRow(page);
        if (shown === PLAN_LABEL[plan] || Date.now() >= until) break;
        await sleep(20_000);
      }
      if (shown === PLAN_LABEL[plan]) {
        done++;
        ctx.record("payout plan", true, `"${title}": set to "${PLAN_LABEL[plan]}" (${suggestion ? "suggested" : "default, no suggestion shown"}; page shows it)`, { path });
      } else {
        done++;
        // The transaction was confirmed; only the indexer is behind. The next run sees "Not set yet" and would send again → say so loudly.
        ctx.record("payout plan", shown === NOT_SET, `"${title}": sent "${PLAN_LABEL[plan]}", the page shows "${shown || "nothing"}" after the wait (indexer behind; a person checks before another run)`, { path });
      }
    } catch (error) {
      ctx.record("payout plan", false, error instanceof Error ? (error.message.split("\n")[0] ?? "").slice(0, 200) : "failed", { path });
    }
  }
  ctx.record("payout queue", true, `${hrefs.length} waiting; ${tried} tried, ${done} set by the agent, ${others} left for a person`, { path: "/en/admin/guardian" });
}
