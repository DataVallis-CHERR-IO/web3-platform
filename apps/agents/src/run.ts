/**
 * apps/agents/src/run.ts — one run of the testnet crew (TASK-061b, 061d).
 *
 *   pnpm --filter agents run:flow donor   # 061b: donor-1 donates once, no model
 *   pnpm --filter agents run:flow crew    # 061d: the dispatcher plans, every persona works
 *
 * Order: guard → plan → top-ups → tasks (one browser context per agent) →
 * index checks (two indexer cycles) → bug reports (GitHub Issues) → summary.
 * Everything goes to out/: run.jsonl, screenshots, summary.md (no Playwright trace: it would hold the session cookies, and artifacts of this public repository are downloadable).
 *
 * Env (GitHub environment "agents"): AGENT_MNEMONIC, AGENT_RPC_URL; for "crew"
 * also ANTHROPIC_API_KEY (optional: without it the default plan runs and no
 * observations are made), AGENTS_REPORT_TOKEN + AGENTS_REPORT_REPO (optional:
 * without them bugs are only in the summary).
 */
import { mkdirSync, writeFileSync, appendFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { encodeFunctionData, erc20Abi, formatUnits } from "viem";
import { assertCrewMatchesRegistry, deriveCrew, member, type CrewMember } from "./crew.js";
import { TESTNET_ORIGIN } from "./guard.js";
import { connectChain, policyFor, senderFor, type Chain } from "./chain.js";
import { checkTransaction } from "./policy.js";
import { planTopUps, type Levels } from "./funding.js";
import { createRunLog, redact, type LogEvent } from "./runlog.js";
import { BudgetExceeded, createBudget } from "./budget.js";
import { placeAssignments, type Placed } from "./models.js";
import { planRun, type TestnetSummary } from "./dispatcher.js";
import { observe } from "./observe.js";
import { fileHolds, fileReports, type Bug, type Hold } from "./reports.js";
import { openSession, pageText } from "./browser.js";
import { startCampaign, startOrganisation } from "./fundraiser.js";
import { reviewOrganisations } from "./staff-review.js";
import { base32Decode } from "./staff.js";
import { awkwardUse, donate, liveCampaigns, pick, poolGive, runIndexChecks, shareCheck, type FlowContext, type IndexCheck } from "./flows.js";

const OUT = join(process.cwd(), "out");
/**
 * Synchronous stdout: GitHub reads annotations from the log, and a plain
 * console.log can still be in a buffer when the process exits (run 45596868393
 * ended with no step annotations at all).
 */
const say = (line: string) => writeSync(1, `${line}\n`);
const POL = 10n ** 18n;
/** Small amounts: every spending persona keeps 2–5 test USDC and 0.05–0.2 POL. */
const LEVELS: Levels = {
  pol: { min: POL / 20n, target: POL / 5n }, // 0.05 → 0.2 POL
  usdc: { min: 2_000_000n, target: 5_000_000n }, // 2 → 5 USDC
  treasuryReservePol: POL / 10n,
};
const SPENDING = new Set(["donate", "pool-give", "awkward-use"]);
/** Tasks that do not work on one of the live campaigns. */
const NO_CAMPAIGN = new Set(["pool-give", "start-organisation", "start-campaign", "review-submission"]);

const ALL_SECRETS = () => ["AGENT_RPC_URL", "AGENT_MNEMONIC", "ANTHROPIC_API_KEY", "AGENTS_REPORT_TOKEN", "AGENT_STAFF_TOTP_SECRET"].map((n) => process.env[n] ?? "");

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

interface Result { agent: string; step: string; ok: boolean; detail: string }

async function main(): Promise<number> {
  const flow = process.argv[2] ?? "donor";
  if (flow !== "donor" && flow !== "crew") throw new Error(`unknown flow: ${flow}`);
  mkdirSync(OUT, { recursive: true });
  const rpcUrl = need("AGENT_RPC_URL");
  const mnemonic = need("AGENT_MNEMONIC");
  const apiKey = flow === "crew" ? process.env.ANTHROPIC_API_KEY || undefined : undefined;
  const reportToken = process.env.AGENTS_REPORT_TOKEN || undefined;
  const secrets = [rpcUrl, mnemonic, apiKey ?? "", reportToken ?? "", process.env.AGENT_STAFF_TOTP_SECRET ?? ""];
  const crew = deriveCrew(mnemonic);
  assertCrewMatchesRegistry(crew);
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const runUrl = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : runId;
  const log = createRunLog(join(OUT, "run.jsonl"), runId, secrets);
  const budget = createBudget();
  const results: Result[] = [];
  const bugs: Bug[] = [];
  const observations: { agent: string; task: string; remarks: string[] }[] = [];
  const holds: Hold[] = [];
  // The staff agent's authenticator key (TASK-061e); only the crew flow reviews.
  const staffSecret = flow === "crew" && process.env.AGENT_STAFF_TOTP_SECRET ? base32Decode(process.env.AGENT_STAFF_TOTP_SECRET) : null;

  const recordFor = (m: { name: string; persona: string }, task: string) =>
    (step: string, ok: boolean, rawDetail: string, extra: { path?: string; txHashes?: string[]; report?: boolean } = {}) => {
      // Redact first, then cut: a cut through a secret would no longer match it.
      const detail = String(redact(rawDetail, undefined, secrets)).slice(0, 600);
      results.push({ agent: m.name, step, ok, detail });
      log({ agent: m.name, kind: ok ? "step" : "bug", task, step, detail, path: extra.path, txHashes: extra.txHashes });
      // GitHub shows at most 10 notices per step (run 45622175784 lost the rest): failures are
      // printed at once, passed steps once per agent at the end (finish).
      if (!ok) say(`::error title=${m.name} · ${step}::${detail.replace(/[\r\n]+/g, " ")}`);
      if (!ok && extra.report !== false) {
        bugs.push({ flow, agent: m.name, persona: m.persona, step, detail, path: extra.path, txHashes: extra.txHashes });
      }
    };
  const runner = recordFor({ name: "runner", persona: "runner" }, "run");

  const chain = await connectChain(rpcUrl);
  runner("guard", true, `testnet ${TESTNET_ORIGIN}, chain 80002, factory ${chain.factory}`);
  const imageSha = await webVersion();

  // ── Plan ──
  let plan: Placed[];
  if (flow === "donor") {
    plan = placeAssignments([{ task: "donate", agent: "donor-1" }], crew.map((c) => c.name));
  } else {
    const summary = await summarize(chain, crew);
    // Shown with the plan, so a skipped task can be explained from the annotations alone.
    runner("testnet", true, `live campaigns ${summary.liveCampaigns}, sub-pools on the pool page ${summary.subPools}, ` +
      Object.entries(summary.balances).map(([n, b]) => `${n} ${b.usdc} USDC/${b.pol} POL`).join(", "));
    const result = await planRun(summary, { apiKey, budget });
    plan = result.plan;
    log({ agent: "dispatcher", kind: "info", source: result.source, reason: result.reason, plan });
    runner("plan", true, `${result.source}${result.reason ? ` (${result.reason})` : ""}: ${plan.map((p) => `${p.agent} ${p.task}`).join(", ")}`);
  }

  // ── Top-ups for everyone who spends ──
  const spenders = [...new Set(plan.filter((p) => SPENDING.has(p.task)).map((p) => member(crew, p.agent)))];
  await topUp(chain, crew, spenders, rpcUrl, runner, log, budget)
    .catch((e: unknown) => runner("top-up", false, message(e), { report: false }));

  // ── Tasks ──
  const indexChecks: IndexCheck[] = [];
  const campaigns = await liveCampaigns().catch((e: unknown) => {
    runner("campaigns", false, message(e));
    return [];
  });
  const browser = await chromium.launch();
  try {
    for (const task of plan) {
      const m = member(crew, task.agent);
      const record = recordFor(m, task.task);
      const needsCampaign = !NO_CAMPAIGN.has(task.task);
      const campaign = needsCampaign ? pick(campaigns) : null;
      if (needsCampaign && !campaign) {
        record(task.task, false, "no live campaign with more than 2 hours left in /api/v1/campaigns", { report: false });
        continue;
      }
      if (task.task === "share-check") {
        await shareCheck({ record }, campaign!).catch((e: unknown) => record("share-check", false, message(e)));
        continue;
      }
      const session = await openSession({
        browser, member: m, crew, chain, rpcUrl, out: OUT,
        viewport: task.task === "awkward-use" ? { width: 390, height: 844 } : undefined,
        beforeSend: () => budget.spend("transactions"),
        onEvent: (e) => log({ agent: m.name, kind: e.outcome === "refused" ? "refused" : "tx", ...e }),
        onWalletError: (method, error) => log({ agent: m.name, kind: "info", wallet: method, error }),
        onServerError: (status, method, path) => record("http", false, `${status} ${method} ${path}`, { path }),
      });
      const ctx: FlowContext = { session, member: m, chain, out: OUT, record, say, indexChecks };
      try {
        if (task.task === "donate") await donate(ctx, campaign!);
        else if (task.task === "pool-give") await poolGive(ctx);
        else if (task.task === "awkward-use") await awkwardUse(ctx, campaign!);
        else if (task.task === "start-organisation") await startOrganisation(ctx, { model: task.model, apiKey, budget });
        else if (task.task === "start-campaign") await startCampaign(ctx, { model: task.model, apiKey, budget });
        else if (task.task === "review-submission") {
          await reviewOrganisations(ctx, { secret: staffSecret, crewAddresses: crew.map((c) => c.address), model: task.model, apiKey, budget, holds });
        } else throw new Error(`the runner has no steps for ${task.task}`);
        if (session.budgetHit) throw session.budgetHit;
        // No observations on admin pages: they hold other people's applications.
        if (task.task === "review-submission") continue;
        const remarks = await observe({ model: task.model, task: task.task, pageText: await pageText(session.page) }, { apiKey, budget });
        if (remarks.length > 0) {
          observations.push({ agent: m.name, task: task.task, remarks });
          log({ agent: m.name, kind: "observation", task: task.task, remarks });
        }
      } catch (error) {
        if (error instanceof BudgetExceeded) throw error;
        // A refused send makes the page wait and time out: that is the cap, not a bug.
        if (session.budgetHit) throw session.budgetHit;
        // Not on admin pages: a failure there may show a real applicant's data, and the artifact is public.
        if (task.task !== "review-submission") {
          await session.page.screenshot({ path: join(OUT, `${m.name}-failure.png`), fullPage: true }).catch(() => undefined);
        }
        record(task.task, false, message(error), { path: safePath(session.page.url()) });
      } finally {
        if (session.consoleErrors.length > 0) log({ agent: m.name, kind: "observation", consoleErrors: session.consoleErrors });
        await session.close();
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetExceeded)) throw error;
    runner("budget", true, `stopped: ${error.message}`);
    log({ agent: "runner", kind: "budget", used: budget.used() });
  } finally {
    await browser.close();
  }

  // ── Indexer = chain, after two cycles ──
  await runIndexChecks(indexChecks, chain, (agent, step, ok, detail, path) =>
    recordFor({ name: agent, persona: member(crew, agent).persona }, "indexed")(step, ok, detail, { path }))
    .catch((e: unknown) => runner("index checks", false, message(e), { report: false }));

  // ── Reports ──
  try {
    const r = await fileReports(bugs, { token: reportToken, repo: process.env.AGENTS_REPORT_REPO, ctx: { runUrl, imageSha, secrets } });
    if (bugs.length > 0) {
      say(`::notice title=reports::${r.created.length} new issue(s) ${r.created.map((n) => `#${n}`).join(" ")}; ${r.commented.length} sighting(s) ${r.commented.map((n) => `#${n}`).join(" ")}${r.skipped.length ? `; ${r.skipped.length} not filed` : ""}`);
    }
    log({ agent: "runner", kind: "info", reports: r });
  } catch (error) {
    // A reporting failure must not hide the run's own result.
    say(`::warning title=reports::${message(error)}`);
  }
  try {
    const h = await fileHolds(holds, { token: reportToken, repo: process.env.AGENTS_REPORT_REPO, ctx: { runUrl, imageSha, secrets } });
    if (holds.length > 0) say(`::notice title=holds::${holds.length} held; new issue(s) ${h.created.map((n) => `#${n}`).join(" ") || "none"}; already open or not filed ${h.skipped.length}`);
    log({ agent: "runner", kind: "info", holds: h });
  } catch (error) {
    say(`::warning title=holds::${message(error)}`);
  }
  log({ agent: "runner", kind: "budget", used: budget.used() });
  return finish(results, observations, budget.used(), imageSha);
}

/** Not cut here: `record` redacts the whole text first, then cuts it. */
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const safePath = (url: string) => { try { return new URL(url).pathname; } catch { return undefined; } };

async function webVersion(): Promise<string> {
  try {
    const res = await fetch(`${TESTNET_ORIGIN}/api/health`, { signal: AbortSignal.timeout(15_000) });
    const body = (await res.json()) as { sha?: string };
    return typeof body.sha === "string" ? body.sha.slice(0, 40) : "unknown";
  } catch {
    return "unknown";
  }
}

/** A few numbers for the dispatcher — nothing personal, nothing secret. */
async function summarize(chain: Chain, crew: CrewMember[]): Promise<TestnetSummary> {
  const live = await liveCampaigns().catch(() => []);
  const poolPage = await fetch(`${TESTNET_ORIGIN}/en/emergency-pool`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.text()).catch(() => "");
  const balances: TestnetSummary["balances"] = {};
  for (const m of crew.filter((c) => c.persona !== "treasury" && c.persona !== "staff")) {
    const [pol, usdc] = await Promise.all([
      chain.client.getBalance({ address: m.address }),
      chain.client.readContract({ address: chain.usdc, abi: erc20Abi, functionName: "balanceOf", args: [m.address] }),
    ]);
    balances[m.name] = { pol: formatUnits(pol, 18).slice(0, 6), usdc: formatUnits(usdc, 6) };
  }
  return { liveCampaigns: live.length, subPools: (poolPage.match(/Give to this pool/g) ?? []).length, balances, openReports: 0 };
}

async function topUp(
  chain: Chain, crew: CrewMember[], who: CrewMember[], rpcUrl: string,
  record: (step: string, ok: boolean, detail: string, extra?: { report?: boolean }) => void,
  log: (e: LogEvent) => void,
  budget: ReturnType<typeof createBudget>
) {
  if (who.length === 0) return;
  const treasury = member(crew, "treasury");
  const balance = async (m: CrewMember) => ({
    name: m.name, address: m.address,
    pol: await chain.client.getBalance({ address: m.address }),
    usdc: await chain.client.readContract({ address: chain.usdc, abi: erc20Abi, functionName: "balanceOf", args: [m.address] }),
  });
  const plan = planTopUps(await balance(treasury), await Promise.all(who.map(balance)), LEVELS);
  if (!plan.ok) {
    record("top-up", false, `treasury ${treasury.address} short by ${formatUnits(plan.shortfall.pol, 18)} POL / ${formatUnits(plan.shortfall.usdc, 6)} USDC`, { report: false });
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
    budget.spend("transactions");
    const hash = await send(tx);
    await chain.client.waitForTransactionReceipt({ hash, timeout: 180_000 });
    log({ agent: "treasury", kind: "tx", what: `top-up ${t.asset} → ${t.name}`, hash });
  }
  record("top-up", true, plan.transfers.length === 0 ? "nothing needed" : `${plan.transfers.length} transfer(s) for ${who.map((m) => m.name).join(", ")}`);
}

function finish(results: Result[], observations: { agent: string; task: string; remarks: string[] }[], used: Record<string, number>, imageSha: string): number {
  const failed = results.filter((r) => !r.ok);
  const cell = (s: string) => s.replace(/\|/g, "/").replace(/[\r\n]+/g, " ");
  const lines = [
    "## Testnet agents — run", "", `Web version: \`${imageSha}\` · budget used: ${Object.entries(used).map(([k, v]) => `${k} ${v}`).join(", ")}`, "",
    "| Agent | Step | Result | Detail |", "|---|---|---|---|",
    ...results.map((r) => `| ${r.agent} | ${cell(r.step)} | ${r.ok ? "✓" : "✗"} | ${cell(r.detail)} |`),
  ];
  if (observations.length > 0) {
    lines.push("", "### Observations (not bugs)", "");
    // Model text: no links, images or markup in the summary.
    for (const o of observations) for (const r of o.remarks) lines.push(`- **${o.agent}** (${o.task}): ${cell(r).replace(/[[\]()!<>`*_#]/g, "")}`);
  }
  writeFileSync(join(OUT, "summary.md"), `${lines.join("\n")}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  for (const agent of [...new Set(results.map((r) => r.agent))]) {
    const mine = results.filter((r) => r.agent === agent);
    say(`::notice title=${agent}::${mine.map((r) => `${r.ok ? "✓" : "✗"} ${r.step}: ${cell(r.detail).slice(0, 120)}`).join(" · ").slice(0, 900)}`);
  }
  if (observations.length > 0) {
    say(`::notice title=observations::${observations.flatMap((o) => o.remarks.map((r) => `${o.agent}: ${cell(r)}`)).join(" · ").slice(0, 900)}`);
  }
  // Each step was already printed as an annotation when it was recorded.
  say(`${results.length - failed.length} of ${results.length} step(s) passed`);
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const msg = String(redact(error instanceof Error ? error.message : "failed", undefined, ALL_SECRETS()));
    say(`::error title=run::${msg.replace(/[\r\n]+/g, " ").slice(0, 400)}`);
    process.exitCode = 1;
  }
);
// A stray rejection (e.g. inside a page event handler) must still be reported, not end the run silently.
process.on("unhandledRejection", (reason) => {
  const msg = String(redact(reason instanceof Error ? reason.message : String(reason), undefined, ALL_SECRETS()));
  say(`::error title=unhandled::${msg.replace(/[\r\n]+/g, " ").slice(0, 400)}`);
  process.exitCode = 1;
});
