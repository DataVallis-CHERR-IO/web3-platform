/**
 * apps/agents/src/dispatcher.ts — the run plan (TASK-061d).
 *
 * The dispatcher (strongest model) reads a SHORT summary of the testnet and
 * picks which crew member does which task, on the cheapest tier that can do
 * it. It never drives a browser and its plan is checked twice: by
 * `placeAssignments` (tiers, known tasks and agents) and here (only tasks the
 * runner implements, each by a persona allowed to do it, at most N per run).
 * Any failure — no key, budget, HTTP error, bad JSON, a broken rule — falls
 * back to the fixed default plan, and the reason is logged.
 */
import { CREW } from "./crew.js";
import { ask, firstJson, type Budget } from "./llm.js";
import { modelFor, placeAssignments, type Placed, type TaskKind } from "./models.js";
import type { Persona } from "./crew.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** What the runner can execute today, and who may do it. */
export const RUNNABLE: Partial<Record<TaskKind, readonly Persona[]>> = {
  donate: ["donor"],
  "pool-give": ["pool"],
  "share-check": ["donor"],
  "awkward-use": ["awkward"],
  "start-organisation": ["fundraiser", "redteam"],
  "start-campaign": ["fundraiser"],
  "review-submission": ["staff"],
  "scam-campaign": ["redteam"],
};

export const MAX_TASKS_PER_RUN = 11;

/**
 * Output limit of the dispatcher's answer. 800 cut a nine-task plan off in run
 * 45976097377 ("unterminated JSON"); nine assignments with short notes need
 * about 600 tokens, so 2,000 leaves room without raising the run's cost much
 * (the budget charges the limit up front: 2,000 of 2,000,000 tokens).
 */
export const DISPATCHER_MAX_TOKENS = 2_000;

export const DEFAULT_PLAN = [
  { task: "donate", agent: "donor-1" },
  { task: "donate", agent: "donor-2" },
  { task: "pool-give", agent: "pool-1" },
  { task: "share-check", agent: "donor-3" },
  { task: "awkward-use", agent: "awkward-1" },
  { task: "start-organisation", agent: "fundraiser-1" },
  { task: "start-organisation", agent: "fundraiser-2" },
  // The red team needs a verified organisation first (a clean application), then tries one scam per run.
  { task: "start-organisation", agent: "scammer-1" },
  { task: "scam-campaign", agent: "scammer-1" },
  // After the applications, before start-campaign: an organisation approved now can start a campaign in the same run.
  { task: "review-submission", agent: "staff" },
  { task: "start-campaign", agent: "fundraiser-1" },
] as const;

export interface TestnetSummary {
  liveCampaigns: number;
  /** Sub-pools on the Emergency Pool page (0 = not created on chain yet). */
  subPools: number;
  /** Crew balances in whole units, for the planner to skip a member who cannot pay. */
  balances: Record<string, { pol: string; usdc: string }>;
  /** Open agent reports (to retest what failed before). */
  openReports: number;
}

/** Throws unless every assignment is runnable by its agent's persona. */
export function checkRunnable(placed: Placed[]): Placed[] {
  if (placed.length === 0) throw new Error("empty plan");
  if (placed.length > MAX_TASKS_PER_RUN) throw new Error(`plan has more than ${MAX_TASKS_PER_RUN} tasks`);
  for (const [i, p] of placed.entries()) {
    const allowed = RUNNABLE[p.task];
    if (!allowed) throw new Error(`plan[${i}]: ${p.task} is not runnable yet`);
    const persona = CREW.find((c) => c.name === p.agent)?.persona;
    if (!persona || !allowed.includes(persona)) throw new Error(`plan[${i}]: ${p.agent} cannot do ${p.task}`);
  }
  return placed;
}

export function defaultPlan(env: Record<string, string | undefined> = process.env): Placed[] {
  return checkRunnable(placeAssignments(DEFAULT_PLAN.map((a) => ({ ...a })), CREW.map((c) => c.name), env));
}

const SYSTEM = `You plan one run of a crew of test agents on a charity donation testnet.
Answer with ONLY a JSON array of assignments: [{"task": "...", "agent": "...", "tier": "...", "note": "..."}].
Rules:
- tasks and who may do them: ${Object.entries(RUNNABLE).map(([t, p]) => `${t} (${p!.join("/")})`).join(", ")};
- agents: ${CREW.filter((c) => c.persona !== "treasury").map((c) => `${c.name} (${c.persona})`).join(", ")};
- at most ${MAX_TASKS_PER_RUN} assignments; include every task once whose precondition holds, before repeating any;
- "tier" is optional: leave it out, or use "routine" to make an explore task cheaper; never "dispatcher";
- review-submission (staff) always runs once, after every start-organisation and scam-campaign and before every start-campaign;
- scammer-1 always gets start-organisation and scam-campaign (the red team: it checks itself whether it can submit);
- start-organisation and start-campaign check the fundraiser's account themselves and skip when one is already waiting, so plan them for both fundraisers;
- skip donating when there is no live campaign and pool giving when subPools is 0; low USDC is fine (the treasury tops agents up before the tasks);
- "note" is a short reason (under 60 characters);
- no text before or after the array, no code fence.`;

export interface PlanResult { plan: Placed[]; source: "dispatcher" | "default"; reason?: string }

export async function planRun(
  summary: TestnetSummary,
  opts: { apiKey?: string; budget: Budget; env?: Record<string, string | undefined>; fetch?: Fetch }
): Promise<PlanResult> {
  const env = opts.env ?? process.env;
  const fallback = (reason: string): PlanResult => ({ plan: defaultPlan(env), source: "default", reason });
  if (!opts.apiKey) return fallback("no ANTHROPIC_API_KEY");
  try {
    const answer = await ask({
      apiKey: opts.apiKey,
      model: modelFor("dispatcher", env)!,
      system: SYSTEM,
      user: `Testnet now: ${JSON.stringify(summary)}`,
      maxTokens: DISPATCHER_MAX_TOKENS,
      budget: opts.budget,
      fetch: opts.fetch,
    });
    if (answer.stopReason === "max_tokens") throw new Error(`answer cut off at the output limit (${DISPATCHER_MAX_TOKENS} tokens)`);
    const placed = placeAssignments(firstJson(answer.text), CREW.map((c) => c.name), env);
    return { plan: checkRunnable(placed), source: "dispatcher" };
  } catch (error) {
    return fallback(error instanceof Error ? error.message.slice(0, 200) : "dispatcher failed");
  }
}
