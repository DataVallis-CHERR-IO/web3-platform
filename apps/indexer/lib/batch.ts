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

/** Blocks per eth_getLogs when the runner scans the factory (Alchemy: any range up to 10,000 logs). */
export const FACTORY_SCAN_RANGE = 50_000n;

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
