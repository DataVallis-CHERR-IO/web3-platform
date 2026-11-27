/**
 * apps/agents/src/reports.ts — bug reports as GitHub Issues (TASK-061d, ADR-063).
 *
 * Every hard failure of a run becomes one issue in the PRIVATE reports
 * repository (`AGENTS_REPORT_REPO`, token `AGENTS_REPORT_TOKEN`: Issues
 * read/write on that repository only). The same failure seen again — another
 * run, another donor — adds a comment to the open issue instead of a new one:
 * the fingerprint ignores amounts, addresses and hashes.
 *
 * Bodies are redacted like the run log (no key, no RPC URL), and contain only
 * what the run itself saw.
 */
import { createHash } from "node:crypto";
import { redact } from "./runlog.js";

export interface Bug {
  flow: string;
  agent: string;
  persona: string;
  step: string;
  detail: string;
  /** Page the agent was on, if any. */
  path?: string;
  txHashes?: string[];
}

export const REPORT_LABEL = "agent-report";
/** At most this many NEW issues and this many comments per run; the rest go into the run summary only. */
export const MAX_NEW_ISSUES = 10;
export const MAX_COMMENTS = 10;
/** Open reports read for de-duplication (pages of 100). */
export const MAX_OPEN_PAGES = 3;

/**
 * Text from pages and errors goes into Markdown: no backticks (so it cannot leave
 * its code block), no @mentions (nobody gets pinged), no HTML comment that could
 * forge a fingerprint marker.
 */
export function neutral(text: string): string {
  return text.replace(/`/g, "'").replace(/@/g, "@\u200b").replace(/<!--/g, "<!—");
}

/** Lower-case, numbers/addresses/hashes removed: "donated 1.09 → 2.19" and "donated 3 → 4" are the same bug. */
export function normalizeDetail(detail: string): string {
  return detail
    .toLowerCase()
    .replace(/0x[0-9a-f]{6,}/g, "⟨hex⟩")
    .replace(/\d+([.,]\d+)*/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/** Same flow + step + persona + normalised detail → same fingerprint (16 hex). */
export function fingerprint(bug: Pick<Bug, "flow" | "step" | "persona" | "detail">): string {
  return createHash("sha256")
    .update(`${bug.flow}|${bug.step}|${bug.persona}|${normalizeDetail(bug.detail)}`)
    .digest("hex")
    .slice(0, 16);
}

export const marker = (fp: string) => `<!-- agent-fingerprint: ${fp} -->`;

export interface ReportContext {
  runUrl: string;
  /** Deployed web version from https://testnet.cherr.io/api/health. */
  imageSha: string;
  secrets: readonly string[];
}

export function issueTitle(bug: Bug, secrets: readonly string[] = []): string {
  const detail = neutral(String(redact(bug.detail, undefined, secrets))).replace(/\s+/g, " ");
  return `[agent] ${bug.flow} / ${bug.step}: ${detail.slice(0, 90)}`;
}

export function issueBody(bug: Bug, ctx: ReportContext, fp = fingerprint(bug)): string {
  const clean = (s: string) => neutral(String(redact(s, undefined, ctx.secrets))).replace(/\|/g, "/");
  const lines = [
    marker(fp),
    `**Agent:** ${bug.agent} (${bug.persona}) · **Flow:** ${bug.flow} · **Step:** ${bug.step}`,
    "",
    "```",
    clean(bug.detail).slice(0, 2_000),
    "```",
    "",
    `- Run: ${ctx.runUrl} (run log, screenshots and Playwright trace are the run's artifact)`,
    `- Web version on the testnet: \`${clean(ctx.imageSha)}\``,
  ];
  if (bug.path) lines.push(`- Page: https://testnet.cherr.io${clean(bug.path)}`);
  for (const h of bug.txHashes ?? []) lines.push(`- Transaction: https://amoy.polygonscan.com/tx/${h}`);
  lines.push(`- Fingerprint: \`${fp}\``);
  return lines.join("\n");
}

