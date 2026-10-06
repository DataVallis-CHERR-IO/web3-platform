// Contract reads that survive a free-tier RPC backup (dev 2026-10-06). With
// Alchemy over its monthly cap every read goes to Infura, which limits requests
// per second and, during the first reconcile after a deploy, twice answered an
// eth_call for a view function with no data at all ("0x") — once for
// EmergencyPool.hasFundingPool, once for Campaign.state — while the same call
// made by hand a minute later returned the right value. Neither answer can come
// from our contracts at a block where they exist (every view returns ABI data),
// so both are repeated after a pause; anything else fails at once, and a read
// that keeps failing still fails the reconcile after ~31 s.

import { RATE_LIMIT_DELAYS_MS, isRateLimited } from "./batch";

interface ErrorFacts {
  status: number | undefined;
  code: unknown;
  names: string[];
  messages: string[];
}

/** The HTTP status, JSON-RPC code, class names and messages of an error and its causes (viem nests them). */
function facts(error: unknown): ErrorFacts {
  const out: ErrorFacts = { status: undefined, code: undefined, names: [], messages: [] };
  let e: unknown = error;
  for (let depth = 0; e && typeof e === "object" && depth < 10; depth++) {
    const o = e as { status?: unknown; code?: unknown; name?: unknown; message?: unknown; shortMessage?: unknown; cause?: unknown };
    if (out.status === undefined && typeof o.status === "number") out.status = o.status;
    if (out.code === undefined && o.code !== undefined) out.code = o.code;
    if (typeof o.name === "string") out.names.push(o.name);
    for (const m of [o.shortMessage, o.message]) if (typeof m === "string") out.messages.push(m);
    e = o.cause;
  }
  return out;
}

/** "0x" where a view must return data: a provider glitch, never our contracts. */
export function isEmptyResult(error: unknown): boolean {
  const f = facts(error);
  return (
    f.names.some((n) => n === "ContractFunctionZeroDataError" || n === "AbiDecodingZeroDataError") ||
    f.messages.some((m) => /returned no data \("0x"\)/.test(m))
  );
}

/** True when a read may succeed if repeated later: a rate limit or an empty result. */
export function isRetryableRead(error: unknown): boolean {
  if (isEmptyResult(error)) return true;
  const f = facts(error);
  return isRateLimited(f.status, f.code, f.messages.join(" | "));
}

export interface RetryOptions {
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: unknown, delayMs: number) => void;
}

/** Runs `fn`; on a retryable error waits delaysMs[i] and runs it again, then gives up with the last error. */
export async function withReadRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const delays = options.delaysMs ?? RATE_LIMIT_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const delay = delays[attempt];
      if (delay === undefined || !isRetryableRead(error)) throw error;
      options.onRetry?.(error, delay);
      await sleep(delay);
    }
  }
}

/** At most `max` calls in flight at once; the rest wait in order. */
export function limiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  if (!Number.isInteger(max) || max < 1) throw new Error("limiter needs a positive integer");
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    // A waiter is handed the finishing call's slot, so `active` never exceeds max.
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    else active++;
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}
