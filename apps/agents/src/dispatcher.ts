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
};

export const MAX_TASKS_PER_RUN = 8;

export const DEFAULT_PLAN = [
  { task: "donate", agent: "donor-1" },
  { task: "donate", agent: "donor-2" },
  { task: "pool-give", agent: "pool-1" },
  { task: "share-check", agent: "donor-3" },
  { task: "awkward-use", agent: "awkward-1" },
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
- agents: ${CREW.filter((c) => c.persona !== "treasury" && c.persona !== "staff").map((c) => `${c.name} (${c.persona})`).join(", ")};
- at most ${MAX_TASKS_PER_RUN} assignments; prefer covering every task once over repeating one;
- "tier" is optional: leave it out, or use "routine" to make an explore task cheaper; never "dispatcher";
- skip donating and pool giving when there is nothing to give to or the agent's USDC is below 2;
- "note" is a short reason (under 100 characters).`;

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
      maxTokens: 800,
      budget: opts.budget,
      fetch: opts.fetch,
    });
    const placed = placeAssignments(firstJson(answer.text), CREW.map((c) => c.name), env);
    return { plan: checkRunnable(placed), source: "dispatcher" };
  } catch (error) {
    return fallback(error instanceof Error ? error.message.slice(0, 200) : "dispatcher failed");
  }
}