export function sightingComment(bug: Bug, ctx: ReportContext): string {
  const clean = (s: string) => neutral(String(redact(s, undefined, ctx.secrets)));
  return `Seen again by ${bug.agent} in ${ctx.runUrl} (web \`${clean(ctx.imageSha)}\`):\n\n\`\`\`\n${clean(bug.detail).slice(0, 1_000)}\n\`\`\``;
}

export interface ReportResult { created: number[]; commented: number[]; skipped: string[] }

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Files the bugs of one run. One list call per run finds the open issues and
 * their fingerprints; then one new issue or one comment per distinct
 * fingerprint. Without a token or repository nothing is sent.
 */
export async function fileReports(
  bugs: readonly Bug[],
  opts: { token?: string; repo?: string; ctx: ReportContext; fetch?: Fetch }
): Promise<ReportResult> {
  const result: ReportResult = { created: [], commented: [], skipped: [] };
  const unique = new Map<string, Bug>();
  for (const b of bugs) if (!unique.has(fingerprint(b))) unique.set(fingerprint(b), b);
  if (unique.size === 0) return result;
  if (!opts.token || !opts.repo || !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) {
    result.skipped.push(...unique.keys());
    return result;
  }
  const f = opts.fetch ?? fetch;
  const api = (path: string, init: RequestInit = {}) =>
    f(`https://api.github.com/repos/${opts.repo}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${opts.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });

  const open: { number: number; body?: string | null; pull_request?: unknown }[] = [];
  for (let pageNo = 1; pageNo <= MAX_OPEN_PAGES; pageNo++) {
    const res = await api(`/issues?labels=${REPORT_LABEL}&state=open&per_page=100&page=${pageNo}`);
    if (!res.ok) throw new Error(`reports: listing issues answered ${res.status}`);
    const batch = (await res.json()) as typeof open;
    open.push(...batch);
    if (batch.length < 100) break;
  }
  const byFp = new Map<string, number>();
  for (const issue of open) {
    if (issue.pull_request) continue;
    const m = /<!-- agent-fingerprint: ([0-9a-f]{16}) -->/.exec(issue.body ?? "");
    if (m) byFp.set(m[1]!, issue.number);
  }

  for (const [fp, bug] of unique) {
    const existing = byFp.get(fp);
    if (existing !== undefined) {
      if (result.commented.length >= MAX_COMMENTS) {
        result.skipped.push(fp);
        continue;
      }
      const r = await api(`/issues/${existing}/comments`, { method: "POST", body: JSON.stringify({ body: sightingComment(bug, opts.ctx) }) });
      if (!r.ok) throw new Error(`reports: comment on #${existing} answered ${r.status}`);
      result.commented.push(existing);
      continue;
    }
    if (result.created.length >= MAX_NEW_ISSUES) {
      result.skipped.push(fp);
      continue;
    }
    const r = await api("/issues", {
      method: "POST",
      body: JSON.stringify({ title: issueTitle(bug, opts.ctx.secrets), body: issueBody(bug, opts.ctx, fp), labels: [REPORT_LABEL] }),
    });
    if (!r.ok) throw new Error(`reports: creating an issue answered ${r.status}`);
    result.created.push(((await r.json()) as { number: number }).number);
  }
  return result;
}

// ── Held submissions (TASK-061e part 2) ──────────────────────────────────────

export const HOLD_LABEL = "agent-hold";

export interface Hold {
  /** "organisation" now; "campaign" with the campaign review. */
  kind: "organisation" | "campaign";
  id: string;
  name: string;
  /** Admin page, e.g. /en/admin/kyb/<id>. */
  path: string;
  reasons: string[];
}

export const holdMarker = (h: Pick<Hold, "kind" | "id">) => `<!-- agent-hold: ${h.kind}:${h.id} -->`;

