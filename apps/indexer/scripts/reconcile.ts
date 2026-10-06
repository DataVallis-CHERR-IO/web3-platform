/**
 * pnpm --filter indexer reconcile
 * Compares the indexed rows with the contract views and exits 1 on any mismatch.
 * Env: APP_ENV, PONDER_RPC_URL_<chainId> (+ optional PONDER_RPC_FALLBACK_URL_<chainId>), DATABASE_URL_DIRECT,
 *      RECONCILE_SCHEMA (default "chain", the stable views of ADR-026).
 */
import postgres from "postgres";
import { createPublicClient, fallback, http } from "viem";
import { resolveIndexerEnv, rpcUrlsInOrder } from "../lib/env";
import { reconcile } from "../lib/reconcile";
import { exitWithError, installFatalHandlers, installRedaction } from "../lib/redact";

// First: nothing this script prints may contain the RPC key (viem errors carry the URL).
installRedaction();
installFatalHandlers();

async function main() {
  const env = resolveIndexerEnv();
  const schema = process.env.RECONCILE_SCHEMA ?? "chain";
  const sql = postgres(env.databaseUrl, { max: 1 });
  const client = createPublicClient({
    transport: fallback(rpcUrlsInOrder(env).map((url) => http(url, { batch: true })), { rank: false }),
  });

  try {
    const result = await reconcile({
      sql,
      schema,
      client,
      factory: env.campaignFactory.address,
      pool: env.emergencyPool.address,
    });
    for (const m of result.mismatches) {
      console.log(
        `MISMATCH ${m.table} ${m.key} ${m.field}: indexed=${m.indexed} onchain=${m.onchain}`
      );
    }
    console.log(
      `reconcile: schema=${schema} block=${result.block} checked=${result.checked} mismatches: ${result.mismatches.length}`
    );
    process.exitCode = result.mismatches.length === 0 ? 0 : 1;
  } finally {
    await sql.end();
  }
}

main().catch(exitWithError);
