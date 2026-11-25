/**
 * apps/agents/src/browser.ts — one crew member in a real browser (TASK-061b/d).
 *
 * Each agent gets its own Playwright context with the injected wallet (the key
 * stays in Node, behind the signer policy), signs in through Privy like a
 * person and leaves a screenshot per step. Moved out of run.ts in 061d.
 */
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import type { CrewMember } from "./crew.js";
import { TESTNET_HOST, TESTNET_ORIGIN } from "./guard.js";
import { policyFor, senderFor, type Chain } from "./chain.js";
import { AS_METAMASK, createBridge, type BridgeEvent } from "./bridge.js";
import { injectedWalletScript } from "./bridge.js";
import type { TxRequest } from "./policy.js";
import { BudgetExceeded } from "./budget.js";

export type RecordStep = (step: string, ok: boolean, detail: string, extra?: { path?: string; txHashes?: string[]; report?: boolean }) => void;

export interface AgentSession {
  context: BrowserContext;
  page: Page;
  /** Wallet methods the page called, in order (diagnostics). */
  walletCalls: string[];
  /** Every transaction the wallet signed in this session. */
  signed: BridgeEvent[];
  consoleErrors: string[];
  /** Set when a send hit the transaction cap: the runner stops after this task (the page only saw an error). */
  budgetHit: BudgetExceeded | null;
  close: () => Promise<void>;
}

export interface SessionOptions {
  browser: Browser;
  member: CrewMember;
  crew: CrewMember[];
  chain: Chain;
  rpcUrl: string;
  out: string;
  viewport?: { width: number; height: number };
  /** Called before every transaction is sent (budget). Throwing stops the send. */
  beforeSend?: (tx: TxRequest) => void;
  onEvent?: (e: BridgeEvent) => void;
  onWalletError?: (method: string, error: string) => void;
  /** HTTP 5xx from the testnet. */
  onServerError?: (status: number, method: string, path: string) => void;
}

export async function openSession(o: SessionOptions): Promise<AgentSession> {
  const context = await o.browser.newContext({ baseURL: TESTNET_ORIGIN, viewport: o.viewport ?? { width: 1440, height: 900 } });
  // No Playwright trace: a trace holds the session cookies of the agent's testnet
  // account, and artifacts of this public repository can be downloaded by anyone
  // signed in to GitHub. Screenshots and the redacted run log stay.
  const page = await context.newPage();
  const walletCalls: string[] = [];
  const signed: BridgeEvent[] = [];
  const consoleErrors: string[] = [];
  const state: { budgetHit: BudgetExceeded | null } = { budgetHit: null };
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("response", (r) => {
    if (r.status() >= 500 && r.url().startsWith(TESTNET_ORIGIN)) o.onServerError?.(r.status(), r.request().method(), new URL(r.url()).pathname);
  });

  const send = senderFor(o.member, o.rpcUrl);
  const request = createBridge({
    account: o.member.account,
    host: TESTNET_HOST,
    policy: policyFor(o.member, o.crew, o.chain),
    rpc: o.chain.rpc,
    send: (tx) => { o.beforeSend?.(tx); return send(tx); },
    onEvent: (e) => { if (e.outcome === "signed" && e.hash) signed.push(e); o.onEvent?.(e); },
  });
  // Only the testnet page in the top frame gets the wallet: not an iframe, not
  // another site the page navigates or redirects to.
  await page.exposeBinding("__agentWallet", async (source, json: string) => {
    let origin = "";
    try { origin = new URL(source.frame.url()).origin; } catch { origin = ""; }
    if (source.frame !== page.mainFrame() || origin !== TESTNET_ORIGIN) {
      o.onWalletError?.("binding", `refused a wallet call from ${origin || "an unknown frame"}`);
      return JSON.stringify({ error: { message: "unauthorized", code: 4100 } });
    }
    const { method, params } = JSON.parse(json) as { method: string; params: unknown[] };
    walletCalls.push(method);
    try {
      const result = await request(method, params);
      return JSON.stringify({ result: typeof result === "bigint" ? `0x${result.toString(16)}` : result });
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        state.budgetHit = error;
        return JSON.stringify({ error: { message: "request failed", code: -32603 } });
      }
      const e = error as { message?: string; code?: number; name?: string };
      // The page only learns the code; the full error (which can name the RPC URL) stays in the redacting run log.
      if (e.name === "RefusedError") return JSON.stringify({ error: { message: "unauthorized", code: 4100 } });
      o.onWalletError?.(method, e.message ?? "failed");
      return JSON.stringify({ error: { message: "request failed", code: typeof e.code === "number" ? e.code : -32603 } });
    }
  });
  await page.addInitScript(injectedWalletScript(AS_METAMASK));

  return {
    context, page, walletCalls, signed, consoleErrors,
    get budgetHit() { return state.budgetHit; },
    async close() {
      await context.close().catch(() => undefined);
    },
  };
}

/** What the user would see: the visible buttons' names, for a failed step. */
export async function visibleButtons(page: Page): Promise<string> {
  const names = await page.getByRole("button").evaluateAll((els) =>
    els
      .filter((e) => (e as unknown as { offsetParent: unknown }).offsetParent !== null)
      .map((e) => ((e.getAttribute("aria-label") || e.textContent || "").replace(/\s+/g, " ").trim()).slice(0, 40))
      .filter(Boolean)
  ).catch(() => [] as string[]);
  return names.slice(0, 25).join(" | ");
}

export async function shot(page: Page, out: string, name: string) {
  await page.screenshot({ path: join(out, `${name}.png`), fullPage: false }).catch(() => undefined);
}

/** Visible text of the page, for the observation model. */
export async function pageText(page: Page): Promise<string> {
  return page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");
}

/**
 * Privy sign-in with the injected wallet. `opener` clicks whatever opens the
 * login window (the header's "Log in" by default; "Log in to donate" on a
 * phone, where the header collapses).
 */
export async function signIn(
  s: AgentSession, m: CrewMember, out: string, record: RecordStep, say: (line: string) => void,
  opener?: (page: Page) => Promise<void>
) {
  const { page } = s;
  try {
    if (!opener) await page.goto("/en", { waitUntil: "domcontentloaded" });
    const session = page.waitForResponse((r) => r.url().endsWith("/api/auth/session") && r.request().method() === "POST", { timeout: 90_000 });
    session.catch(() => undefined); // awaited below; a failure before that is reported by the step that failed
    if (opener) await opener(page);
    else await page.getByRole("button", { name: "Log in", exact: true }).first().click({ timeout: 30_000 });
    await shot(page, out, `${m.name}-01-login-window`);
    const ours = page.getByRole("button", { name: /metamask/i });
    await page.waitForTimeout(3_000); // the Privy window animates in
    if (!(await ours.first().isVisible().catch(() => false))) {
      // Privy may show the login methods first; open the wallet list.
      await page.getByRole("button", { name: /continue with a wallet|wallet/i }).first().click({ timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(2_000);
    }
    await ours.first().click({ timeout: 30_000 });
    const res = await session;
    await shot(page, out, `${m.name}-02-after-login`);
    record("sign in", res.status() === 200, `POST /api/auth/session → ${res.status()}`);
    return res.status() === 200;
  } catch (error) {
    say(`::notice title=login buttons (${m.name})::${await visibleButtons(page)}`);
    say(`::notice title=wallet calls (${m.name})::${s.walletCalls.slice(0, 30).join(", ") || "none"}`);
    throw error;
  }
}
