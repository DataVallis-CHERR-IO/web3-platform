/**
 * apps/agents/src/observe.ts — soft observations (TASK-061d).
 *
 * After a task, the task's tier model reads the visible text of the page and
 * may name up to three things a first-time user would stumble over (wording,
 * missing explanation, confusing order). These are NOT bugs: they go into the
 * run summary and the run log, never into an issue, and never change what the
 * runner does next. A failing call just means no observations.
 */
import { ask, firstJson, type Budget } from "./llm.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const MAX_PAGE_CHARS = 6_000;

const SYSTEM = `You are a first-time visitor of a charity donation website (a test network).
You get the visible text of one page and what you just tried to do.
Answer with ONLY a JSON array of at most 3 short strings (each under 160 characters):
things that confused you or could be clearer. Answer [] if nothing did.
Do not invent features; do not comment on the test network itself.`;

export async function observe(
  input: { model: string | null; task: string; pageText: string },
  opts: { apiKey?: string; budget: Budget; fetch?: Fetch }
): Promise<string[]> {
  if (!input.model || !opts.apiKey) return [];
  try {
    const answer = await ask({
      apiKey: opts.apiKey,
      model: input.model,
      system: SYSTEM,
      user: `Task: ${input.task}\n\nPage text:\n${input.pageText.slice(0, MAX_PAGE_CHARS)}`,
      maxTokens: 300,
      budget: opts.budget,
      fetch: opts.fetch,
    });
    const value = firstJson(answer.text);
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === "string").slice(0, 3).map((v) => v.slice(0, 160));
  } catch {
    return [];
  }
}
