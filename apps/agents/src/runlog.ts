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

export function redact(value: unknown, key?: string): unknown {
  if (typeof value === "string") {
    if (key && HASH_KEYS.has(key)) return value;
    return value.replace(PRIVATE_KEY, "[redacted]").replace(SEED_PHRASE, "[redacted]");
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

export interface LogEvent {
  agent: string;
  kind: "step" | "tx" | "refused" | "bug" | "observation" | "budget" | "info";
  [key: string]: unknown;
}

export function createRunLog(file: string, runId: string, now: () => Date = () => new Date()) {
  return function log(event: LogEvent): void {
    const line = JSON.stringify(redact({ at: now().toISOString(), run: runId, ...event }));
    appendFileSync(file, `${line}\n`);
  };
}
