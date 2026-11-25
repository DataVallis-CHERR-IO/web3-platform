/**
 * apps/agents/src/run.ts — one run of the testnet crew (TASK-061b).
 *
 *   pnpm --filter agents run:flow donor
 *
 * The first flow is fixed script (no model): the treasury tops up donor-1,
 * donor-1 signs in to https://testnet.cherr.io through Privy with the injected
 * wallet, donates 1 USDC to a live campaign, and the run checks the chain and,
 * after two indexer cycles, the page. Everything goes to out/: run.jsonl,
 * screenshots, a Playwright trace and summary.md.
 *
 * Env: AGENT_MNEMONIC, AGENT_RPC_URL (GitHub environment "agents").
 */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { encodeFunctionData, erc20Abi, formatUnits } from "viem";
import { CampaignAbi } from "@cherrio/contracts/abis";
import { deriveCrew, member, type CrewMember } from "./crew.js";
import { TESTNET_HOST, TESTNET_ORIGIN } from "./guard.js";
import { connectChain, policyFor, senderFor, type Chain } from "./chain.js";
import { createBridge, injectedWalletScript } from "./bridge.js";
import { checkTransaction } from "./policy.js";
import { planTopUps, type Levels } from "./funding.js";
import { createRunLog, redact, type LogEvent } from "./runlog.js";

const OUT = join(process.cwd(), "out");
const DONATION = 1_000_000n; // 1 USDC
const POL = 10n ** 18n;
/** First runs: small amounts, so a 20 USDC faucet drop is enough. */
const FIRST_RUN_LEVELS: Levels = {
  pol: { min: POL / 20n, target: POL / 5n }, // 0.05 → 0.2 POL
  usdc: { min: 2_000_000n, target: 5_000_000n }, // 2 → 5 USDC
  treasuryReservePol: POL / 10n,
};

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

interface Result { step: string; ok: boolean; detail: string }

async function main(): Promise<number> {
  const flow = process.argv[2] ?? "donor";
  if (flow !== "donor") throw new Error(`unknown flow: ${flow}`);
  mkdirSync(OUT, { recursive: true });
  const rpcUrl = need("AGENT_RPC_URL");
  const crew = deriveCrew(need("AGENT_MNEMONIC"));
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const log = createRunLog(join(OUT, "run.jsonl"), runId, [rpcUrl]);
  const results: Result[] = [];
  const record = (step: string, ok: boolean, rawDetail: string, extra: Partial<LogEvent> = {}) => {
    const detail = String(redact(rawDetail, undefined, [rpcUrl]));
    results.push({ step, ok, detail });
    log({ agent: extra.agent as string ?? "runner", kind: ok ? "step" : "bug", step, detail, ...extra });
    console.log(`${ok ? "✓" : "✗"} ${step}: ${detail}`);
  };

  const chain = await connectChain(rpcUrl);
  const donor = member(crew, "donor-1");
  record("guard", true, `testnet ${TESTNET_ORIGIN}, chain 80002, factory ${chain.factory}`);

  await topUp(chain, crew, [donor], rpcUrl, record, log);

  const campaign = await pickCampaign();
  if (!campaign) {
    record("pick campaign", false, "no live campaign with more than 2 hours left in /api/v1/campaigns");
    return finish(results);
  }
  record("pick campaign", true, `${campaign.title} (${campaign.contract})`);

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: TESTNET_ORIGIN, viewport: { width: 1440, height: 900 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
  page.on("response", (r) => {
    if (r.status() >= 500 && r.url().startsWith(TESTNET_ORIGIN)) {
      record("http", false, `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`, { agent: donor.name });
    }
  });
  await attachWallet(page, donor, crew, chain, rpcUrl,
    (e) => log({ agent: donor.name, kind: e.outcome === "refused" ? "refused" : "tx", ...e }),
    (method, error) => log({ agent: donor.name, kind: "info", wallet: method, error }));

  try {
    await signIn(page, donor, record);
    if (results.at(-1)?.ok) await donate(page, donor, campaign, chain, record);
  } catch (error) {
    record("flow", false, error instanceof Error ? error.message.slice(0, 300) : "failed", { agent: donor.name });
    await page.screenshot({ path: join(OUT, "failure.png"), fullPage: true }).catch(() => undefined);
  } finally {
    if (consoleErrors.length > 0) log({ agent: donor.name, kind: "observation", consoleErrors });
    await context.tracing.stop({ path: join(OUT, "trace.zip") });
    await browser.close();
  }
  return finish(results);
}

async function topUp(
  chain: Chain, crew: CrewMember[], who: CrewMember[], rpcUrl: string,
  record: (step: string, ok: boolean, detail: string) => void,
  log: (e: LogEvent) => void
) {
  const treasury = member(crew, "treasury");
  const balance = async (m: CrewMember) => ({
    name: m.name, address: m.address,
    pol: await chain.client.getBalance({ address: m.address }),
    usdc: await chain.client.readContract({ address: chain.usdc, abi: erc20Abi, functionName: "balanceOf", args: [m.address] }),
  });
  const plan = planTopUps(await balance(treasury), await Promise.all(who.map(balance)), FIRST_RUN_LEVELS);
  if (!plan.ok) {
    record("top-up", false, `treasury ${treasury.address} short by ${formatUnits(plan.shortfall.pol, 18)} POL / ${formatUnits(plan.shortfall.usdc, 6)} USDC`);
    return;
  }
  const send = senderFor(treasury, rpcUrl);
  const policy = policyFor(treasury, crew, chain);
  for (const t of plan.transfers) {
    const tx = t.asset === "POL"
      ? { to: t.to, value: t.amount }
      : { to: chain.usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [t.to, t.amount] }) };
    const verdict = await checkTransaction(tx, policy);
    if (!verdict.ok) throw new Error(`policy refused a top-up: ${verdict.reason}`);
    const hash = await send(tx);
    await chain.client.waitForTransactionReceipt({ hash, timeout: 180_000 });
    log({ agent: "treasury", kind: "tx", what: `top-up ${t.asset} → ${t.name}`, hash });
  }
  record("top-up", true, plan.transfers.length === 0 ? "nothing needed" : `${plan.transfers.length} transfer(s)`);
}

