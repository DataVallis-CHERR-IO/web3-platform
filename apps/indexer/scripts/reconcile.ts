/**
 * pnpm --filter indexer reconcile
 * Compares the indexed rows with the contract views and exits 1 on any mismatch.
 * Env: APP_ENV, PONDER_RPC_URL_<chainId> (+ optional PONDER_RPC_FALLBACK_URL_<chainId>), DATABASE_URL_DIRECT,
 *      RECONCILE_SCHEMA (default "chain", the stable views of ADR-026).
 */
import postgres from "postgres";
import { createPublicClient, fallback, http } from "viem";
import { resolveIndexerEnv, rpcUrlsInOrder } from "../lib/env";
import { MULTICALL_BATCH_BYTES, MULTICALL_READ_CONCURRENCY, reconcile } from "../lib/reconcile";
import { exitWithError, installFatalHandlers, installRedaction } from "../lib/redact";

// First: nothing this script prints may contain the RPC key (viem errors carry the URL).
installRedaction();
installFatalHandlers();

async function main() {
  const env = resolveIndexerEnv();
  const schema = process.env.RECONCILE_SCHEMA ?? "chain";
  const sql = postgres(env.databaseUrl, { max: 1 });
  // No JSON-RPC batches: a batch answer is matched to its requests by viem, and
  // a provider that rate-limits single items of a batch (Infura's free tier,
  // the dev backup) makes that matching unreliable. Reads are instead packed
  // into multicalls — one eth_call runs hundreds of view calls on the node —
  // so the request count no longer grows with the number of campaigns (dev
  // 2026-10-06: ~1,500 eth_calls per reconcile, most of an hour's Infura use).
  // Deployless: Multicall3 is sent as code with the call, nothing must be
  // deployed on the chain (Anvil included).
  let requests = 0;
  let repeated = 0;
  const reasons = new Set<string>();
  const client = createPublicClient({
    batch: { multicall: { deployless: true, batchSize: MULTICALL_BATCH_BYTES } },
    transport: fallback(
      rpcUrlsInOrder(env).map((url) => http(url, { onFetchRequest: () => void requests++ })),
      { rank: false }
    ),
  });

  try {
    const result = await reconcile({
      sql,
      schema,
      client,
      factory: env.campaignFactory.address,
      pool: env.emergencyPool.address,
      concurrency: MULTICALL_READ_CONCURRENCY,
      retry: {
        // One bad multicall answer repeats every read it carried (~100): log
        // each reason once, count the rest.
        onRetry: (error, ms) => {
          repeated++;
          const reason = (error as { shortMessage?: string }).shortMessage ?? String(error);
          if (reasons.has(reason)) return;
          reasons.add(reason);
          console.log(`reconcile: read repeated in ${ms / 1000} s (${reason})`);
        },
      },
    });
    for (const m of result.mismatches) {
      console.log(
        `MISMATCH ${m.table} ${m.key} ${m.field}: indexed=${m.indexed} onchain=${m.onchain}`
      );
    }
    console.log(
      `reconcile: schema=${schema} block=${result.block} checked=${result.checked} rpc_requests=${requests} repeated_reads=${repeated} mismatches: ${result.mismatches.length}`
    );
    process.exitCode = result.mismatches.length === 0 ? 0 : 1;
  } finally {
    await sql.end();
  }
}

main().catch(exitWithError);
