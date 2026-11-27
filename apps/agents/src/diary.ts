/**
 * apps/agents/src/diary.ts — the crew diary (TASK-061f, David 2026-11-27).
 *
 * At the end of a crew run the cheapest model tier ("routine") turns the run's
 * own step records into a short diary: a title, a few plain sentences and an X
 * draft. It is filed as ONE issue labelled `agent-diary` in the private reports
 * repository (reports.ts `fileDiary`); David uses it as the draft of a social
 * post and approves posts himself.
 *
 * The model sees only redacted step records. The red team (persona "redteam")
 * never reaches it: no scam text, title or pattern — only counts ("the staff
 * agent caught 1 scam attempt"). Admin-page text (names of applicants) stays out
 * too: staff steps carry their result, not their detail, except queue counts.
 * The answer is data: checked in code; anything wrong, cut off, a model error or
 * a reached budget gives a fixed fallback diary built from counts. Never fails the run.
 */
import { ask, firstJson, type Budget } from "./llm.js";
import { modelFor } from "./models.js";
import { redact } from "./runlog.js";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface DiaryStep { agent: string; persona: string; step: string; ok: boolean; detail: string }
export interface Diary { title: string; body: string; xDraft: string }
export interface DiaryCounts { steps: number; passed: number; failed: number; agents: number; caught: number; missed: number }

export const DIARY_MAX_TOKENS = 600;
export const TITLE_MAX = 80;
export const X_MAX = 280;
const INPUT_MAX_CHARS = 6_000;
const DETAIL_MAX = 140;

const LINK = /https?:|www\.|\b[a-z0-9-]+\.(?:com|io|org|net|si|dev|app|xyz|eth)\b/i;
const EMOJI = /\p{Extended_Pictographic}/u;
const FORBIDDEN = /scammer|red[\s-]?team/i;

/** Links, e-mail addresses, hashes and addresses never go to the model. */
function scrub(text: string, secrets: readonly string[]): string {
  return String(redact(text, undefined, secrets))
    .replace(/https?:\/\/\S+/gi, "[link]")
    .replace(/[^\s@]+@[^\s@]+/g, "[email]")
    .replace(/\b0x[0-9a-fA-F]{6,}\b/g, "[hash]")
    .replace(/\s+/g, " ")
    .trim();
}

/** Counts and the model's input, from the run's own step records. */
export function diaryInput(steps: readonly DiaryStep[], secrets: readonly string[] = []): { text: string; counts: DiaryCounts } {
  // The red team's own steps are left out whole; its catches are counted from the staff agent's "red team" steps.
  const visible = steps.filter((s) => s.persona !== "redteam");
  let caught = 0;
  let missed = 0;
  const lines: string[] = [];
  for (const s of visible) {
    if (s.step === "red team") {
      if (s.ok && s.detail.startsWith("caught")) caught++;
      else if (!s.ok && /^MISSED/i.test(s.detail)) missed++;
      continue;
    }
    // Staff steps name admin-page content (applicants): only the queue counts are kept.
    const keepDetail = s.persona !== "staff" || s.step.endsWith("queue");
    const detail = keepDetail ? scrub(s.detail.replace(/;?\s*red team: \d+ caught, \d+ missed/g, ""), secrets).slice(0, DETAIL_MAX) : "";
    lines.push(`${s.ok ? "✓" : "✗"} ${s.agent} (${s.persona}) · ${scrub(s.step, secrets)}${detail ? `: ${detail}` : ""}`);
  }
  const passed = visible.filter((s) => s.step !== "red team" && s.ok).length;
  const total = visible.filter((s) => s.step !== "red team").length;
  const counts: DiaryCounts = {
    steps: total, passed, failed: total - passed, caught, missed,
    agents: new Set(visible.filter((s) => s.persona !== "runner").map((s) => s.agent)).size,
  };
  if (caught + missed > 0) lines.push(`Scam attempts caught by the staff agent: ${caught}; missed: ${missed}`);
  let text = lines.join("\n");
  if (text.length > INPUT_MAX_CHARS) text = `${text.slice(0, INPUT_MAX_CHARS)}\n… (cut)`;
  return { text, counts };
}

const SYSTEM = `You write the daily diary of a team of AI test agents on a charity donation website (a test network).
You get the list of what each agent did in today's run (✓ = worked, ✗ = failed).
Answer with ONLY a JSON object: {"title": "...", "body": "...", "xDraft": "..."}
- title: one line, at most 80 characters.
- body: 3 to 6 short sentences in plain English, written as a diary of the day.
- xDraft: a draft for a social post, at most 280 characters.
Rules: use only facts that are in the list; do not invent anything; no hashtags, no emojis, no links, no e-mail addresses, no @names.
Never describe how any scam attempt looked; you may only say how many were caught.`;

