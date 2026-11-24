/**
 * apps/agents/src/models.ts
 * Who thinks with which model (David 2026-11-24: "glavni opus 5.5 pa da
 * razporeja naloge in sam izbira agente … da varčujemo kredite").
 *
 * One dispatcher on the strongest model plans a run from a SHORT summary of
 * the testnet and hands each task to the cheapest tier that can do it. It
 * never drives a browser. Fixed steps (sign-in, top-ups, publishing) use no
 * model at all. Every id can be changed with an environment variable.
 */
export type Tier = "dispatcher" | "explore" | "routine" | "review" | "none";

const DEFAULT_MODELS: Record<Exclude<Tier, "none">, string> = {
  dispatcher: "claude-opus-5-5",
  explore: "claude-sonnet-5-5",
  review: "claude-sonnet-5-5",
  routine: "claude-haiku-5-5",
};

const ENV_NAMES: Record<Exclude<Tier, "none">, string> = {
  dispatcher: "AGENT_MODEL_DISPATCHER",
  explore: "AGENT_MODEL_EXPLORE",
  review: "AGENT_MODEL_REVIEW",
  routine: "AGENT_MODEL_ROUTINE",
};

export function modelFor(tier: Tier, env: Record<string, string | undefined> = process.env): string | null {
  if (tier === "none") return null;
  return env[ENV_NAMES[tier]]?.trim() || DEFAULT_MODELS[tier];
}

/** The kinds of work the dispatcher can hand out, and the tier each one runs on. */
export const TASK_TIERS = {
  "sign-in": "none",
  "top-up": "none",
  "publish-campaign": "none",
  "set-payout-mode": "none",
  donate: "routine",
  vote: "routine",
  rate: "routine",
  "pool-give": "routine",
  "share-check": "routine",
  "start-organisation": "explore",
  "start-campaign": "explore",
  "submit-evidence": "explore",
  "awkward-use": "explore",
  "review-submission": "review",
} as const satisfies Record<string, Tier>;

export type TaskKind = keyof typeof TASK_TIERS;

export interface Assignment { task: TaskKind; agent: string; tier?: Tier; note?: string }
export interface Placed { task: TaskKind; agent: string; tier: Tier; model: string | null; note?: string }

/**
 * Checks a plan returned by the dispatcher. The dispatcher may move a task to
 * a CHEAPER tier or keep the default; it may not move work up to its own
 * model, give a model to a fixed step, or invent tasks and agents. A plan that
 * breaks a rule is rejected whole — the run then uses the default plan.
 */
const COST: Record<Tier, number> = { none: 0, routine: 1, explore: 2, review: 2, dispatcher: 3 };

export function placeAssignments(plan: unknown, agents: readonly string[], env: Record<string, string | undefined> = process.env): Placed[] {
  if (!Array.isArray(plan)) throw new Error("plan is not a list");
  if (plan.length > 40) throw new Error("plan is too long");
  return plan.map((raw: Assignment, i) => {
    if (!raw || typeof raw !== "object") throw new Error(`plan[${i}] is not an assignment`);
    if (!Object.hasOwn(TASK_TIERS, raw.task)) throw new Error(`plan[${i}]: unknown task`);
    if (!agents.includes(raw.agent)) throw new Error(`plan[${i}]: unknown agent`);
    const base: Tier = TASK_TIERS[raw.task];
    const tier = raw.tier ?? base;
    if (!Object.hasOwn(COST, tier)) throw new Error(`plan[${i}]: unknown tier`);
    if (tier === "dispatcher") throw new Error(`plan[${i}]: work cannot run on the dispatcher's model`);
    if (base === "none" && tier !== "none") throw new Error(`plan[${i}]: a fixed step takes no model`);
    if (base === "review" && tier !== "review") throw new Error(`plan[${i}]: the review tier cannot be changed`);
    if (COST[tier] > COST[base]) throw new Error(`plan[${i}]: a task can only move to a cheaper tier`);
    if (base !== "none" && tier === "none") throw new Error(`plan[${i}]: this task needs a model`);
    return { task: raw.task, agent: raw.agent, tier, model: modelFor(tier, env), note: typeof raw.note === "string" ? raw.note.slice(0, 200) : undefined };
  });
}
