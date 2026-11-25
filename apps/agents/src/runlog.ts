/**
 * apps/agents/src/runlog.ts
 * Run log: one JSON line per event, uploaded as a workflow artifact. This is
 * the record of "which agent did what". A line never contains a key: anything
 * that looks like a private key or a seed phrase is replaced before writing.
 */
import { appendFileSync } from "node:fs";

const PRIVATE_KEY = /\b(0x)?[0-9a-fA-F]{64}\b/g;
/** Twelve or more lower-case words in a row — the shape of a seed phrase. */
const SEED_PHRASE = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g;

/** Transaction and block hashes are 32 bytes too; they are kept under these keys. */
const HASH_KEYS = new Set(["hash", "txHash", "blockHash", "bundleHash", "fingerprint"]);
/**
 * Model-written prose (soft observations) is ordinary English and would match the
 * seed-phrase shape; the exact mnemonic is always passed in `secrets`, so these
 * keys skip only the shape rule (keys and exact secrets are still removed).
 */
const PROSE_KEYS = new Set(["remarks"]);

/**
 * `secrets`: exact values to remove as well (the RPC URL carries an API key;
 * GitHub masks it in the job log but not inside an uploaded artifact).
 */
export function redact(value: unknown, key?: string, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") {
    if (key && HASH_KEYS.has(key)) return value;
    let out = value;
    for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[redacted]");
    out = out.replace(PRIVATE_KEY, "[redacted]");
    return key && PROSE_KEYS.has(key) ? out : out.replace(SEED_PHRASE, "[redacted]");
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((v) => redact(v, key && PROSE_KEYS.has(key) ? key : undefined, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k, secrets)]));
  }
  return value;
}

export interface LogEvent {
  agent: string;
  kind: "step" | "tx" | "refused" | "bug" | "observation" | "budget" | "info";
  [key: string]: unknown;
}

export function createRunLog(file: string, runId: string, secrets: readonly string[] = [], now: () => Date = () => new Date()) {
  return function log(event: LogEvent): void {
    const line = JSON.stringify(redact({ at: now().toISOString(), run: runId, ...event }, undefined, secrets));
    appendFileSync(file, `${line}\n`);
  };
}
