/**
 * apps/agents/src/llm.ts — the only place the runner talks to a model (TASK-061d).
 *
 * Plain HTTPS to the Anthropic Messages API (no SDK dependency). Every call is
 * charged to the run's budget BEFORE it is made (prompt size + max output), so
 * the token cap can never be passed; the real usage is logged afterwards.
 * Model answers are data: callers parse them into a fixed shape and check them.
 */
import type { createBudget } from "./budget.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type Budget = ReturnType<typeof createBudget>;

export interface AskOptions {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  budget: Budget;
  fetch?: Fetch;
  timeoutMs?: number;
}

export interface Answer { text: string; inputTokens: number; outputTokens: number }

/** A rough upper bound: about 3 characters per token for English and JSON. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 3);

export async function ask(opts: AskOptions): Promise<Answer> {
  opts.budget.spend("llmTokens", estimateTokens(opts.system) + estimateTokens(opts.user) + opts.maxTokens);
  const res = await (opts.fetch ?? fetch)("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": opts.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      system: opts.system,
      messages: [{ role: "user", content: opts.user }],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  // Never echo the response body of an error: it can quote the request.
  if (!res.ok) throw new Error(`model call answered ${res.status}`);
  const body = (await res.json()) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  return { text, inputTokens: body.usage?.input_tokens ?? 0, outputTokens: body.usage?.output_tokens ?? 0 };
}

/** The first JSON value (array or object) in a model answer, or throws. */
export function firstJson(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error("no JSON in the answer");
  const open = text[start]!;
  const close = open === "[" ? "]" : "}";
  const end = text.lastIndexOf(close);
  if (end < start) throw new Error("unterminated JSON in the answer");
  return JSON.parse(text.slice(start, end + 1));
}
