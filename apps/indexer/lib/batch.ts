// Batch mode (ADR-055, TASK-048): instead of following every block (Ponder's
// realtime sync fetches each block and, on busy chains, its logs — ~70–80
// Alchemy CU per block, ~3.5–4.5 M CU a day on Amoy whatever happens on our
// contracts), the indexer catches up in cycles: `ponder start` with an end
// block a finality depth behind the head, which Ponder fetches with ranged
// eth_getLogs (~900 CU per cycle, measured), then it is stopped until the next
// cycle. The same schema is resumed every time (Ponder's crash recovery).

type Env = Record<string, string | undefined>;

export const INDEXER_MODES = ["realtime", "batch"] as const;
export type IndexerMode = (typeof INDEXER_MODES)[number];

/** INDEXER_MODE: unset = realtime (prod default); anything unknown stops the indexer. */
export function indexerMode(env: Env = process.env): IndexerMode {
  const raw = env.INDEXER_MODE;
  if (raw === undefined || raw === "") return "realtime";
  if ((INDEXER_MODES as readonly string[]).includes(raw)) return raw as IndexerMode;
  throw new Error(`[Indexer] INDEXER_MODE must be one of ${INDEXER_MODES.join(", ")}`);
}

export const DEFAULT_BATCH_INTERVAL_SECONDS = 120;
export const MIN_BATCH_INTERVAL_SECONDS = 5;
export const MAX_BATCH_INTERVAL_SECONDS = 900;

/** INDEXER_BATCH_INTERVAL_SECONDS: pause between cycles (default 120 s; 5–900). */
export function batchIntervalSeconds(env: Env = process.env): number {
  const raw = env.INDEXER_BATCH_INTERVAL_SECONDS;
  if (raw === undefined || raw === "") return DEFAULT_BATCH_INTERVAL_SECONDS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_BATCH_INTERVAL_SECONDS || value > MAX_BATCH_INTERVAL_SECONDS) {
    throw new Error(
      `[Indexer] INDEXER_BATCH_INTERVAL_SECONDS must be an integer between ${MIN_BATCH_INTERVAL_SECONDS} and ${MAX_BATCH_INTERVAL_SECONDS}`
    );
  }
  return value;
}

/**
 * Blocks Ponder treats as not final (ponder/dist/esm/utils/finality.js,
 * Ponder 0.17): Polygon PoS mainnet 200, Ethereum 65, everything else —
 * Amoy (80002) included — 30. A cycle ends exactly there, so all of it is
 * fetched as ranged backfill and never block by block.
 */
export function finalityBlocks(chainId: number): number {
  if (chainId === 137 || chainId === 80001) return 200;
  if ([1, 3, 4, 5, 42, 11155111].includes(chainId)) return 65;
  if ([42161, 42170, 421611, 421613].includes(chainId)) return 240;
  return 30;
}

/** The end block of the next cycle; null when there is nothing new since `previous`. */
export function nextEndBlock(head: bigint, chainId: number, previous: bigint | null): bigint | null {
  const end = head - BigInt(finalityBlocks(chainId));
  if (end < 0n) return null;
  if (previous !== null && end <= previous) return null;
  return end;
}

/** INDEXER_END_BLOCK (set by the batch runner for each cycle): a non-negative integer, or unset. */
export function endBlockFromEnv(env: Env = process.env): number | undefined {
  const raw = env.INDEXER_END_BLOCK;
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("[Indexer] INDEXER_END_BLOCK must be a non-negative integer");
  }
  return value;
}

/** The block a Ponder `/status` answer says it has indexed for our chain ("cherrio"), or -1. */
export function indexedBlockFromStatus(status: unknown): number {
  const n = (status as { cherrio?: { block?: { number?: unknown } } } | null)?.cherrio?.block?.number;
  return typeof n === "number" ? n : -1;
}

/**
 * Widest eth_getLogs block range the indexer asks for — the runner's factory
 * scan and Ponder's backfill (`ethGetLogsBlockRange`). 10,000 is Infura's limit
 * ("range 49999 exceeds limit of 10000", dev log 2026-10-06), a message
 * Ponder 0.17's range helper does not recognise; Alchemy accepts it too.
 * INDEXER_GETLOGS_RANGE overrides it (100–100,000) for a provider with a
 * smaller limit and for the scenario test.
 */
export const DEFAULT_GETLOGS_RANGE = 10_000;
export const FACTORY_SCAN_RANGE = BigInt(DEFAULT_GETLOGS_RANGE);

export function getLogsRange(env: Env = process.env): number {
  const raw = env.INDEXER_GETLOGS_RANGE;
  if (raw === undefined || raw === "") return DEFAULT_GETLOGS_RANGE;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 100 || value > 100_000) {
    throw new Error("[Indexer] INDEXER_GETLOGS_RANGE must be an integer between 100 and 100000");
  }
  return value;
}

/**
 * True when an RPC answer means "slow down" (per-second limits, Infura's
 * HTTP 429) rather than "this request is wrong" — the runner then waits and
 * repeats the same request instead of narrowing its range. Alchemy's monthly
 * cap also answers 429; with a backup URL that request goes to the backup.
 */
export function isRateLimited(status: number | undefined, code: unknown, message: string): boolean {
  // Range refusals first: JSON-RPC code -32005 ("limit exceeded") is used for both.
  if (/block range|range \d+ exceeds|exceeds limit of|limited to .* block|more than \d+ results/i.test(message)) return false;
  if (status === 429 || code === 429) return true;
  return /rate limit|too many requests|request rate exceeded|capacity limit/i.test(message);
}

/** Waits before repeating a rate-limited request (~31 s in all), then the cycle fails as before. */
export const RATE_LIMIT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/** The next, smaller factory-scan range after a refusal (half, at least 10 blocks); null below 10. */
export function nextScanRange(size: bigint): bigint | null {
  if (size <= 10n) return null;
  const half = size / 2n;
  return half < 10n ? 10n : half;
}

/** [from, to] split into inclusive ranges of at most `size` blocks; empty when from > to. */
export function logRanges(from: bigint, to: bigint, size: bigint = FACTORY_SCAN_RANGE): [bigint, bigint][] {
  const out: [bigint, bigint][] = [];
  for (let a = from; a <= to; a += size) out.push([a, a + size - 1n < to ? a + size - 1n : to]);
  return out;
}

/** The campaign address of a CampaignCreated log (first indexed argument, topic 1), lower-case. */
export function campaignFromCreatedLog(log: { topics: string[] }): string {
  const topic = log.topics[1];
  if (!topic || !/^0x[0-9a-fA-F]{64}$/.test(topic)) throw new Error("CampaignCreated log without a campaign topic");
  return `0x${topic.slice(26)}`.toLowerCase();
}
