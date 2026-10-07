import type { Transport } from "viem";

// Client-side pacing for the backup RPC (2026-10-07). Infura's free plan has a
// per-second credit limit; Ponder sends its eth_getLogs calls together, Infura
// answers HTTP 429, and Ponder repeats each refused call up to ~9 times with
// growing waits — every repeat is a billed request (dev log 2026-10-07: one
// 120-block eth_getLogs refused 9+ times, 538 requests an hour instead of
// ~250). Pacing the requests below the limit avoids the 429s instead of paying
// for them.

/** Credits one request uses (Infura's published weights as of 2026-10; unknown methods count as 80). */
export const RPC_CREDIT_COST: Readonly<Record<string, number>> = {
  eth_getLogs: 255,
  eth_getBlockByNumber: 80,
  eth_getBlockByHash: 80,
  eth_blockNumber: 80,
  eth_call: 80,
  eth_chainId: 5,
};
const DEFAULT_COST = 80;

export function creditCost(method: string): number {
  return RPC_CREDIT_COST[method] ?? DEFAULT_COST;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * A token bucket of `creditsPerSecond` (also its size): requests start in the
 * order they arrive, each once the bucket holds its cost. One request may wait
 * for the ones before it; none is ever refused or dropped.
 */
export function creditPacer(creditsPerSecond: number, clock: Clock = realClock) {
  if (!(creditsPerSecond > 0)) throw new Error("creditsPerSecond must be positive");
  let tokens = creditsPerSecond;
  let last = clock.now();
  let tail: Promise<void> = Promise.resolve();

  const refill = () => {
    const now = clock.now();
    tokens = Math.min(creditsPerSecond, tokens + ((now - last) / 1000) * creditsPerSecond);
    last = now;
  };

  /** Resolves when a request of this cost may start. */
  return function acquire(cost: number): Promise<void> {
    const need = Math.min(cost, creditsPerSecond);
    const turn = tail.then(async () => {
      refill();
      if (tokens < need) {
        await clock.sleep(Math.ceil(((need - tokens) / creditsPerSecond) * 1000));
        refill();
      }
      tokens -= need;
    });
    tail = turn;
    return turn;
  };
}

/** Wraps a viem transport so every request waits for its credits first. */
export function paced(inner: Transport, creditsPerSecond: number, clock: Clock = realClock): Transport {
  const acquire = creditPacer(creditsPerSecond, clock); // shared by every client Ponder creates
  return (params) => {
    const transport = inner(params);
    return {
      ...transport,
      request: (async (args: { method: string }) => {
        await acquire(creditCost(args.method));
        return transport.request(args as never);
      }) as typeof transport.request,
    };
  };
}

/** INDEXER_RPC_FALLBACK_CREDITS_PER_SECOND: default 400 (under Infura's free 500/s); 0 = no pacing. */
export const DEFAULT_FALLBACK_CREDITS_PER_SECOND = 400;

export function fallbackCreditsPerSecond(env: Record<string, string | undefined> = process.env): number {
  const raw = env.INDEXER_RPC_FALLBACK_CREDITS_PER_SECOND;
  if (raw === undefined || raw === "") return DEFAULT_FALLBACK_CREDITS_PER_SECOND;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 100_000) {
    throw new Error("[Indexer] INDEXER_RPC_FALLBACK_CREDITS_PER_SECOND must be an integer between 0 and 100000");
  }
  return value;
}