interface ApiCampaign { title: string; slug: string; url: string; contract: `0x${string}`; state: string | null; deadline: string; raisedUsdc: string | null }

/** The public API reports states in lower case ("live", "ending", …; `PublicState` in apps/web). */
async function pickCampaign(): Promise<ApiCampaign | null> {
  const res = await fetch(`${TESTNET_ORIGIN}/api/v1/campaigns?sort=ending`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`/api/v1/campaigns answered ${res.status}`);
  const body = (await res.json()) as { data: ApiCampaign[] };
  const soon = Date.now() + 2 * 3_600_000;
  return body.data.find((c) => c.state === "live" && c.contract && Date.parse(c.deadline) > soon) ?? null;
}

async function attachWallet(
  page: Page, m: CrewMember, crew: CrewMember[], chain: Chain, rpcUrl: string,
  onEvent: Parameters<typeof createBridge>[0]["onEvent"],
  onError: (method: string, error: string) => void
) {
  const request = createBridge({ account: m.account, host: TESTNET_HOST, policy: policyFor(m, crew, chain), rpc: chain.rpc, send: senderFor(m, rpcUrl), onEvent });
  // Only the testnet page in the top frame gets the wallet: not an iframe, not
  // another site the page navigates or redirects to.
  await page.exposeBinding("__agentWallet", async (source, json: string) => {
    let origin = "";
    try { origin = new URL(source.frame.url()).origin; } catch { origin = ""; }
    if (source.frame !== page.mainFrame() || origin !== TESTNET_ORIGIN) {
      onError("binding", `refused a wallet call from ${origin || "an unknown frame"}`);
      return JSON.stringify({ error: { message: "unauthorized", code: 4100 } });
    }
    const { method, params } = JSON.parse(json) as { method: string; params: unknown[] };
    try {
      const result = await request(method, params);
      return JSON.stringify({ result: typeof result === "bigint" ? `0x${result.toString(16)}` : result });
    } catch (error) {
      const e = error as { message?: string; code?: number; name?: string };
      // The page only learns the code; the full error (which can name the RPC URL) stays in the redacting run log.
      if (e.name === "RefusedError") return JSON.stringify({ error: { message: "unauthorized", code: 4100 } });
      onError(method, e.message ?? "failed");
      return JSON.stringify({ error: { message: "request failed", code: typeof e.code === "number" ? e.code : -32603 } });
    }
  });
  await page.addInitScript(injectedWalletScript());
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false }).catch(() => undefined);
}