const numbersIn = (s: string) => new Set(s.match(/\d+(?:[.,]\d+)?/g) ?? []);

/** The answer as a Diary, or a short reason why it is not acceptable. */
export function validateDiary(raw: unknown, inputText = ""): { ok: true; diary: Diary } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "not an object" };
  const { title, body, xDraft } = raw as Record<string, unknown>;
  if (typeof title !== "string" || typeof body !== "string" || typeof xDraft !== "string") return { ok: false, reason: "a field is missing" };
  const t = title.trim();
  const b = body.trim();
  const x = xDraft.trim();
  if (t.length === 0 || t.length > TITLE_MAX) return { ok: false, reason: `title is not 1–${TITLE_MAX} characters` };
  if (/[\r\n]/.test(t)) return { ok: false, reason: "title is not a single line" };
  const sentences = b.split(/[.!?]+(?:\s+|$)/).filter((s) => s.trim().length > 0);
  if (sentences.length < 3 || sentences.length > 6) return { ok: false, reason: `body has ${sentences.length} sentences` };
  if (x.length === 0 || x.length > X_MAX) return { ok: false, reason: `X draft is not 1–${X_MAX} characters` };
  const all = `${t}\n${b}\n${x}`;
  if (LINK.test(all)) return { ok: false, reason: "contains a link" };
  if (/@/.test(all)) return { ok: false, reason: "contains an e-mail address or a mention" };
  if (/#/.test(all)) return { ok: false, reason: "contains a hashtag" };
  if (EMOJI.test(all)) return { ok: false, reason: "contains an emoji" };
  if (FORBIDDEN.test(all)) return { ok: false, reason: "names the red team" };
  const known = numbersIn(inputText);
  for (const n of numbersIn(all)) if (!known.has(n)) return { ok: false, reason: `a number (${n}) is not in the input` };
  return { ok: true, diary: { title: t, body: b, xDraft: x } };
}

/** Built from counts only; always passes `validateDiary`. */
export function fallbackDiary(counts: DiaryCounts, date: string): Diary {
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const sentences = [
    `${plural(counts.agents, "agent")} took part in today's run.`,
    `They recorded ${plural(counts.steps, "step")} and ${counts.passed} worked.`,
    counts.failed === 0 ? "No step failed." : `${plural(counts.failed, "step")} failed and went to the bug reports.`,
  ];
  if (counts.caught > 0) sentences.push(`The staff agent caught ${plural(counts.caught, "scam attempt")}.`);
  if (counts.missed > 0) sentences.push(`The staff agent missed ${plural(counts.missed, "scam attempt")}, which was reported as a bug.`);
  const body = sentences.join(" ");
  return {
    title: `Crew diary ${date}: ${counts.passed} of ${counts.steps} steps worked`,
    body,
    xDraft: `Testnet crew, ${date}: ${counts.passed} of ${counts.steps} steps worked${counts.caught > 0 ? `, ${plural(counts.caught, "scam attempt")} caught` : ""}.`.slice(0, X_MAX),
  };
}

export interface DiaryResult { diary: Diary; source: "model" | "fallback"; reason?: string }

/** Never throws: any problem gives the fallback diary. */
export async function writeDiary(
  steps: readonly DiaryStep[],
  opts: { apiKey?: string; budget: Budget; secrets?: readonly string[]; date: string; fetch?: Fetch; model?: string | null }
): Promise<DiaryResult> {
  const { text, counts } = diaryInput(steps, opts.secrets);
  const fallback = (reason: string): DiaryResult => ({ diary: fallbackDiary(counts, opts.date), source: "fallback", reason });
  const model = opts.model === undefined ? modelFor("routine") : opts.model;
  if (!opts.apiKey || !model) return fallback("no model key");
  try {
    const answer = await ask({
      apiKey: opts.apiKey, model, system: SYSTEM, user: `Date: ${opts.date}\n\nSteps of today's run:\n${text}`,
      maxTokens: DIARY_MAX_TOKENS, budget: opts.budget, fetch: opts.fetch,
    });
    if (answer.stopReason === "max_tokens") return fallback(`answer cut off at the output limit (${DIARY_MAX_TOKENS} tokens)`);
    const checked = validateDiary(firstJson(answer.text), `${text}\n${opts.date}`);
    return checked.ok ? { diary: checked.diary, source: "model" } : fallback(`answer rejected: ${checked.reason}`);
  } catch (error) {
    // BudgetExceeded included: the diary never ends the run.
    return fallback(error instanceof Error ? error.message.slice(0, 120) : "failed");
  }
}