export function holdBody(h: Hold, ctx: ReportContext): string {
  // Reasons can be model text: no Markdown links or images (an image would load in David's mail client).
  const clean = (s: string) => neutral(String(redact(s, undefined, ctx.secrets))).replace(/[\r\n]+/g, " ").replace(/[[\]()!<>]/g, "");
  return [
    holdMarker(h),
    `The staff agent did **not** approve this ${h.kind}. It waits for a person in the admin queue.`,
    "",
    `- Admin page: https://testnet.cherr.io${clean(h.path)}`,
    `- Run: ${ctx.runUrl}`,
    "",
    "**Why it was held:**",
    ...h.reasons.map((r) => `- ${clean(r).slice(0, 300)}`),
  ].join("\n");
}

/**
 * One open `agent-hold` issue per held submission (GitHub e-mails David). A
 * submission already held in an open issue is not reported again. Without a
 * token or repository nothing is sent and the holds are only in the summary.
 */
export async function fileHolds(
  holds: readonly Hold[],
  opts: { token?: string; repo?: string; ctx: ReportContext; fetch?: Fetch }
): Promise<ReportResult> {
  const result: ReportResult = { created: [], commented: [], skipped: [] };
  if (holds.length === 0) return result;
  if (!opts.token || !opts.repo || !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) {
    result.skipped.push(...holds.map((h) => `${h.kind}:${h.id}`));
    return result;
  }
  const f = opts.fetch ?? fetch;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${opts.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const list = await f(`https://api.github.com/repos/${opts.repo}/issues?labels=${HOLD_LABEL}&state=open&per_page=100`, { headers, signal: AbortSignal.timeout(20_000) });
  if (!list.ok) throw new Error(`holds: listing issues answered ${list.status}`);
  const open = ((await list.json()) as { body?: string | null }[]).map((i) => i.body ?? "");
  for (const h of holds.slice(0, MAX_NEW_ISSUES)) {
    if (open.some((b) => b.includes(holdMarker(h)))) {
      result.skipped.push(`${h.kind}:${h.id}`);
      continue;
    }
    const title = `[agent-hold] ${h.kind}: ${neutral(String(redact(h.name, undefined, opts.ctx.secrets))).replace(/\s+/g, " ").slice(0, 90)}`;
    const r = await f(`https://api.github.com/repos/${opts.repo}/issues`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ title, body: holdBody(h, opts.ctx), labels: [HOLD_LABEL] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`holds: creating an issue answered ${r.status}`);
    result.created.push(((await r.json()) as { number: number }).number);
  }
  return result;
}

// ── Crew diary (TASK-061f) ───────────────────────────────────────────────────

export const DIARY_LABEL = "agent-diary";

export interface DiaryIssue { title: string; body: string; xDraft: string }

export function diaryIssueBody(d: DiaryIssue, ctx: ReportContext): string {
  const clean = (s: string) => neutral(String(redact(s, undefined, ctx.secrets))).replace(/[[\]()!<>]/g, "");
  return [
    clean(d.body),
    "",
    "**X draft** (David approves and posts it himself):",
    "",
    "```",
    clean(d.xDraft),
    "```",
    "",
    `- Run: ${ctx.runUrl}`,
  ].join("\n");
}

/**
 * Files the diary of one run as ONE issue labelled `agent-diary` (same repository
 * and token as the bug reports). Returns the issue number, or null when there is
 * no token or repository (nothing is sent).
 */
export async function fileDiary(
  diary: DiaryIssue,
  opts: { token?: string; repo?: string; ctx: ReportContext; fetch?: Fetch }
): Promise<number | null> {
  if (!opts.token || !opts.repo || !/^[\w.-]+\/[\w.-]+$/.test(opts.repo)) return null;
  const title = `[agent-diary] ${neutral(String(redact(diary.title, undefined, opts.ctx.secrets))).replace(/\s+/g, " ").slice(0, 90)}`;
  const r = await (opts.fetch ?? fetch)(`https://api.github.com/repos/${opts.repo}/issues`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${opts.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title, body: diaryIssueBody(diary, opts.ctx), labels: [DIARY_LABEL] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`diary: creating an issue answered ${r.status}`);
  return ((await r.json()) as { number: number }).number;
}