async function signIn(page: Page, m: CrewMember, record: (s: string, ok: boolean, d: string, e?: Partial<LogEvent>) => void) {
  await page.goto("/en", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Log in", exact: true }).first().click({ timeout: 30_000 });
  await shot(page, "01-login-window");
  const session = page.waitForResponse((r) => r.url().endsWith("/api/auth/session") && r.request().method() === "POST", { timeout: 90_000 });
  const ours = page.getByRole("button", { name: /CHERR\.IO test wallet/ });
  if (!(await ours.isVisible().catch(() => false))) {
    // Privy may show the login methods first; open the wallet list.
    await page.getByRole("button", { name: /wallet/i }).first().click({ timeout: 15_000 }).catch(() => undefined);
    await shot(page, "02-wallet-list");
  }
  await ours.first().click({ timeout: 30_000 });
  const res = await session;
  await shot(page, "03-after-login");
  record("sign in", res.status() === 200, `POST /api/auth/session → ${res.status()}`, { agent: m.name });
}

async function donate(page: Page, m: CrewMember, c: ApiCampaign, chain: Chain, record: (s: string, ok: boolean, d: string, e?: Partial<LogEvent>) => void) {
  const before = await chain.client.readContract({ address: c.contract, abi: CampaignAbi, functionName: "donated", args: [m.address] }) as bigint;
  await page.goto(c.url, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Amount", { exact: true }).fill(formatUnits(DONATION, 6), { timeout: 30_000 });
  await shot(page, "04-donate-form");
  await page.getByRole("button", { name: "Donate", exact: true }).click();
  await page.getByText(/Thank you! Your donation is recorded/).waitFor({ timeout: 240_000 });
  await shot(page, "05-donated");
  const after = await chain.client.readContract({ address: c.contract, abi: CampaignAbi, functionName: "donated", args: [m.address] }) as bigint;
  record("donate on chain", after - before === DONATION, `donated(${m.name}) ${formatUnits(before, 6)} → ${formatUnits(after, 6)} USDC`, { agent: m.name });

  // The indexer on dev runs every 120 s: allow two cycles before calling a gap a bug.
  const raised = await chain.client.readContract({ address: c.contract, abi: CampaignAbi, functionName: "totalRaised" }) as bigint;
  const deadline = Date.now() + 5 * 60_000;
  let seen: string | null = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 30_000));
    const res = await fetch(`${TESTNET_ORIGIN}/api/v1/campaigns/${encodeURIComponent(c.slug)}`, { signal: AbortSignal.timeout(20_000) });
    seen = res.ok ? ((await res.json()) as { data: ApiCampaign }).data.raisedUsdc : `HTTP ${res.status}`;
    if (seen === raised.toString()) break;
  }
  record("indexed", seen === raised.toString(), `chain totalRaised ${formatUnits(raised, 6)} USDC, API ${seen === null ? "no answer" : seen}`, { agent: m.name });
}

function finish(results: Result[]): number {
  const failed = results.filter((r) => !r.ok);
  const lines = ["## Testnet agents — run", "", "| Step | Result | Detail |", "|---|---|---|",
    ...results.map((r) => `| ${r.step} | ${r.ok ? "✓" : "✗"} | ${r.detail.replace(/\|/g, "/")} |`)];
  writeFileSync(join(OUT, "summary.md"), `${lines.join("\n")}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  // Annotations: the only part of a run readable without the log blob.
  for (const r of results) console.log(`::${r.ok ? "notice" : "error"} title=${r.step}::${r.detail.replace(/[\r\n]+/g, " ")}`);
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = String(redact(error instanceof Error ? error.message : "failed", undefined, [process.env.AGENT_RPC_URL ?? ""]));
    console.log(`::error title=run::${message.replace(/[\r\n]+/g, " ").slice(0, 400)}`);
    process.exit(1);
  }
);
